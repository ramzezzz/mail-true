#!/usr/bin/perl
#
# Посредник для перезапуска служб почтового стека.
#
# ==================================================================
# ПОЧЕМУ У ЭТОЙ СЛУЖБЫ ЕСТЬ СОКЕТ DOCKER И ПОЧЕМУ ЭТО НЕ СТРАШНО
# ==================================================================
# Сокет Docker — это ПРАВА ROOT НА ВСЕЙ МАШИНЕ. Кто может сказать демону
# «запусти контейнер», тот может запустить его с примонтированным корнем
# хоста и правами суперпользователя, то есть сделать на сервере что
# угодно. Никакой промежуточной ступени тут нет.
#
# Поэтому во всём продукте сокет Docker не выдан НИКОМУ, кроме двух служб:
# установщика (он и есть «создать стек», и живёт только во время установки)
# и этого посредника. Сервер приложения, который принимает запросы из
# интернета и разбирает чужие письма, сокета не имеет и иметь не будет —
# именно поэтому очередь Postfix, журналы служб и вот теперь перезапуск
# сделаны через посредников, а не напрямую.
#
# Цена, которую платит эта служба за сокет, — она умеет ровно ДВЕ вещи и
# только над ЗАКРЫТЫМ СПИСКОМ служб:
#
#   restart  — перезапустить процесс в существующем контейнере;
#   recreate — пересоздать контейнер (это нужно, когда служба читает
#              настройку из окружения: окружение задаётся при СОЗДАНИИ
#              контейнера, и перезапуск процесса его не меняет).
#
# Чего здесь нет и не появится:
#   * выполнения произвольной команды — ни «docker exec», ни «sh -c»;
#   * приёма имени контейнера снаружи: имя службы, пришедшее по сети,
#     ищется в списке %SERVICES ниже, и не найденное отвергается ДО того,
#     как что-либо запустится. В аргументы уходит не строка запроса, а
#     значение из этого файла;
#   * сборки образов — у compose всегда стоит --no-build. Сборка читает
#     Dockerfile из каталога проекта и выполняет написанное в нём, то есть
#     была бы обходным путём к «выполнить что угодно»;
#   * записи куда-либо, кроме одного файла infra/.env, и в нём — кроме
#     ключей из списка %ENV_KEYS, своего у каждой службы.
#
# ЧТО ПОСРЕДНИК ВИДИТ. Два файла на чтение (infra/docker-compose.yml и
# install/compose.prod.yml) и один на запись (infra/.env). Каталог проекта
# целиком ему не примонтирован намеренно: читать чужие ключи, письма и
# сертификаты ему незачем.
#
# ЗАЩИТА (та же, что у посредника очереди, infra/postfix/queue-agent.pl):
#   * слушаем только внутреннюю сеть стека, порт наружу не публикуется;
#   * каждый запрос обязан принести общий секрет (X-Agent-Token), сверка
#     идёт за постоянное время;
#   * нет секрета в окружении — посредник не слушает вовсе;
#   * у каждой команды есть предел времени;
#   * программы запускаются списком аргументов (exec { } @argv), командной
#     оболочки в цепочке нет ни в одном месте.
#
# ПОЧЕМУ PERL. Тот же ответ, что и у посредника очереди: чем меньше в
# контейнере с сокетом Docker способов что-нибудь запустить, тем лучше.
# Perl ставится одним пакетом поверх docker:cli и не тянет ни менеджера
# пакетов приложений, ни компилятора.

use strict;
use warnings;
use IO::Socket::INET;
use POSIX qw(strftime);

my $PORT = $ENV{SERVICE_AGENT_PORT};
$PORT = 11346 unless defined $PORT && $PORT ne '';
my $TOKEN   = $ENV{SERVICE_AGENT_TOKEN} // '';
my $PROJECT = $ENV{COMPOSE_PROJECT_NAME};
$PROJECT = 'mailtrue' unless defined $PROJECT && $PROJECT ne '';

# Пути ВНУТРИ контейнера посредника. Это точки монтирования из
# docker-compose.yml, а не настройка: менять их поодиночке нельзя.
my $COMPOSE_MAIN = '/repo/infra/docker-compose.yml';
my $COMPOSE_PROD = '/repo/install/compose.prod.yml';
my $ENV_FILE     = '/env/.env';
# Якорь пути. Зачем он нужен — подробно ниже, у discover().
my $DIR_ANCHOR   = '/repo/infra/service-agent';

# Предел времени на одну команду. Пересоздание контейнера с ожиданием
# готовности — самая долгая из них.
my $CMD_TIMEOUT = 120;
# Сколько ждать, пока служба объявит себя здоровой после подъёма.
my $WAIT_SECONDS = 90;

# ==================================================================
# ЗАКРЫТЫЙ СПИСОК СЛУЖБ
# ==================================================================
# Ключ — имя сервиса в docker-compose.yml. Значение — разрешённые
# действия. Тот же список продублирован на стороне сервера приложения
# (apps/api/src/admin/restart-targets.ts): там он даёт человеку внятный
# отказ, здесь — последний рубеж, потому что именно здесь запускаются
# программы.
#
# Ни postgres, ни redis здесь нет: их перезапуск роняет продукт целиком и
# ни одной настройкой из панели не вызывается. Самого посредника здесь
# тоже нет — перезапустить себя через себя нельзя, ответ уже некому
# отправить.
my %SERVICES = (
    api        => { restart => 1, recreate => 1 },
    postfix    => { restart => 1, recreate => 1 },
    dovecot    => { restart => 1, recreate => 1 },
    nginx      => { restart => 1, recreate => 1 },
    rspamd     => { restart => 1, recreate => 1 },
    unbound    => { restart => 1, recreate => 1 },
    autoconfig => { restart => 1, recreate => 1 },
    # Защита от подбора паролей. Перезапуск разрешён: пороги и белый
    # список правятся в infra/.env и подхватываются только при старте.
    # Пересоздание — тоже: этим меняется набор смонтированных журналов.
    #
    # Служба живёт в сети хоста и умеет менять пакетный фильтр, поэтому
    # соблазн не пускать сюда посредника понятен. Он ошибочен: команда
    # ограничена перезапуском ИМЕНОВАННОЙ службы из этого списка, а без
    # него единственный способ применить новый порог — идти в консоль по
    # ssh. В итоге пороги не правил бы никто, и защита осталась бы с
    # умолчаниями навсегда. Отдельно: без записи в этот список панель не
    # видела бы и состояния службы — раздел «Наблюдение» берёт перечень
    # отсюда, а не из ответа Docker.
    fail2ban   => { restart => 1, recreate => 1 },
);

