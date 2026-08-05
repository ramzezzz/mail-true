#!/usr/bin/perl
#
# Служебный доступ к очереди Postfix для админки.
#
# ЗАЧЕМ ОН ВООБЩЕ НУЖЕН.
# Очередь Postfix — это каталоги в /var/spool/postfix, которые читают и
# правят только собственные программы Postfix (postqueue, postsuper,
# postcat). Сервер приложения живёт в отдельном контейнере: ни этих
# программ, ни доступа к сокету Docker у него нет и быть не должно —
# сокет Docker означает права root на всей машине, за такой ценой очередь
# показывать нельзя.
#
# Поэтому маленький посредник живёт ЗДЕСЬ, рядом с очередью, и умеет ровно
# четыре вещи: показать очередь, показать одно письмо, протолкнуть его
# сейчас, удалить. Больше он не умеет ничего — это не «выполнить команду»,
# список действий закрытый.
#
# ПОЧЕМУ PERL. Он уже есть в образе (его тянет swaks, которым проверяется
# доставка). Ставить ради посредника python или node — это лишние десятки
# мегабайт в образе почтового сервера и лишний способ что-нибудь запустить
# внутри контейнера.
#
# ЗАЩИТА.
#   * Слушаем только внутреннюю сеть стека, порт наружу не публикуется.
#   * Каждый запрос обязан принести общий секрет (заголовок X-Agent-Token),
#     сверка идёт за постоянное время.
#   * Идентификатор письма проверяется по белому списку символов ДО того,
#     как попадёт в аргументы, и командной оболочки в цепочке нет вовсе:
#     программа запускается списком аргументов (open '-|', @argv).
#   * У каждой команды есть предел времени и предел объёма ответа.
#
# Запуск: queue-agent.pl (порт и секрет — из окружения), см. entrypoint.sh.

use strict;
use warnings;
use IO::Socket::INET;
use POSIX qw(strftime);
use Encode ();

# Всюду «//», а не «||»: в Perl ноль и пустая строка ложны, и заданное
# явно QUEUE_AGENT_LOG_MAX_MB=0 молча превращалось бы в значение по
# умолчанию. Поймано при проверке проворота на стенде: порог 0 не
# срабатывал вовсе, и понять почему по поведению было нельзя.
my $PORT    = $ENV{QUEUE_AGENT_PORT};
$PORT = 11345 unless defined $PORT && $PORT ne '';
my $TOKEN   = $ENV{QUEUE_AGENT_TOKEN}   // '';
my $MAILLOG = $ENV{QUEUE_AGENT_MAILLOG} // '/var/log/mail/postfix.log';
# Предел журнала, после которого он проворачивается (МиБ). Своей ротации у
# Postfix нет: без этого файл рос бы без конца и однажды занял бы весь диск,
# а место на диске почтовому серверу нужно для писем.
my $LOG_MAX_MB = $ENV{QUEUE_AGENT_LOG_MAX_MB} // 64;
# Сколько провёрнутых кусков хранить.
my $LOG_KEEP = $ENV{QUEUE_AGENT_LOG_KEEP} // 2;

# Ответ письмом целиком ограничен: письмо бывает и в 25 МБ, а на экране
# администратора нужен разбор заголовков и начало тела, не весь файл.
my $MAX_MESSAGE_BYTES = 256 * 1024;
my $CMD_TIMEOUT       = 20;

if ($TOKEN eq '') {
    warn "queue-agent: не задан QUEUE_AGENT_TOKEN — посредник не запускается\n";
    exit 0;
}

$SIG{PIPE} = 'IGNORE';
# Дети не нужны: команды запускаются синхронно и дожидаются сами
$SIG{CHLD} = 'DEFAULT';

my $server = IO::Socket::INET->new(
    LocalAddr => '0.0.0.0',
    LocalPort => $PORT,
    Proto     => 'tcp',
    Listen    => 16,
    ReuseAddr => 1,
) or die "queue-agent: не удалось занять порт $PORT: $!\n";

log_line("посредник очереди слушает $PORT");

# Проворачивание журнала — раз в минуту между запросами.
my $next_rotate_check = time + 60;

