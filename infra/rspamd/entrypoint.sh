#!/bin/sh
# 1) Генерируем DKIM-ключ домена (если ещё нет) в /var/lib/rspamd/dkim
#    (named volume; рядом кладётся .dns.txt с TXT-записью для DNS).
# 2) Пишем конфиги с секретами в override.d (не попадают в репозиторий).
# 3) Запускаем rspamd в foreground от пользователя _rspamd.
set -e

: "${MAIL_DOMAIN:=mail.local}"
: "${DKIM_SELECTOR:=mail}"

DKIM_DIR=/var/lib/rspamd/dkim
KEY="$DKIM_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.key"

mkdir -p "$DKIM_DIR"
if [ ! -f "$KEY" ]; then
    rspamadm dkim_keygen -d "$MAIL_DOMAIN" -s "$DKIM_SELECTOR" -b 2048 -k "$KEY" \
        > "$DKIM_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.dns.txt"
    echo "DKIM: сгенерирован ключ $KEY (DNS-запись: $DKIM_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.dns.txt)"
fi
chown -R _rspamd:_rspamd /var/lib/rspamd
chmod 600 "$KEY"
# Готовые DNS-записи (*.dns.txt) — публичные данные: их читает сервис
# autoconfig из этого же тома (смонтирован read-only). Приватный ключ — 600.
chmod 711 /var/lib/rspamd
chmod 755 "$DKIM_DIR"
chmod 644 "$DKIM_DIR"/*.dns.txt 2>/dev/null || true

# Redis (статистика, bayes, greylisting и т.п.)
cat > /etc/rspamd/override.d/redis.conf <<EOF
servers = "redis:6379";
password = "${REDIS_PASSWORD}";
EOF

# Пароль веб-интерфейса/API контроллера
cat > /etc/rspamd/override.d/worker-controller.inc <<EOF
password = "${RSPAMD_PASSWORD}";
enable_password = "${RSPAMD_PASSWORD}";
EOF

# ------------------------------------------------------------------
# DKIM: селектор, путь к ключам и КТО получает подпись
# ------------------------------------------------------------------
# sign_authenticated закрывает почту из веб-интерфейса и почтовых клиентов
# (submission:587 с SASL), sign_local — то, что положено локально через
# sendmail. Но есть третий отправитель, который не попадает ни туда, ни
# сюда: сам Dovecot. Правило «переслать копию» (redirect) и автоответчик
# (vacation) отдают письмо на postfix:25 с адреса ${DOVECOT_IP} и БЕЗ
# SASL-логина — см. submission_host в infra/dovecot/conf/dovecot.conf.template.
# Для rspamd это ни authenticated, ни local (адрес стека намеренно исключён
# из local_addrs в local.d/options.inc), поэтому подпись не ставилась вовсе:
# автоответ с нашего домена уходил без DKIM и при опубликованном
# DMARC p=quarantine/reject — а такие записи рекомендует наша же панель —
# уезжал в карантин получателя.
if [ -n "${DOVECOT_IP}" ]; then
    SIGN_NETWORKS="sign_networks = [\"${DOVECOT_IP}/32\"];"
else
    SIGN_NETWORKS=""
fi
cat > /etc/rspamd/override.d/dkim_signing.conf <<EOF
enabled = true;
selector = "${DKIM_SELECTOR}";
path = "/var/lib/rspamd/dkim/\$domain.\$selector.key";
allow_username_mismatch = true;
use_domain = "header";
sign_authenticated = true;
sign_local = true;
${SIGN_NETWORKS}
try_fallback = true;
EOF

# ------------------------------------------------------------------
# Почта, которую порождает сам Dovecot, не должна получать отказ
# ------------------------------------------------------------------
# ЗАЧЕМ. Отказ на письмо от redirect/vacation — это не «письмо не ушло»,
# это потеря ВХОДЯЩЕГО письма: команда redirect получает 5xx, скрипт Sieve
# падает фатально, LMTP отвечает временным отказом, и письмо не попадает в
# ящик вообще (разбор — в dovecot.conf.template рядом с sieve_default).
# То есть одно правило пересылки могло остановить доставку всей почты в
# ящик, стоило пересылаемому письму набрать 15 баллов на внешних списках.
# Само письмо уже проверено при входе, второй раз спрашивать внешние
# источники незачем — тот же довод, что и у own_users в local.d/settings.conf.
#
# Файл кладём в том (каталог local.d примонтирован только на чтение) и
# подключаем из settings.conf через .include: секцию settings нельзя писать
# в override.d — там она ЗАМЕНИТ правило own_users целиком.
mkdir -p /var/lib/rspamd/generated
if [ -n "${DOVECOT_IP}" ]; then
    cat > /var/lib/rspamd/generated/own_dovecot.conf <<EOF
own_dovecot {
    priority = high;
    ip = "${DOVECOT_IP}/32";

    apply {
        groups_disabled = [
            "rbl", "spamhaus", "surbl", "surblorg", "uribl", "rspamdbl",
            "ebl", "sem", "blocklistde", "mailspike", "dnswl", "fuzzy",
            "phishing", "hfilter", "mx"
        ];

        # Отказ и серый список отключены полностью: любой из них означает
        # потерю входящего письма, а не отказ в пересылке.
        actions {
            add_header = 12;
            greylist = null;
            reject = null;
        }
    }
}
EOF
    echo "rspamd: письма от Dovecot (${DOVECOT_IP}) подписываются DKIM и не отбиваются"
else
    : > /var/lib/rspamd/generated/own_dovecot.conf
    echo "rspamd: DOVECOT_IP не задан — пересылка и автоответы идут как чужая почта"
fi
chmod 755 /var/lib/rspamd/generated
chmod 644 /var/lib/rspamd/generated/own_dovecot.conf
chown -R _rspamd:_rspamd /var/lib/rspamd/generated

# ------------------------------------------------------------------
# Сколько писем может отправить один вошедший
# ------------------------------------------------------------------
# ЗАЧЕМ. Предела не было ни одного: ни у Postfix (smtpd_client_*_rate_limit
# нигде не задан), ни здесь. Порты 587 и 465 открыты наружу, и подобранный
# или украденный пароль означал вот что: с сервера уходит поток спама,
# ПОДПИСАННОГО нашим ключом DKIM и с верным заголовком From. Через
# несколько часов домен и адрес сервера оказываются в Spamhaus, после чего
# перестаёт доходить вся законная почта конторы, и снимать это приходится
# неделями. Один пароль — и почта организации выключена.
#
# ПОЧЕМУ ЗДЕСЬ, А НЕ В POSTFIX. Пределы Postfix считаются ПО КЛИЕНТУ, то
# есть по адресу соединения. У нас все письма веб-интерфейса приходят с
# одного адреса — сервера приложения, — и такой предел либо не сработает
# вовсе, либо уронит всю контору из-за одного человека. Rspamd видит
# SASL-логин и считает КАЖДОМУ отдельно: у одного кончился запас —
# остальные работают.
#
# ОТКУДА ЧИСЛА. Ориентир — обычная работа человека, а не теоретический
# потолок. Полторы сотни писем в час и шесть сотен в сутки покрывают и
# активную переписку, и рассылку по отделу: упереться случайно нельзя, а
# поток спама упирается за минуты. Значения настраиваются в infra/.env —
# контора, где рассылают больше, поднимет их, не трогая образ.
#
# ЧЕГО ПРЕДЕЛ НЕ КАСАЕТСЯ. Писем без аутентификации: входящей почты из
# интернета и служебных писем самого сервера (автоответчик, уведомления,
# самопроверка). Они кладутся локально, SASL-логина у них нет.
#
# Отказ ВРЕМЕННЫЙ: упёршийся в предел письма не теряет — почтовая
# программа повторит отправку сама. Постоянный отказ означал бы
# потерянное письмо у того, кто просто разослал приглашения коллегам.
: "${RATELIMIT_USER_HOURLY:=150}"
: "${RATELIMIT_USER_DAILY:=600}"
: "${RATELIMIT_USER_RCPT:=300}"

cat > /etc/rspamd/override.d/ratelimit.conf <<EOF
enabled = true;
# Каждый получатель считается отдельно: письмо на сто адресов — это сто
# писем, и для чёрных списков разницы нет никакой.
count_exceeding = true;
rates {
    mt_user_hourly {
        selector = 'user';
        bucket = {
            burst = ${RATELIMIT_USER_HOURLY};
            rate = "${RATELIMIT_USER_HOURLY} / 1h";
        }
    }
    mt_user_daily {
        selector = 'user';
        bucket = {
            burst = ${RATELIMIT_USER_DAILY};
            rate = "${RATELIMIT_USER_DAILY} / 1d";
        }
    }
    mt_user_recipients {
        selector = 'rcpt';
        bucket = {
            burst = ${RATELIMIT_USER_RCPT};
            rate = "${RATELIMIT_USER_RCPT} / 1h";
        }
    }
}
EOF
echo "rspamd: предел отправки — ${RATELIMIT_USER_HOURLY} писем в час, ${RATELIMIT_USER_DAILY} в сутки"

# ------------------------------------------------------------------
# Свои правила на lua
# ------------------------------------------------------------------
# rspamd подключает файл `rspamd.local.lua` из каталога настроек сам —
# это его штатное место для правил, которых нет в поставке. Каталог с
# нашими правилами примонтирован только для чтения, поэтому здесь мы
# лишь дописываем строчку подключения.
#
# Правило одно и важное: sender_identity.lua не даёт отправить письмо от
# чужого имени. Разбор — в самом файле; коротко: Postfix проверяет адрес
# из конверта, а получатель и подпись DKIM смотрят на заголовок From, и
# без этой проверки они могли расходиться.
if [ -d /etc/rspamd/lua ]; then
    : > /etc/rspamd/rspamd.local.lua
    for rule in /etc/rspamd/lua/*.lua; do
        [ -f "$rule" ] || continue
        printf 'dofile("%s")
' "$rule" >> /etc/rspamd/rspamd.local.lua
        echo "rspamd: подключено правило $(basename "$rule")"
    done
fi

# ------------------------------------------------------------------
# Свой рекурсивный DNS-резольвер
# ------------------------------------------------------------------
# Встроенный DNS-клиент rspamd по умолчанию читает /etc/resolv.conf, где
# стоит внутренний резольвер Docker, а тот пересылает запросы наружу. Списки
# Spamhaus/URIBL такие запросы отклоняют (127.255.255.254, «open resolver»),
# и проверки молча перестают работать. Поэтому адрес резольвера задаём явно.
# Имена контейнеров (redis, clamav) unbound отдаёт через stub-зоны — см.
# infra/unbound/unbound.conf.
#
# Здесь же — таймаут, повторы и число сокетов: override.d заменяет объект
# dns ЦЕЛИКОМ, поэтому те же строки в local.d/options.inc не действовали
# (проверено `rspamadm configdump options` — в объекте оставался один
# nameserver). При недоступном резольвере проверка должна деградировать
# быстро, а не висеть на пяти повторах по умолчанию.
if [ -n "${RESOLVER_IP}" ]; then
    cat > /etc/rspamd/override.d/options.inc <<EOF
dns {
    nameserver = ["${RESOLVER_IP}"];
    timeout = 1s;
    retransmits = 2;
    sockets = 16;
}
EOF
    echo "DNS: rspamd резолвит через ${RESOLVER_IP} (unbound)"
fi

# ------------------------------------------------------------------
# Антивирус: включается только явно (CLAMAV_ENABLED=true)
# ------------------------------------------------------------------
# Правило целиком описано в local.d/antivirus.conf; значение enabled туда
# подставляется из переменной окружения CLAMAV_ENABLED. Здесь — только
# сообщение в лог, чтобы состояние было видно при старте.
# Через override.d это делать нельзя: override.d заменяет секцию целиком,
# и правило теряет адрес сервера.
# Файл в override.d, а не подстановка внутри local.d: rspamd 4.1 не
# разворачивает `{= env.X =}` в конфигурациях, и прежняя запись всегда
# давала false — антивирус не включался ВООБЩЕ, сколько бы ни ставили
# CLAMAV_ENABLED=true. override.d заменяет секцию целиком, поэтому копируем
# описание правила полностью, заменив в нём только выключатель.
rm -f /etc/rspamd/override.d/antivirus.conf
if [ "${CLAMAV_ENABLED}" = "true" ]; then
    if [ -f /etc/rspamd/local.d/antivirus.conf ]; then
        # Заменяем ВСЕ выключатели, с любым отступом: их два — общий для
        # модуля и внутренний для правила clamav.
        sed -E 's/^([[:space:]]*)enabled = false;/\1enabled = true;/' \
            /etc/rspamd/local.d/antivirus.conf \
            > /etc/rspamd/override.d/antivirus.conf
        echo "Антивирус: ClamAV ВКЛЮЧЁН (нужен профиль docker compose --profile clamav)"
    else
        echo "Антивирус: описание правила не найдено — модуль остался выключенным"
    fi
else
    echo "Антивирус: выключен (CLAMAV_ENABLED=${CLAMAV_ENABLED:-false})"
fi

# ------------------------------------------------------------------
# Карты (белые/чёрные списки) — каталог примонтирован на запись
# ------------------------------------------------------------------
MAPS_DIR=/etc/rspamd/maps.d
MAPS_SEED=/etc/rspamd/maps.seed
# ------------------------------------------------------------------
# Заготовки -> том, и только НЕДОСТАЮЩЕЕ
# ------------------------------------------------------------------
# Карты живут в томе (rspamd-maps), а в образ/репозиторий входят только
# заготовки: с шапками-пояснениями и примерами. Копируем недостающие
# файлы — те, которых в томе ещё нет.
#
# Именно недостающие, а не все: списки в томе правит администратор через
# раздел «Спам», и перезапись их заготовкой при каждом старте стирала бы
# его работу. Ровно по этой же причине карты и уехали из рабочего дерева
# git: продукт правил файлы, которые обновление продукта потом
# перезаписывает.
mkdir -p "$MAPS_DIR"
if [ -d "$MAPS_SEED" ]; then
    for seed in "$MAPS_SEED"/*.map; do
        [ -f "$seed" ] || continue
        target="$MAPS_DIR/$(basename "$seed")"
        [ -f "$target" ] || cp "$seed" "$target"
    done
fi
if [ -d "$MAPS_DIR" ]; then
    # Основной домен должен быть в списке своих
    if [ -f "$MAPS_DIR/local_domains.map" ] \
       && ! grep -qx "$MAIL_DOMAIN" "$MAPS_DIR/local_domains.map" 2>/dev/null; then
        echo "$MAIL_DOMAIN" >> "$MAPS_DIR/local_domains.map"
        echo "Карты: в local_domains.map добавлен $MAIL_DOMAIN"
    fi
    # ------------------------------------------------------------------
    # Права: писать карты должен САМ rspamd
    # ------------------------------------------------------------------
    # Панель не имеет доступа к этому каталогу и иметь его не должна:
    # каталог примонтирован в контейнер rspamd, а не в api. Правку из
    # раздела «Спам» выполняет сам rspamd по запросу /savemap — тем же
    # процессом, который эти файлы потом читает.
    #
    # А процесс этот работает от _rspamd (см. exec в конце файла), тогда
    # как файлы приезжают из репозитория с владельцем root. Одного
    # chmod 644 здесь мало: 644 у root-файла означает «_rspamd читает, но
    # не пишет», и /savemap отвечал бы отказом. Мало и одного файла —
    # /savemap пишет во ВРЕМЕННЫЙ файл рядом и переименовывает его, то
    # есть требует права на запись и в сам каталог.
    #
    # На стенде под Docker Desktop это незаметно: бинд-монтирование с
    # Windows отдаёт полный доступ кому угодно, и правка проходит даже
    # без chown. На Ubuntu — не проходит. Поэтому chown здесь есть.
    chown -R _rspamd:_rspamd "$MAPS_DIR" 2>/dev/null || true
    chmod 755 "$MAPS_DIR" 2>/dev/null || true
    chmod 644 "$MAPS_DIR"/*.map 2>/dev/null || true
fi

exec /usr/bin/rspamd -f -u _rspamd -g _rspamd