# ==================================================================
# ЗАКРЫТЫЙ СПИСОК КЛЮЧЕЙ infra/.env — СВОЙ У КАЖДОЙ СЛУЖБЫ
# ==================================================================
# Пересоздание контейнера имеет смысл только с новым окружением, а
# окружение compose берёт из infra/.env. Значит посреднику приходится
# писать в этот файл — и это самое опасное, что он делает: в том же файле
# лежат пароль базы, секреты сессий и ключи шифрования.
#
# Поэтому ключ, который разрешено записать, определяется не запросом, а
# этой таблицей, и разрешён он только вместе с ОДНОЙ службой. Попытка
# записать POSTGRES_PASSWORD «через autoconfig» не отличается для
# посредника от опечатки: такого ключа в его списке нет.
my %ENV_KEYS = (
    # Пароль управляющего интерфейса антиспама здесь только ради
    # ПЕРЕВЫПУСКА: значение генерирует сервер приложения, в панель оно не
    # возвращается. Пересоздаются обе стороны — rspamd и api.
    rspamd     => { CLAMAV_ENABLED => 1, RSPAMD_PASSWORD => 1 },
    # BIND_ADDRESS публикует порты: его читает compose при создании
    # контейнера, и правится он вместе с пересозданием.
    #
    # ВНИМАНИЕ. Ниже в этом же хэше когда-то стояли вторые записи
    # «postfix => {}» и «nginx => {}». В Perl побеждает последняя, и обе
    # эти строки молча отменяли разрешения выше: BIND_ADDRESS для postfix
    # и nginx не записывался вовсе, а настройка в панели сохранялась и
    # делала вид, что применена. Держите по ОДНОЙ записи на службу.
    postfix    => {
        BIND_ADDRESS      => 1,
        # Общий секрет с посредником очереди, живущим внутри этого же
        # контейнера. Тоже только для перевыпуска.
        QUEUE_AGENT_TOKEN => 1,
    },
    nginx      => { BIND_ADDRESS => 1 },
    unbound    => { UNBOUND_LOG_QUERIES => 1, UNBOUND_DNSSEC => 1 },
    dovecot    => { DOVECOT_DISABLE_PLAINTEXT_AUTH => 1, BIND_ADDRESS => 1 },
    # Пороги защиты от подбора. Их правят не от хорошей жизни, а по ходу
    # разбора: «нас заваливают, ужесточить» или «свой филиал забанился,
    # ослабить и внести в белый список». Оба случая — срочные, и ходить
    # ради них в консоль по ssh значит не править их никогда.
    #
    # Белый список тут же: ошибиться в нём опаснее всего (забанить свою
    # же контору), а исправлять эту ошибку придётся с адреса, который,
    # возможно, уже забанен. Пусть исправляется из панели.
    fail2ban   => {
        FAIL2BAN_ENABLED           => 1,
        FAIL2BAN_IGNORE_IPS        => 1,
        FAIL2BAN_BANTIME           => 1,
        FAIL2BAN_FINDTIME          => 1,
        FAIL2BAN_BANTIME_INCREMENT => 1,
        FAIL2BAN_BANTIME_MAX       => 1,
        FAIL2BAN_DOVECOT_MAXRETRY  => 1,
        FAIL2BAN_POSTFIX_MAXRETRY  => 1,
        FAIL2BAN_API_MAXRETRY      => 1,
        FAIL2BAN_RECIDIVE_ENABLED  => 1,
        FAIL2BAN_RECIDIVE_BANTIME  => 1,
        FAIL2BAN_RECIDIVE_MAXRETRY => 1,
        FAIL2BAN_LOGLEVEL          => 1,
    },
    autoconfig => {
        PROVIDER_NAME                  => 1,
        PROVIDER_SHORT_NAME            => 1,
        AUTOCONFIG_LOG_LEVEL           => 1,
        DMARC_RUA                      => 1,
        DNS_TTL                        => 1,
        AUTOCONFIG_IMAPS_PORT          => 1,
        AUTOCONFIG_IMAP_STARTTLS_PORT  => 1,
        AUTOCONFIG_POP3S_PORT          => 1,
        AUTOCONFIG_POP3_STARTTLS_PORT  => 1,
        AUTOCONFIG_SUBMISSION_PORT     => 1,
        AUTOCONFIG_SUBMISSIONS_PORT    => 1,
    },
    # Сервер приложения подсказывает те же порты в SRV-записях раздела
    # «Домены», а compose перекладывает их ему под ДРУГИМИ именами
    # (AUTOCONFIG_IMAPS_PORT -> IMAPS_PORT). Из базы он их поэтому не
    # получит — нужно новое окружение, то есть пересоздание.
    #
    # PROVIDER_NAME здесь НЕТ намеренно, и это не забывчивость: его сервер
    # приложения читает под тем же именем, а значит берёт из базы при
    # старте (applyStoredEnv), и ему хватает перезапуска. Оставить ключ
    # здесь значило бы дать службе с сокетом Docker право писать в .env
    # то, ради чего в .env писать не нужно. Совпадение этого списка с
    # перечнем настроек проверяется в обе стороны (server-settings.test.ts).
    api => {
        # Потолок кучи V8: читается процессом Node при запуске, до того как
        # появится код, способный сходить в базу, — значит только окружение.
        API_NODE_OPTIONS           => 1,
        AUTOCONFIG_IMAPS_PORT      => 1,
        AUTOCONFIG_SUBMISSION_PORT => 1,
        AUTOCONFIG_POP3S_PORT      => 1,
        # Страна входа. База стран читается один раз при запуске процесса
        # (десяток мегабайт текста), поэтому и политика берётся оттуда же —
        # из окружения, а не из базы настроек.
        GEOIP_LOGIN_POLICY         => 1,
        GEOIP_ALLOWED_COUNTRIES    => 1,
        # Секреты сессий — только для ПЕРЕВЫПУСКА.
        #
        # Выглядит как расширение прав в опасную сторону, но новых
        # возможностей не даёт: посредник и так пишет в этот файл, а
        # прочитать его он не может ни при каком запросе — операция
        # записи не возвращает содержимого. Значение сюда приходит
        # сгенерированным на стороне сервера приложения; ни браузер, ни
        # журнал аудита его не видят.
        #
        # Взамен исчезает единственный способ сменить скомпрометированный
        # секрет сессий — поход по ssh с правкой файла руками. Секрет,
        # смена которого требует ssh, не меняют никогда.
        # ADMIN_SESSION_SECRET здесь НЕТ намеренно. Он выглядит парой к
        # предыдущему, но подписью сессий не является: cookie панели
        # подписана тем же SESSION_SECRET, а этим ключом ЗАШИФРОВАНЫ
        # пароли импорта, пароли заданий переноса и приватный ключ DKIM.
        # Право переписать его означало бы право обнулить эти данные.
        SESSION_SECRET             => 1,
    },
);

if ($TOKEN eq '') {
    log_line(
        'не задан SERVICE_AGENT_TOKEN — посредник не запускается. '
      . 'Перезапуск служб из панели работать не будет; панель скажет об этом словами.'
    );
    # НЕ выходим: выход из главного процесса контейнера с restart:
    # unless-stopped означал бы вечный круг «поднялся — упал». Молча спим:
    # порт закрыт, сервер приложения видит отказ соединения и объясняет
    # причину человеку.
    sleep 3600 while 1;
}

$SIG{PIPE} = 'IGNORE';
$SIG{CHLD} = 'DEFAULT';

# ==================================================================
# ГДЕ ЛЕЖИТ ПРОЕКТ ГЛАЗАМИ ДЕМОНА
# ==================================================================
# Тонкость, без которой пересоздание молча ломает тома.
#
# Compose разрешает относительные пути монтирования (`./rspamd/local.d`)
# относительно каталога проекта и отдаёт демону уже АБСОЛЮТНЫЙ путь. Путь
# этот обязан быть путём ХОСТА: демон монтирует со своей стороны сокета,
# а не с нашей. Внутри контейнера каталог проекта виден как /repo/infra —
# пересоздай мы службу так, демон получил бы `/repo/infra/rspamd/local.d`,
# каталога с таким именем у него нет, и он создал бы ПУСТОЙ. Rspamd
# поднялся бы без единого правила и молча пропускал бы весь спам.
#
# Спрашиваем путь у самого демона: находим свой контейнер по меткам
# compose и смотрим, откуда к нам примонтирован каталог. Тем же способом
# это делает установщик (apps/installer/src/repo.ts).
#
# ------------------------------------------------------------------
# ПОЧЕМУ СПРАШИВАЕМ ПРО КАТАЛОГ, А НЕ ПРО ФАЙЛ COMPOSE
# ------------------------------------------------------------------
# Потому что про файл демон отвечает НЕ ТО. Проверено на стенде под
# Docker Desktop: у монтирования ФАЙЛА в поле Source стоит путь клиента
# («G:\Temp\...\infra\docker-compose.yml»), а у монтирования КАТАЛОГА —
# путь, которым каталог виден демону («/run/desktop/mnt/host/g/Temp/...»).
# Первый на той стороне сокета не существует, и пересоздание падало с
#
#   mount denied: the source path "/G:\Temp\...\infra/rspamd/local.d" ...
#
# Поэтому в контейнер примонтирован ещё и каталог-якорь: собственный
# каталог сборки посредника (infra/service-agent). Он выбран потому, что
# в нём нет ничего, кроме Dockerfile и этого файла, — то есть якорь не
# добавляет посреднику доступа ни к чему. Каталог проекта — его родитель.
my $PROJECT_DIR = '';
my $OWN_ID      = '';
my $USE_PROD    = 0;
my $STARTUP_ERROR = '';