while (1) {
    my $client = accept_with_timeout($server, 30);
    rotate_maillog() if time >= $next_rotate_check;
    next unless $client;
    eval {
        local $SIG{ALRM} = sub { die "timeout\n" };
        alarm 30;
        handle($client);
        alarm 0;
        1;
    } or do {
        alarm 0;
        my $err = $@ || 'неизвестная ошибка';
        chomp $err;
        log_line("запрос не обработан: $err");
    };
    close $client;
}

# ------------------------------------------------------------------
# Приём соединения с ожиданием: нужен, чтобы проворачивание журнала
# случалось и тогда, когда админку никто не открывает.
# ------------------------------------------------------------------
sub accept_with_timeout {
    my ($srv, $seconds) = @_;
    my $bits = '';
    vec($bits, fileno($srv), 1) = 1;
    my $ready = select($bits, undef, undef, $seconds);
    return undef unless $ready && $ready > 0;
    return $srv->accept();
}

sub log_line {
    my ($text) = @_;
    my $stamp = strftime('%Y-%m-%dT%H:%M:%S', localtime);
    print STDERR "$stamp queue-agent: $text\n";
}

# ------------------------------------------------------------------
# Разбор запроса и ответ
# ------------------------------------------------------------------
sub handle {
    my ($client) = @_;
    $client->autoflush(1);

    my $request = <$client>;
    return unless defined $request;
    $request =~ s/\r?\n\z//;
    my ($method, $target) = split /\s+/, $request;
    $method ||= '';
    $target ||= '';

    my %headers;
    my $length = 0;
    while (my $line = <$client>) {
        $line =~ s/\r?\n\z//;
        last if $line eq '';
        if ($line =~ /^([^:]+):\s*(.*)$/) {
            my ($name, $value) = (lc $1, $2);
            $headers{$name} = $value;
            $length = $value + 0 if $name eq 'content-length';
        }
    }
    if ($length > 0) {
        my $body = '';
        read($client, $body, $length);
    }

    my ($path, $query) = split /\?/, $target, 2;
    my %params = parse_query($query);

    # Секрет спрашиваем раньше разбора пути: неизвестный путь не должен
    # отличаться по ответу от известного для того, кто секрета не знает.
    unless (token_ok($headers{'x-agent-token'})) {
        return reply($client, 401, { error => 'нет доступа' });
    }

    if ($method eq 'GET' && $path eq '/healthz') {
        return reply($client, 200, { ok => \1 });
    }
    if ($method eq 'GET' && $path eq '/queue') {
        return queue_list($client);
    }
    if ($method eq 'GET' && $path eq '/message') {
        return message_body($client, $params{id});
    }
    if ($method eq 'POST' && $path eq '/flush') {
        return act($client, $params{id}, 'flush');
    }
    if ($method eq 'POST' && $path eq '/delete') {
        return act($client, $params{id}, 'delete');
    }
    return reply($client, 404, { error => 'неизвестный запрос' });
}

sub parse_query {
    my ($query) = @_;
    my %out;
    return %out unless defined $query;
    for my $pair (split /&/, $query) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k;
        $v = '' unless defined $v;
        $v =~ tr/+/ /;
        $v =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        $out{$k} = $v;
    }
    return %out;
}

# Сверка секрета за постоянное время: сравнение по первому несовпавшему
# байту подсказывало бы длину общего начала.
sub token_ok {
    my ($given) = @_;
    return 0 unless defined $given;
    return 0 unless length($given) == length($TOKEN);
    my $diff = 0;
    for my $i (0 .. length($TOKEN) - 1) {
        $diff |= ord(substr($given, $i, 1)) ^ ord(substr($TOKEN, $i, 1));
    }
    return $diff == 0;
}

# Идентификатор письма в очереди: только буквы и цифры. Длинные
# идентификаторы Postfix (enable_long_queue_ids) — это основание 52,
# короткие — шестнадцатеричные. Всё прочее до аргументов не доходит.
sub valid_queue_id {
    my ($id) = @_;
    return defined($id) && $id =~ /\A[A-Za-z0-9]{5,32}\z/;
}