discover();

# Откуда примонтирована точка $dest, глазами демона.
sub mount_source {
    my ($id, $dest) = @_;
    my ($rc, $out) = run(
        'docker', 'inspect', $id,
        '--format', '{{range .Mounts}}{{if eq .Destination "' . $dest . '"}}{{.Source}}{{end}}{{end}}',
    );
    return $rc == 0 ? trim($out) : '';
}

# Как Docker Desktop показывает диск Windows своему демону. Нужно только
# для стенда разработчика: на боевом Linux-сервере первый же кандидат
# (путь как есть) проходит пробу, и до этого преобразования не доходит.
sub desktop_path {
    my ($path) = @_;
    return '' unless $path =~ m{\A([A-Za-z]):[\\/](.*)\z};
    my ($drive, $rest) = (lc $1, $2);
    $rest =~ s{\\}{/}g;
    return "/run/desktop/mnt/host/$drive/$rest";
}

# Видит ли ДЕМОН этот каталог. Поднимаем на секунду контейнер из своего
# же образа (он заведомо есть на машине) и проверяем наличие файла
# compose. Никакой оболочки: entrypoint подменяется на саму программу
# проверки, аргументы уходят списком.
sub probe_dir {
    my ($candidate, $image) = @_;
    return 0 if $image eq '';
    my ($rc) = run(
        'docker', 'run', '--rm', '--network', 'none',
        '--entrypoint', 'test',
        '-v', "$candidate:/probe:ro",
        $image,
        '-f', '/probe/docker-compose.yml',
    );
    return $rc == 0;
}