sub reply {
    my ($client, $code, $data) = @_;
    my $body = ref $data ? to_json($data) : $data;
    my $text = $code == 200 ? 'OK' : $code == 401 ? 'Unauthorized' : $code == 400 ? 'Bad Request' : $code == 404 ? 'Not Found' : 'Error';
    print $client "HTTP/1.1 $code $text\r\n";
    print $client "Content-Type: application/json; charset=utf-8\r\n";
    print $client 'Content-Length: ' . length($body) . "\r\n";
    print $client "Connection: close\r\n\r\n";
    print $client $body;
}

# ------------------------------------------------------------------
# Действия
# ------------------------------------------------------------------

# Очередь целиком. postqueue -j отдаёт по объекту JSON на строку — отдаём
# как есть, разбирает вызывающая сторона: чем меньше здесь логики, тем
# меньше поводов лезть в этот файл.
sub queue_list {
    my ($client) = @_;
    my ($rc, $out, $err) = run('/usr/sbin/postqueue', '-j');
    if ($rc != 0) {
        return reply($client, 500, { error => "postqueue: $err" });
    }
    return reply($client, 200, { ok => \1, lines => [ grep { /\S/ } split /\n/, $out ] });
}

sub message_body {
    my ($client, $id) = @_;
    return reply($client, 400, { error => 'некорректный идентификатор' })
        unless valid_queue_id($id);
    my ($rc, $out, $err) = run('/usr/sbin/postcat', '-q', $id);
    if ($rc != 0) {
        return reply($client, 404, { error => $err || 'письма нет в очереди' });
    }
    my $truncated = 0;
    if (length($out) > $MAX_MESSAGE_BYTES) {
        $out = substr($out, 0, $MAX_MESSAGE_BYTES);
        $truncated = 1;
    }
    # Письмо — произвольные байты: вложение в двоичном виде, заголовки в
    # cp1251, обрывок многобайтового символа на месте обрезки. Негодная
    # последовательность сделала бы негодным ВЕСЬ ответ, поэтому меняем её
    # на символ замены здесь, а не надеемся на разбирающую сторону.
    $out = Encode::encode('UTF-8', Encode::decode('UTF-8', $out, Encode::FB_DEFAULT));
    return reply($client, 200, { ok => \1, text => $out, truncated => $truncated ? \1 : \0 });
}

sub act {
    my ($client, $id, $what) = @_;
    return reply($client, 400, { error => 'некорректный идентификатор' })
        unless valid_queue_id($id);
    my @argv = $what eq 'flush'
        ? ('/usr/sbin/postqueue', '-i', $id)
        : ('/usr/sbin/postsuper', '-d', $id);
    my ($rc, $out, $err) = run(@argv);
    if ($rc != 0) {
        return reply($client, 500, { error => $err || "код возврата $rc" });
    }
    log_line("$what $id");
    return reply($client, 200, { ok => \1, output => $out . $err });
}