sub discover {
    my ($rc, $out, $err) = run(
        'docker', 'ps', '--no-trunc',
        '--filter', "label=com.docker.compose.project=$PROJECT",
        '--filter', 'label=com.docker.compose.service=service-agent',
        '--format', '{{.ID}}',
    );
    if ($rc != 0) {
        $STARTUP_ERROR =
            'Docker не отвечает посреднику. Скорее всего, служба поднята без сокета '
          . "(/var/run/docker.sock). Ответ демона: " . trim($err);
        log_line($STARTUP_ERROR);
        return;
    }
    ($OWN_ID) = grep { /\S/ } split /\n/, $out;
    $OWN_ID = trim($OWN_ID // '');
    if ($OWN_ID eq '') {
        $STARTUP_ERROR =
            "Среди контейнеров проекта «$PROJECT» посредник не нашёл себя. Так бывает, "
          . 'если служба запущена не через docker compose или COMPOSE_PROJECT_NAME '
          . 'не совпадает с именем проекта.';
        log_line($STARTUP_ERROR);
        return;
    }

    my $source = mount_source($OWN_ID, $DIR_ANCHOR);
    $source = mount_source($OWN_ID, $COMPOSE_MAIN) if $source eq '';
    if ($source eq '') {
        $STARTUP_ERROR =
            "Каталог проекта не примонтирован в контейнер посредника ($DIR_ANCHOR). "
          . 'Без него пересоздать службу нельзя: compose нечего читать, а тома '
          . 'достались бы новому контейнеру пустыми.';
        log_line($STARTUP_ERROR);
        return;
    }
    # Каталог проекта — родитель якоря глазами демона.
    $source =~ s{[/\\][^/\\]+\z}{};

    # ------------------------------------------------------------------
    # Путь не берём на веру — ПРОВЕРЯЕМ.
    #
    # Docker отвечает о монтированиях по-разному в зависимости от того,
    # где живёт демон. На Linux-сервере путь клиента и путь демона — один
    # и тот же, и проверять нечего. Под Docker Desktop же в ответе стоит
    # путь клиента («G:\...\infra»), которого на стороне демона нет: он
    # видит тот же каталог как /run/desktop/mnt/host/g/....
    #
    # Ошибиться тут дорого и НЕЗАМЕТНО. Compose отдаёт демону абсолютные
    # пути томов, и по несуществующему пути демон молча создаёт ПУСТОЙ
    # каталог: rspamd поднялся бы без единого правила и пропускал бы весь
    # спам, ничего никому не сказав.
    #
    # Поэтому вместо угадывания — проба: поднимаем на секунду контейнер
    # из СВОЕГО же образа с этим путём и смотрим, виден ли в нём файл
    # compose. Ответ даёт сам демон, и он окончательный.
    # ------------------------------------------------------------------
    my (undef, $imageOut) = run('docker', 'inspect', $OWN_ID, '--format', '{{.Image}}');
    my $image = trim($imageOut);
    # Кандидаты. Путь ОБЯЗАН быть абсолютным по-юниксовому, и это не
    # придирка к виду строки: compose разрешает относительные пути томов
    # средствами Go, то есть по правилам той системы, где он запущен, а
    # запущен он здесь — в Linux. «G:\...\infra» он абсолютным не считает
    # и приклеивает к текущему каталогу, получая «/G:\...\infra/...» —
    # ровно с этим и падало пересоздание на стенде под Docker Desktop:
    #
    #   mount denied: the source path "/G:\Temp\...\infra/rspamd/local.d" ...
    #
    # Одна проба этот случай не ловит: сам демон Docker Desktop путь с
    # буквой диска понимает и монтирует. Поэтому сначала отбор по виду,
    # потом проба.
    my @candidates = grep { $_ ne '' && m{\A/} } ($source, desktop_path($source));
    my $verified = '';
    for my $candidate (@candidates) {
        if (probe_dir($candidate, $image)) { $verified = $candidate; last; }
        log_line("каталог проекта «$candidate» демону не виден, пробуем дальше");
    }
    if ($verified eq '') {
        $STARTUP_ERROR =
            "Каталог проекта («$source») демону не виден. Пересоздание в таком виде "
          . 'создало бы контейнер с ПУСТЫМИ томами вместо настроек, поэтому оно '
          . 'запрещено. Перезапуск процесса при этом работает.';
        log_line($STARTUP_ERROR);
        return;
    }
    $PROJECT_DIR = $verified;

    # ------------------------------------------------------------------
    # Боевое переопределение: применять или нет.
    #
    # install/compose.prod.yml заменяет публикацию портов почтовых служб
    # с 127.0.0.1 на внешний адрес. Пересоздай мы dovecot на боевом
    # сервере БЕЗ него — IMAP вернулся бы на петлю, и почта у всех
    # клиентов в интернете умерла бы молча, от нажатия кнопки «применить
    # настройку». Наугад брать его тоже нельзя: на стенде разработчика он
    # так же молча выставил бы порты наружу.
    #
    # Поэтому не гадаем, а смотрим, чем стек подняли на самом деле:
    # compose записывает список своих файлов в метку каждого контейнера.
    # ------------------------------------------------------------------
    (my $rc3, $out, undef) = run(
        'docker', 'inspect', $OWN_ID,
        '--format', '{{index .Config.Labels "com.docker.compose.project.config_files"}}',
    );
    if ($rc3 == 0) {
        for my $file (split /,/, trim($out)) {
            $USE_PROD = 1 if $file =~ m{compose\.prod\.ya?ml\s*\z};
        }
    }
    $USE_PROD = 0 unless -f $COMPOSE_PROD;

    log_line(
        "проект $PROJECT, каталог глазами демона $PROJECT_DIR"
      . ($USE_PROD ? ", боевое переопределение применяется" : "")
    );
}

my $server = IO::Socket::INET->new(
    LocalAddr => '0.0.0.0',
    LocalPort => $PORT,
    Proto     => 'tcp',
    Listen    => 16,
    ReuseAddr => 1,
) or die "service-agent: не удалось занять порт $PORT: $!\n";

log_line("посредник перезапуска слушает $PORT");

while (1) {
    my $client = $server->accept();
    next unless $client;
    eval {
        local $SIG{ALRM} = sub { die "превышено время ожидания\n" };
        # Больше предела команды: ответ обязан успеть уйти после того, как
        # команда сдалась по своему собственному пределу.
        alarm $CMD_TIMEOUT + 60;
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

# ==================================================================
# Разбор запроса
# ==================================================================
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
    # Тело читаем всегда, но с потолком: иначе один запрос с заявленной
    # длиной в гигабайт занял бы память посредника целиком.
    my $body = '';
    if ($length > 0) {
        $length = 64 * 1024 if $length > 64 * 1024;
        read($client, $body, $length);
    }

    my ($path, $query) = split /\?/, $target, 2;
    my %params = parse_query($query);

    # Секрет спрашиваем до разбора пути: неизвестный путь не должен
    # отличаться по ответу от известного для того, кто секрета не знает.
    unless (token_ok($headers{'x-agent-token'})) {
        return reply($client, 401, { error => 'нет доступа' });
    }

    if ($method eq 'GET' && $path eq '/healthz') {
        return reply($client, 200, {
            ok       => \1,
            project  => $PROJECT,
            dir      => $PROJECT_DIR,
            prod     => $USE_PROD ? \1 : \0,
            services => [ sort keys %SERVICES ],
            error    => $STARTUP_ERROR eq '' ? undef : $STARTUP_ERROR,
        });
    }
    if ($method eq 'GET' && $path eq '/status') {
        my $service = check_service($client, $params{service}, 'restart') or return;
        return reply($client, 200, { ok => \1, %{ service_state($service) } });
    }
    if ($method eq 'POST' && $path eq '/restart') {
        my $service = check_service($client, $params{service}, 'restart') or return;
        return do_restart($client, $service);
    }
    if ($method eq 'POST' && $path eq '/recreate') {
        my $service = check_service($client, $params{service}, 'recreate') or return;
        return do_recreate($client, $service, $body);
    }
    if ($method eq 'GET' && $path eq '/stack') {
        return do_stack($client);
    }
    if ($method eq 'POST' && $path eq '/certbot') {
        return do_certbot($client, $body);
    }
    if ($method eq 'POST' && $path eq '/env-unset') {
        my $service = check_service($client, $params{service}, 'recreate') or return;
        return do_env_unset($client, $service, $body);
    }
    if ($method eq 'GET' && $path eq '/dkim') {
        return do_dkim($client, $params{domain}, $params{selector});
    }
    if ($method eq 'GET' && $path eq '/audit') {
        return do_audit($client);
    }
    return reply($client, 404, { error => 'неизвестный запрос' });
}

# Имя службы из запроса ищется в списке. Наружу возвращается ЗНАЧЕНИЕ
# ключа списка, а не пришедшая строка: дальше по коду работаем только со
# своим именем, даже если они совпадают посимвольно.
sub check_service {
    my ($client, $given, $action) = @_;
    $given = '' unless defined $given;
    my ($known) = grep { $_ eq $given } sort keys %SERVICES;
    if (!defined $known) {
        reply($client, 400, {
            error => "служба «$given» не перезапускается посредником; "
                   . 'список: ' . join(', ', sort keys %SERVICES),
        });
        return undef;
    }
    unless ($SERVICES{$known}{$action}) {
        reply($client, 400, { error => "для службы «$known» действие «$action» не разрешено" });
        return undef;
    }
    if ($STARTUP_ERROR ne '') {
        reply($client, 503, { error => $STARTUP_ERROR });
        return undef;
    }
    return $known;
}

sub parse_query {
    my ($query) = @_;
    my %out;
    return %out unless defined $query;
    for my $pair (split /&/, $query) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k && $k ne '';
        $v = '' unless defined $v;
        for ($k, $v) {
            tr/+/ /;
            s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        }
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

# ==================================================================
# Действия
# ==================================================================

# Идентификатор контейнера службы. Ищется по МЕТКАМ compose, а не по имени:
# имя контейнера складывается из имени проекта и номера, и на втором стенде
# оно другое. Метка же ставится самим compose и другой быть не может.
sub container_of {
    my ($service) = @_;
    my ($rc, $out) = run(
        'docker', 'ps', '--all', '--no-trunc',
        '--filter', "label=com.docker.compose.project=$PROJECT",
        '--filter', "label=com.docker.compose.service=$service",
        '--format', '{{.ID}}',
    );
    return '' if $rc != 0;
    my ($id) = grep { /\S/ } split /\n/, $out;
    return trim($id // '');
}

sub service_state {
    my ($service) = @_;
    my $id = container_of($service);
    return { service => $service, state => 'absent', health => 'none', detail =>
        "Контейнера службы «$service» в проекте $PROJECT нет вовсе." } if $id eq '';

    my ($rc, $out) = run(
        'docker', 'inspect', $id,
        '--format',
        '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
      . '|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.RestartCount}}',
    );
    return { service => $service, state => 'unknown', health => 'none',
             detail => 'Docker не ответил о состоянии контейнера.' } if $rc != 0;

    my ($status, $health, $code, $started, $restarts) = split /\|/, trim($out);
    return {
        service   => $service,
        state     => $status   // 'unknown',
        health    => $health   // 'none',
        exitCode  => $code     // '',
        startedAt => $started  // '',
        restarts  => $restarts // '',
    };
}

# Здорова ли служба. «Здорова» — это healthy для тех, у кого есть проба,
# и running для тех, у кого её нет. Промежуточное starting считается
# «ещё не готова», иначе панель показывала бы успех до того, как служба
# начала работать.
sub is_up {
    my ($state) = @_;
    return 0 unless ($state->{state} // '') eq 'running';
    my $health = $state->{health} // 'none';
    return 1 if $health eq 'none' || $health eq 'healthy';
    return 0;
}

sub wait_up {
    my ($service) = @_;
    my $deadline = time + $WAIT_SECONDS;
    my $state;
    while (time < $deadline) {
        $state = service_state($service);
        return $state if is_up($state);
        # Контейнер, который упал сразу, ждать бессмысленно: ответ уже есть.
        last if ($state->{state} // '') eq 'exited';
        sleep 2;
    }
    return $state // service_state($service);
}

# Последние строки журнала контейнера — только когда служба НЕ поднялась.
# Иначе панель показывала бы человеку простыню на каждое удачное нажатие.
sub failure_detail {
    my ($service, $state) = @_;
    my $id = container_of($service);
    my $tail = '';
    if ($id ne '') {
        my ($rc, $out, $err) = run('docker', 'logs', '--tail', '20', $id);
        $tail = trim(($out // '') . ($err // ''));
        $tail = substr($tail, -2000) if length($tail) > 2000;
    }
    my $what =
        ($state->{state} // '') eq 'exited'
      ? "контейнер завершился (код " . ($state->{exitCode} // '?') . ')'
      : ($state->{health} // '') eq 'unhealthy' ? 'контейнер поднялся, но его проба говорит «нездоров»'
      : 'служба не объявила себя готовой за ' . $WAIT_SECONDS . ' с';
    return $tail eq '' ? $what : "$what. Последние строки журнала:\n$tail";
}

# ------------------------------------------------------------------
# ПУБЛИЧНАЯ ЧАСТЬ КЛЮЧА DKIM
#
# rspamd кладёт готовую строку DNS рядом с ключом:
#   /var/lib/rspamd/dkim/<домен>.<селектор>.dns.txt
# Панель показывала человеку этот путь и просила «скопируйте значение
# p=» — то есть отправляла в консоль по SSH за строкой, которую машина
# прочитает сама.
#
# Отдаётся ТОЛЬКО файл .dns.txt — публичная часть, та самая, что и так
# уходит в общедоступный DNS. Приватный ключ (.key) лежит там же, и его
# посредник не читает ни при каких параметрах: имя файла собирается
# здесь, из запроса берутся лишь домен и селектор, и оба проверяются
# по строгому образцу — ни косой черты, ни точек-переходов в них не
# бывает по определению.
# ------------------------------------------------------------------
sub do_dkim {
    my ($client, $domain, $selector) = @_;
    $domain   = '' unless defined $domain;
    $selector = '' unless defined $selector;
    $domain   = lc $domain;
    $selector = lc $selector;

    unless ($domain =~ /\A[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\z/) {
        return reply($client, 400, { error => 'домен не похож на домен' });
    }
    unless ($selector =~ /\A[a-z0-9][a-z0-9_-]{0,31}\z/) {
        return reply($client, 400, { error => 'селектор не похож на селектор' });
    }

    my $file = "/var/lib/rspamd/dkim/$domain.$selector.dns.txt";
    my @argv = (compose_argv(), 'exec', '-T', 'rspamd', 'cat', $file);
    my ($rc, $out, $err) = run(@argv);
    if ($rc != 0) {
        my $why = trim(($err || $out) || "код возврата $rc");
        # Отсутствие файла — обычное дело: ключа для домена ещё нет.
        my $code = $why =~ /No such file|не найден/i ? 404 : 500;
        return reply($client, $code, { error => $why });
    }
    return reply($client, 200, { ok => \1, record => trim($out) });
}

sub do_restart {
    my ($client, $service) = @_;
    my @argv = (compose_argv(), 'restart', '--no-deps', $service);
    my ($rc, $out, $err) = run(@argv);
    if ($rc != 0) {
        log_line("restart $service: код $rc");
        return reply($client, 500, { error => trim(($err || $out) || "код возврата $rc") });
    }
    my $state = wait_up($service);
    log_line("restart $service: " . ($state->{state} // '?') . '/' . ($state->{health} // '?'));
    return reply_state($client, $service, $state);
}

# Убрать ключи из infra/.env, ничего не пересоздавая. Список ключей — в
# теле, полем keys через запятую; проверяются по тому же белому списку,
# что и запись.
# ------------------------------------------------------------------
# ВЫПУСК СЕРТИФИКАТА LET'S ENCRYPT
# ------------------------------------------------------------------
# Запускается тем же способом, что и в мастере первого запуска: certbot
# отдельным контейнером, файлы — в /etc/letsencrypt хоста (иначе продлевать
# будет нечего: install/renew-certs.sh ищет их именно там).
#
# Проверка идёт по 80-му порту (--standalone), поэтому nginx на это время
# останавливается. Почта не прерывается: через 80-й ходят только веб-вход
# и автонастройка. Останавливаем и поднимаем ЗДЕСЬ, а не в сервере
# приложения: у того нет и не будет доступа к Docker.
#
# Имена доменов приходят снаружи, поэтому каждое проверяется образцом:
# строка отсюда уходит аргументом в certbot, и «-d» с чем угодно внутри
# был бы способом передать ему чужие ключи.
# ------------------------------------------------------------------
# ------------------------------------------------------------------
# СОСТОЯНИЕ ВСЕГО СТЕКА И ПАМЯТЬ КОНТЕЙНЕРОВ
# ------------------------------------------------------------------
# Раздел «Наблюдение» проверяет службы так, как их видит клиент, — по
# портам. Это правильная проверка, но она не отвечает на два вопроса,
# которые задают при разборе: «а контейнер вообще запущен или он в петле
# перезапусков?» и «сколько памяти ест стек, не упрёмся ли мы в потолок
# VPS?». Оба требуют Docker, и потому висели в списке непроверяемого.
#
# Список служб — из %SERVICES, а не из ответа Docker: показывать надо то,
# что продукт считает своими службами, а не всё, что нашлось на машине.
# Иначе на общей машине в панель попали бы чужие контейнеры.
#
# docker stats запускается с --no-stream: без него команда висит вечно, отдавая
# показания раз в секунду, и запрос из панели никогда бы не завершился.
# ------------------------------------------------------------------
sub do_stack {
    my ($client) = @_;

    my @services = sort keys %SERVICES;
    my (@items, @ids);
    my %by_id;

    for my $service (@services) {
        my $state = service_state($service);
        my $id    = container_of($service);
        if ($id ne '') {
            push @ids, $id;
            $by_id{$id} = $service;
        }
        push @items, $state;
    }

    # Память одним вызовом на все контейнеры: отдельный вызов на каждый
    # стоит около секунды, а служб дюжина.
    my %memory;
    if (@ids) {
        my ($rc, $out) = run('docker', 'stats', '--no-stream', '--format',
                             '{{.ID}}|{{.MemUsage}}|{{.MemPerc}}|{{.CPUPerc}}', @ids);
        if ($rc == 0) {
            for my $line (split /\n/, $out) {
                my ($short, $mem, $memperc, $cpu) = split /\|/, trim($line);
                next unless defined $short && $short ne '';
                # docker stats печатает короткий идентификатор — сопоставляем
                # по началу полного.
                for my $id (@ids) {
                    next unless index($id, $short) == 0;
                    $memory{$by_id{$id}} = {
                        memory  => trim($mem     // ''),
                        memPerc => trim($memperc // ''),
                        cpuPerc => trim($cpu     // ''),
                    };
                    last;
                }
            }
        }
    }

    for my $item (@items) {
        my $extra = $memory{ $item->{service} };
        next unless $extra;
        $item->{$_} = $extra->{$_} for keys %$extra;
    }

    return reply($client, 200, { ok => \1, services => \@items });
}

# ------------------------------------------------------------------
# /audit — то, чего сервер приложения о себе узнать не может
# ------------------------------------------------------------------
# Два вопроса, за которыми до сих пор ходили в консоль по ssh, и оба
# из тех, где ошибка обнаруживается поздно и дорого:
#
#   1. НА КАКОМ АДРЕСЕ слушают порты. Изнутри контейнера видно только
#      внутреннюю сеть Docker: порт, привязанный к 127.0.0.1, оттуда
#      неотличим от открытого наружу. А разница — вся: 25-й порт на
#      localhost означает, что чужие серверы не доставят ни одного
#      письма, и узнают об этом по молчанию, а не по отказу.
#   2. КТО МОЖЕТ ПРОЧИТАТЬ infra/.env. В нём пароль базы, ключи
#      шифрования и секрет сессий. Файл с правами 0644 на машине, где
#      есть ещё чей-то доступ, — это выданные наружу ключи от всего.
#
# ЧТО ОТДАЁТСЯ И ЧЕГО ЗДЕСЬ НЕТ. Только вердикты и числа: режим доступа,
# владелец, есть ли возвраты каретки, СКОЛЬКО ключей совпадает с
# примером. Ни одного значения, ни одного имени ключа-заглушки — иначе
# ответ посредника сам стал бы подсказкой «какой пароль подбирать
# первым». Тот же принцип, что и во всех остальных операциях: наружу
# уходит суждение, а не содержимое.
sub do_audit {
    my ($client) = @_;

    my @ports;
    for my $service (sort keys %SERVICES) {
        my $id = container_of($service);
        next if $id eq '';
        # docker port печатает строки вида «25/tcp -> 0.0.0.0:25».
        my ($rc, $out) = run('docker', 'port', $id);
        next unless $rc == 0;
        for my $line (split /\n/, $out) {
            $line = trim($line);
            next unless $line =~ m{^(\d+)/(tcp|udp)\s*->\s*(.+):(\d+)$};
            my ($inner, $proto, $bind, $outer) = ($1, $2, $3, $4);
            # IPv6-адрес docker печатает В СКОБКАХ: «25/tcp -> [::]:25».
            # Без их снятия сравнение с «::» не совпадало никогда, и
            # опубликованный на всех адресах IPv6 порт панель показывала
            # закрытым снаружи — то есть звала чинить работающее.
            $bind =~ s/^\[(.*)\]$/$1/;
            # ::  и 0.0.0.0 — «слушаем на всех адресах машины».
            my $public = ($bind eq '0.0.0.0' || $bind eq '::') ? \1 : \0;
            push @ports, {
                service   => $service,
                container => $inner + 0,
                host      => $outer + 0,
                proto     => $proto,
                bind      => $bind,
                public    => $public,
            };
        }
    }

    my %env = (readable => \0);
    if (-f $ENV_FILE) {
        my @st = stat($ENV_FILE);
        if (@st) {
            $env{readable} = \1;
            # Восьмеричные права без типа файла: 0600, 0644 и так далее.
            $env{mode}     = sprintf('%04o', $st[2] & 07777);
            $env{uid}      = $st[4] + 0;
            $env{gid}      = $st[5] + 0;
            # Доступен ли файл кому-то, кроме владельца.
            $env{groupReadable} = ($st[2] & 0040) ? \1 : \0;
            $env{worldReadable} = ($st[2] & 0004) ? \1 : \0;
        }
        if (open(my $fh, '<', $ENV_FILE)) {
            my ($crlf, $keys) = (0, 0);
            my %values;
            while (my $line = <$fh>) {
                $crlf++ if $line =~ /\r\n$/;
                $line =~ s/\r?\n$//;
                next if $line =~ /^\s*(#|$)/;
                next unless $line =~ /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
                $keys++;
                $values{$1} = $2;
            }
            close($fh);
            $env{crlfLines} = $crlf;
            $env{keys}      = $keys;

            # Сколько СЕКРЕТОВ так и остались из примера. Сам пример
            # лежит рядом с compose и посреднику виден на чтение.
            #
            # Считаются только ключи, которые по имени являются секретом:
            # пароль, ключ, секрет, токен. Первая версия сравнивала все
            # подряд и насчитала 103 совпадения из 124 — а это были номера
            # портов, уровни журнала и сроки жизни сессий, то есть ровно
            # те значения, которые ОБЯЗАНЫ совпадать с примером. Проверка,
            # которая всегда красная, не значит ничего.
            my $example = '/repo/infra/.env.example';
            if (open(my $eh, '<', $example)) {
                my $same = 0;
                while (my $line = <$eh>) {
                    $line =~ s/\r?\n$//;
                    next unless $line =~ /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;
                    my ($key, $val) = ($1, $2);
                    # Пустое значение в примере — это «заполните сами», а
                    # не заглушка: совпадение по нему ничего не значит.
                    next if $val =~ /^\s*$/;
                    next unless $key =~ /(PASSWORD|SECRET|TOKEN|_KEY|APIKEY|PASSPHRASE)/;
                    $same++ if exists $values{$key} && $values{$key} eq $val;
                }
                close($eh);
                $env{sameAsExample} = $same;
            }
        }
    }

    return reply($client, 200, { ok => \1, ports => \@ports, env => \%env });
}

sub do_certbot {
    my ($client, $body) = @_;
    my %given = parse_query($body);

    my @domains;
    for my $name (split /,/, ($given{domains} // '')) {
        $name =~ s/^\s+|\s+$//g;
        next if $name eq '';
        unless ($name =~ /\A[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\z/i) {
            return reply($client, 400, { error => "«$name» не похоже на доменное имя" });
        }
        push @domains, lc $name;
    }
    return reply($client, 400, { error => 'не переданы домены' }) unless @domains;

    my $email = $given{email} // '';
    unless ($email =~ /\A[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}\z/i) {
        return reply($client, 400, { error => 'адрес для уведомлений не похож на адрес' });
    }

    my $staging = ($given{staging} // '') eq '1';

    # Пробный выпуск — отдельным именем сертификата: иначе испытательный
    # сертификат лёг бы поверх настоящего, и почтовые программы получили
    # бы «выдан неизвестным центром».
    my $cert_name = $staging ? 'mailtrue-staging' : 'mailtrue';

    # ------------------------------------------------------------------
    # Проверка через nginx (webroot), а НЕ остановкой nginx
    # ------------------------------------------------------------------
    # Certbot умеет и сам слушать 80-й порт (--standalone) — так делает
    # консольный установщик, и там это уместно: он работает с сервера.
    #
    # Из панели так нельзя. Запрос на выпуск приходит ЧЕРЕЗ nginx, и
    # первое, что делал бы выпуск, — рвал соединение, по которому пришёл:
    # человек нажимает кнопку и получает обрыв вместо ответа. Проверено
    # живьём, ответ был «код 000».
    #
    # Поэтому webroot: certbot кладёт файл-подтверждение в общий каталог,
    # а отдаёт его nginx — по пути /.well-known/acme-challenge/, который у
    # нас и так исключён из перенаправления на HTTPS. Никто ничего не
    # гасит, веб-вход доступен всё время выпуска.
    my $webroot_volume = $PROJECT . '_acme-challenge';
    my @args = (
        'run', '--rm',
        '-v', "$webroot_volume:/var/www/acme",
        '-v', '/etc/letsencrypt:/etc/letsencrypt',
        '-v', '/var/lib/letsencrypt:/var/lib/letsencrypt',
        '-v', '/var/log/letsencrypt:/var/log/letsencrypt',
        'certbot/certbot:latest',
        'certonly', '--webroot', '-w', '/var/www/acme',
        '--non-interactive', '--agree-tos',
        '--email', $email,
        '--cert-name', $cert_name,
        '--keep-until-expiring',
    );
    push @args, '--staging' if $staging;
    push @args, ('-d', $_) for @domains;

    my ($rc, $out, $err) = run('docker', @args);

    if ($rc != 0) {
        my $why = trim(($err || $out) || "код возврата $rc");
        # Хвост, а не всё: журнал certbot бывает на сотни строк, а нужна
        # причина — она в конце.
        $why = substr($why, -1200) if length($why) > 1200;
        log_line("certbot: код $rc");
        return reply($client, 500, { error => $why });
    }

    # ------------------------------------------------------------------
    # Разложить по стеку
    # ------------------------------------------------------------------
    # Выпущенные файлы лежат в /etc/letsencrypt хоста, а службам нужен
    # каталог infra/data/certs: nginx, Postfix и Dovecot следят именно за
    # ним и перечитывают сертификат сами в течение десяти секунд.
    #
    # Копирует не сервер приложения (у него нет /etc/letsencrypt) и не мы
    # своими руками (в контейнере посредника нет ни того, ни другого
    # каталога), а одноразовый контейнер, которому смонтированы оба. Образ
    # берём тот же, что уже скачан ради выпуска, — второй тянуть незачем.
    #
    # Пробный сертификат НЕ раскладываем: он выписан испытательным центром,
    # и почтовые программы на нём ругаются. Его смысл — проверить, что
    # проверка домена вообще проходит, не потратив попытку у настоящего
    # Let's Encrypt (там пять неудач в час на домен).
    unless ($staging) {
        my @copy = (
            'run', '--rm',
            '-v', '/etc/letsencrypt:/le:ro',
            '-v', "$PROJECT_DIR/data/certs:/certs",
            '--entrypoint', 'sh',
            'certbot/certbot:latest',
            '-c',
            "set -e; cp -L /le/live/$cert_name/fullchain.pem /certs/mail.crt.tmp; "
              . "cp -L /le/live/$cert_name/privkey.pem /certs/mail.key.tmp; "
              . 'chmod 644 /certs/mail.crt.tmp; chmod 600 /certs/mail.key.tmp; '
              . 'mv /certs/mail.crt.tmp /certs/mail.crt; mv /certs/mail.key.tmp /certs/mail.key; '
              . "printf 'letsencrypt\\n' > /certs/source",
        );
        my ($crc, $cout, $cerr) = run('docker', @copy);
        if ($crc != 0) {
            my $why = trim(($cerr || $cout) || "код возврата $crc");
            log_line("certbot: выпущен, но не разложен: код $crc");
            return reply($client, 500, {
                error => "Сертификат выпущен, но разложить его по стеку не удалось: $why",
            });
        }
    }

    log_line('certbot: выпущен ' . join(',', @domains) . ($staging ? ' (пробный)' : ''));
    return reply($client, 200, {
        ok        => \1,
        cert_name => $cert_name,
        domains   => \@domains,
        staging   => $staging ? \1 : \0,
        live_dir  => "/etc/letsencrypt/live/$cert_name",
        output    => trim(substr($out, -1200)),
    });
}

sub do_env_unset {
    my ($client, $service, $body) = @_;
    my %given   = parse_query($body);
    my $allowed = $ENV_KEYS{$service} // {};
    my @unset;
    for my $key (split /,/, ($given{keys} // '')) {
        $key =~ s/^\s+|\s+$//g;
        next if $key eq '';
        unless ($allowed->{$key}) {
            return reply($client, 400, {
                error => "ключ «$key» посреднику убирать не разрешено (служба $service)",
            });
        }
        push @unset, $key;
    }
    return reply($client, 400, { error => 'не переданы ключи' }) unless @unset;

    my $error = write_env({}, \@unset);
    return reply($client, 500, { error => $error }) if $error ne '';
    log_line("env-unset $service: " . join(',', @unset));
    return reply($client, 200, { ok => \1, unset => \@unset });
}

sub do_recreate {
    my ($client, $service, $body) = @_;

    # Значения настроек, которые обязаны попасть в окружение нового
    # контейнера. Приходят полем формы (KEY=значение&KEY2=значение2), а не
    # JSON: разбирать JSON вручную в посреднике с сокетом Docker — лишний
    # код там, где его должно быть как можно меньше.
    my %given = parse_query($body);
    my $allowed = $ENV_KEYS{$service} // {};

    # Особое поле: ключи, которые надо УБРАТЬ из infra/.env. Приходит
    # списком через запятую, проверяется по тому же белому списку, что и
    # запись, — убрать чужой ключ посредник не может ровно так же, как не
    # может его записать.
    my @unset;
    if (defined $given{__unset}) {
        for my $key (split /,/, delete $given{__unset}) {
            $key =~ s/^\s+|\s+$//g;
            next if $key eq '';
            unless ($allowed->{$key}) {
                return reply($client, 400, {
                    error => "ключ «$key» посреднику убирать не разрешено (служба $service)",
                });
            }
            push @unset, $key;
        }
    }

    my %write;
    for my $key (sort keys %given) {
        unless ($allowed->{$key}) {
            return reply($client, 400, {
                error => "ключ «$key» посреднику записывать не разрешено"
                       . " (служба $service)",
            });
        }
        my $value = $given{$key};
        unless (valid_env_value($value)) {
            return reply($client, 400, { error => "значение ключа «$key» содержит недопустимые символы" });
        }
        $write{$key} = $value;
    }

    if (%write || @unset) {
        my $error = write_env(\%write, \@unset);
        return reply($client, 500, { error => $error }) if $error ne '';
    }

    my @argv = (compose_argv(), 'up', '-d', '--no-deps', '--no-build', $service);
    my ($rc, $out, $err) = run(@argv);
    if ($rc != 0) {
        log_line("recreate $service: код $rc");
        return reply($client, 500, { error => trim(($err || $out) || "код возврата $rc") });
    }
    my $state = wait_up($service);
    log_line("recreate $service: " . ($state->{state} // '?') . '/' . ($state->{health} // '?')
           . (%write ? ' (ключей записано: ' . scalar(keys %write) . ')' : ''));
    return reply_state($client, $service, $state);
}

sub reply_state {
    my ($client, $service, $state) = @_;
    if (is_up($state)) {
        return reply($client, 200, { ok => \1, %$state });
    }
    return reply($client, 200, {
        ok     => \0,
        %$state,
        detail => failure_detail($service, $state),
    });
}

# Аргументы compose. Собираются здесь, а не в каждом вызове: расхождение
# между «перезапустить» и «пересоздать» означало бы, что одна из команд
# работает с другим набором файлов, то есть с другим стеком.
sub compose_argv {
    my @argv = ('docker', 'compose', '-p', $PROJECT, '--project-directory', $PROJECT_DIR,
                '-f', $COMPOSE_MAIN);
    push @argv, '-f', $COMPOSE_PROD if $USE_PROD;
    push @argv, '--env-file', $ENV_FILE if -f $ENV_FILE;
    return @argv;
}

# ==================================================================
# Запись infra/.env
# ==================================================================
# Правила ровно те же, что у env_set в install/lib/common.sh, и это не
# совпадение: файл общий, и два разных способа его править однажды
# разошлись бы. Первая строка `КЛЮЧ=` заменяется, остальные строки и все
# комментарии сохраняются как есть, отсутствующий ключ дописывается в конец.
#
# Пишем НА МЕСТЕ (truncate + write), а не «во временный файл и переименовать»:
# .env примонтирован отдельным файлом, и переименовать поверх точки
# монтирования нельзя — получилось бы «Device or resource busy». Прежнее
# содержимое остаётся в памяти, и при неудачной записи возвращается назад.
sub write_env {
    my ($values, $unset) = @_;
    $unset = [] unless defined $unset;
    my %drop = map { $_ => 1 } @$unset;
    return 'Файл infra/.env посреднику не примонтирован — записать настройку некуда.'
        unless -f $ENV_FILE;

    # ------------------------------------------------------------------
    # А ТОТ ЛИ ЭТО ФАЙЛ
    # ------------------------------------------------------------------
    # infra/.env примонтирован сюда ОТДЕЛЬНЫМ ФАЙЛОМ, а такой bind-mount
    # держит не имя, а конкретный файл на диске. Достаточно один раз
    # заменить файл на хосте, а не переписать его содержимое, — «sed -i»,
    # «mv поверх», install(1), распаковка архива, редактор с записью через
    # временный файл, — и здесь остаётся СТАРЫЙ файл, которого в каталоге
    # уже нет.
    #
    # Дальше всё ломается тихо, и в этом вся беда. Панель сохраняет
    # настройку, мы честно пишем её сюда, отвечаем «готово», служба
    # пересоздаётся — и поднимается с прежним окружением. Ни ошибки, ни
    # расхождения на экране: панель показывает сохранённое значение,
    # потому что оно и правда сохранено, только в базе.
    #
    # Отличить один случай от другого стоит один вызов stat: у файла,
    # которого больше нет в каталоге, счётчик имён равен нулю. Проверено
    # живьём — после «sed -i» на хосте здесь становится 0.
    #
    # Отказываемся, а не пишем: тихая запись в никуда хуже громкого
    # отказа ровно настолько, насколько «настроил, а не работает» хуже
    # «не дали настроить».
    my $links = (stat($ENV_FILE))[3];
    if (defined $links && $links == 0) {
        return 'Файл infra/.env на сервере заменён новым, а посредник остался со старым: '
             . 'записанное сюда до служб не дойдёт. Пересоздайте посредник '
             . '(docker compose up -d --force-recreate service-agent), а .env впредь '
             . 'правьте поверх существующего файла, а не заменой (sed -i, mv, install).';
    }

    open(my $fh, '<', $ENV_FILE) or return "Не удалось прочитать infra/.env: $!";
    local $/;
    my $before = <$fh> // '';
    close $fh;

    # Возврат каретки вычищаем намеренно: .env, однажды сохранённый с
    # концами строк Windows, ломает разбор в bash-скриптах установки
    # (подробно — в load_env, install/lib/common.sh).
    (my $text = $before) =~ s/\r//g;
    my @lines = split /\n/, $text, -1;
    my %done;
    my @kept;
    for my $line (@lines) {
        # Убираемые ключи просто не переносим в новый файл: значение
        # тогда возьмётся из умолчания в docker-compose.yml, а это и есть
        # «как у продукта».
        my $dropped = 0;
        for my $key (keys %drop) {
            next unless index($line, "$key=") == 0;
            $dropped = 1;
            last;
        }
        next if $dropped;

        for my $key (keys %$values) {
            next if $done{$key};
            next unless index($line, "$key=") == 0;
            $line  = "$key=" . env_quoted($values->{$key});
            $done{$key} = 1;
        }
        push @kept, $line;
    }
    @lines = @kept;
    my $out = join("\n", @lines);
    for my $key (sort keys %$values) {
        next if $done{$key};
        $out .= "\n" unless $out =~ /\n\z/ || $out eq '';
        $out .= "$key=" . env_quoted($values->{$key}) . "\n";
    }

    open(my $wh, '+<', $ENV_FILE) or return "Не удалось открыть infra/.env на запись: $!";
    my $ok = truncate($wh, 0) && (print $wh $out);
    close $wh;
    unless ($ok) {
        # Возвращаем как было: полуписаный .env означал бы стек, который
        # больше не поднимается ни одной командой.
        if (open(my $rh, '+<', $ENV_FILE)) {
            truncate($rh, 0);
            print $rh $before;
            close $rh;
        }
        return 'Не удалось записать infra/.env: прежнее содержимое возвращено.';
    }
    chmod 0600, $ENV_FILE;
    return '';
}

# Значение, которое разрешено положить в .env.
#
# Здесь запрет перечислен списком, а не наоборот — и это единственное
# место посредника, где так. Причина: одно из значений в списке — ИМЯ
# ПРОДУКТА, которое человек видит в мастере настройки Thunderbird. Оно
# бывает «Почта Компании», бывает китайским, и закрытый список из букв
# латиницы означал бы «переименовать установку под свою марку можно
# только по-английски». Первая же попытка на стенде это и показала.
#
# Запрещено ровно то, что ломает разбор .env или превращает значение в
# нечто большее, чем значение:
#
#   " '  — кавычки: compose снимает их и меняет смысл значения;
#   $    — подстановка переменной: «$POSTGRES_PASSWORD» в имени продукта
#          вытащило бы пароль базы в выдачу автонастройки;
#   #    — начало комментария: хвост значения молча пропал бы;
#   \    — экранирование, оно же путь Windows;
#   `    — подстановка команды в bash-скриптах установки, которые тот же
#          файл читают;
#   управляющие символы и перевод строки — вторая переменная внутри
#          первой.
#
# Всё остальное, включая любые буквы любых языков, — обычный текст.
sub valid_env_value {
    my ($value) = @_;
    return 0 unless defined $value;
    return 0 if length($value) > 512;
    return 0 if $value =~ m{["'\$#\\`]};
    return 0 if $value =~ m{[\x00-\x1f\x7f]};
    return 1;
}

# ------------------------------------------------------------------
# Значение для строки infra/.env — В ОДИНАРНЫХ КАВЫЧКАХ
# ------------------------------------------------------------------
# Файл читают ДВА разных разборщика, и правила у них разные:
#
#   * docker compose берёт остаток строки как значение и снимает кавычки;
#   * скрипты обслуживания ИСПОЛНЯЮТ файл целиком
#     (load_env в install/lib/common.sh: «set -a; . <(...)»).
#
# Второй и делал запись без кавычек опасной. Список запрещённых символов
# выше не включает «;», «&», «|», «(», «)» и пробел — и не может включать:
# пробел нужен самому продукту (PROVIDER_NAME=Почта Компании — тот самый
# случай, ради которого выбран запретный список, а не разрешительный).
#
# Отсюда две беды, обе проверены запуском:
#
#   1. ЗНАЧЕНИЕ С ПРОБЕЛОМ ЛОМАЛО ВСЕ СКРИПТЫ. «FAIL2BAN_IGNORE_IPS=1.2.3.4
#      5.6.7.8» (формат из .env.example) превращался в попытку выполнить
#      «5.6.7.8» — bash отвечал «command not found», код 127. Падали
#      install.sh, backup.sh, restore.sh, uninstall.sh и renew-certs.sh,
#      то есть в том числе АВТОПРОДЛЕНИЕ СЕРТИФИКАТА по таймеру. Молча.
#
#   2. «;» ПРОХОДИЛ ПРОВЕРКУ. Значение «x;touch /tmp/pwn» выполняло
#      команду при первом же чтении файла — а renew-certs.sh запускается
#      от root по таймеру. То есть строка, сохранённая в панели,
#      исполнялась как root на хосте без участия человека, обходя ровно
#      ту границу, ради которой весь этот посредник и написан.
#
# Кавычки закрывают оба случая разом: внутри одинарных кавычек bash не
# трогает ничего. Проверено на обоих разборщиках — compose отдаёт
# «Почта Компании» без кавычек, bash доходит до конца и команду не
# выполняет.
sub env_quoted {
    my ($value) = @_;
    $value = '' unless defined $value;
    # Одиночная кавычка внутри: закрыть строку, вставить экранированную,
    # открыть снова. Классический приём — его же понимают и bash, и compose.
    $value =~ s{'}{'\\''}g;
    return "'" . $value . "'";
}

# ==================================================================
# Запуск программы: списком аргументов, без командной оболочки
# ==================================================================
sub run {
    my (@argv) = @_;
    my $errfile = "/tmp/service-agent.$$.err";
    my ($out, $err, $rc) = ('', '', -1);
    my $pid;
    eval {
        local $SIG{ALRM} = sub { kill 'KILL', $pid if $pid; die "превышено время ожидания\n" };
        alarm $CMD_TIMEOUT;
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
    return ($rc, $out, trim($err // ''));
}

sub trim {
    my ($text) = @_;
    return '' unless defined $text;
    $text =~ s/\A\s+//;
    $text =~ s/\s+\z//;
    return $text;
}

sub log_line {
    my ($text) = @_;
    my $stamp = strftime('%Y-%m-%dT%H:%M:%S', localtime);
    print STDERR "$stamp service-agent: $text\n";
}

# ==================================================================
# Ответ. Свой сборщик JSON — по той же причине, что у посредника очереди:
# в образе нет зависимости, на которую можно рассчитывать, а формат здесь
# примитивный.
# ==================================================================
sub reply {
    my ($client, $code, $data) = @_;
    my $body = to_json($data);
    my $text = $code == 200 ? 'OK'
             : $code == 400 ? 'Bad Request'
             : $code == 401 ? 'Unauthorized'
             : $code == 404 ? 'Not Found'
             : $code == 503 ? 'Service Unavailable'
             :                'Error';
    print $client "HTTP/1.1 $code $text\r\n";
    print $client "Content-Type: application/json; charset=utf-8\r\n";
    print $client 'Content-Length: ' . length($body) . "\r\n";
    print $client "Connection: close\r\n\r\n";
    print $client $body;
}

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
    # Числами наружу ничего не отдаём намеренно: строка, случайно
    # состоящая из цифр, должна доехать строкой.
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
    $text =~ s/([\x00-\x08\x0b\x0c\x0e-\x1f])/sprintf('\\u%04x', ord($1))/ge;
    return '"' . $text . '"';
}