# ------------------------------------------------------------------
# Запуск программы: списком аргументов, без командной оболочки,
# с пределом времени.
# ------------------------------------------------------------------
sub run {
    my (@argv) = @_;
    my $errfile = "/tmp/queue-agent.$$.err";
    my ($out, $err, $rc) = ('', '', -1);
    my $pid;
    eval {
        local $SIG{ALRM} = sub { kill 'KILL', $pid if $pid; die "превышено время ожидания\n" };
        alarm $CMD_TIMEOUT;
        # Ошибки уводим в файл: смешивать их с выводом нельзя, разбирающая
        # сторона ждёт чистый JSON.
        $pid = open(my $fh, '-|');
        die "не удалось породить процесс: $!\n" unless defined $pid;
        if ($pid == 0) {
            open(STDERR, '>', $errfile);
            exec { $argv[0] } @argv;
            exit 127;
        }
        local $/;
        $out = <$fh> // '';
        close $fh;
        $rc = $? >> 8;
        alarm 0;
        1;
    } or do {
        alarm 0;
        $err = $@ || 'неизвестная ошибка';
        chomp $err;
    };
    if (-e $errfile) {
        if (open(my $eh, '<', $errfile)) {
            local $/;
            my $text = <$eh> // '';
            close $eh;
            $err = $err ? "$err; $text" : $text;
        }
        unlink $errfile;
    }
    $err =~ s/\s+\z// if defined $err;
    return ($rc, $out, $err // '');
}

# ------------------------------------------------------------------
# Проворачивание журнала Postfix.
#
# maillog_file указывает на файл в общем томе (его читает админка), а сам
# Postfix журнал не проворачивает. Делаем это его же средством: `postfix
# logrotate` переименовывает файл и заставляет postlogd открыть новый —
# именно поэтому нельзя просто переименовать файл самому, писать
# продолжали бы в переименованный.
# ------------------------------------------------------------------
# Новый файл журнала должен быть читаем всем и писан postfix'ом.
# Владелец важен не меньше прав: каталог общий и с битом t, и открыть
# чужой файл на дозапись там не даст сама система (fs.protected_regular).
sub fix_maillog_permissions {
    unless (-e $MAILLOG) {
        open(my $fh, '>>', $MAILLOG) or return;
        close $fh;
    }
    my $uid = getpwnam('postfix');
    chown($uid, -1, $MAILLOG) if defined $uid;
    chmod(0644, $MAILLOG);
}

sub rotate_maillog {
    $next_rotate_check = time + 60;
    return unless -f $MAILLOG;
    my $size = (stat $MAILLOG)[7] // 0;
    return if $size < $LOG_MAX_MB * 1024 * 1024;
    my ($rc, undef, $err) = run('/usr/sbin/postfix', 'logrotate');
    if ($rc != 0) {
        log_line("не удалось провернуть журнал: $err");
        return;
    }
    log_line("журнал провёрнут на $size байт");

    # Права нового файла — обязательная часть проворота, а не украшение.
    #
    # `postfix logrotate` заводит новый файл сам, от root и с маской 077,
    # то есть -rw------- root:root. Читает журнал сервер приложения (uid
    # 5000) из общего тома — и после первого же проворота он получал бы
    # «нет доступа», а раздел «Журналы» переставал бы показывать почту.
    # Проверено на стенде: ровно так и вышло.
    fix_maillog_permissions();
    # Лишние куски убираем сами: их накопление съедает диск так же, как
    # и один растущий файл.
    my ($dir, $base) = $MAILLOG =~ m{\A(.*)/([^/]+)\z};
    return unless defined $dir;
    opendir(my $dh, $dir) or return;
    my @old = sort { (stat "$dir/$b")[9] <=> (stat "$dir/$a")[9] }
              grep { /\A\Q$base\E\./ } readdir($dh);
    closedir $dh;
    for my $extra (@old[$LOG_KEEP .. $#old]) {
        next unless defined $extra;
        unlink "$dir/$extra";
    }
}

# ------------------------------------------------------------------
# Простейшая сборка JSON: в образе нет JSON::PP-совместимой зависимости,
# на которую можно рассчитывать, а формат здесь примитивный.
# ------------------------------------------------------------------
sub to_json {
    my ($value) = @_;
    my $ref = ref $value;
    if ($ref eq 'HASH') {
        return '{' . join(',', map { json_string($_) . ':' . to_json($value->{$_}) }
                                sort keys %$value) . '}';
    }
    if ($ref eq 'ARRAY') {
        return '[' . join(',', map { to_json($_) } @$value) . ']';
    }
    if ($ref eq 'SCALAR') {
        return $$value ? 'true' : 'false';
    }
    return 'null' unless defined $value;
    # Числами наружу ничего не отдаём намеренно: строка «0123» и строка,
    # случайно состоящая из цифр, должны доехать строкой, а не превратиться
    # в число на той стороне.
    return json_string($value);
}

sub json_string {
    my ($text) = @_;
    $text = '' unless defined $text;
    $text =~ s/\\/\\\\/g;
    $text =~ s/"/\\"/g;
    $text =~ s/\n/\\n/g;
    $text =~ s/\r/\\r/g;
    $text =~ s/\t/\\t/g;
    # Управляющие символы (в письме встречаются) — экранируем по \u00XX,
    # иначе получится негодный JSON.
    $text =~ s/([\x00-\x08\x0b\x0c\x0e-\x1f])/sprintf('\\u%04x', ord($1))/ge;
    return '"' . $text . '"';
}
