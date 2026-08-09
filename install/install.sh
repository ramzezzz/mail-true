#!/usr/bin/env bash
# ------------------------------------------------------------------
# Установщик Mail.True: почтовый сервер одной командой.
#
#   sudo bash install/install.sh                    # интерактивно
#   sudo bash install/install.sh --answers my.env   # без вопросов
#
# Что делает по шагам:
#   1. Проверяет систему: ОС, память, диск, порты, чужой MTA, исходящий 25-й
#   2. Ставит Docker, если его нет
#   3. Спрашивает домен, хост, администратора, антивирус
#   4. Генерирует все секреты и пишет infra/.env
#   5. Выпускает TLS-сертификат (Let's Encrypt или самоподписанный)
#   6. Поднимает стек и ждёт готовности
#   7. Создаёт ящик и учётную запись администратора
#   8. Показывает DNS-записи, которые нужно опубликовать
#
# Повторный запуск безопасен: уже сделанное не переделывается,
# сгенерированные пароли не меняются, данные не теряются.
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# Пороги памяти, диска и версии compose живут в install/lib/common.sh:
# ими пользуется и мастер первого запуска в браузере.

PREPARE_ONLY=0
SKIP_DOCKER_INSTALL=0
SKIP_PORT_CHECK=0
FORCE_YES=0

usage() {
    cat <<'EOF'
Установщик Mail.True

  bash install/install.sh [ключи]

Ключи:
  --answers ФАЙЛ        файл с ответами (см. install/answers.example.env),
                        включает неинтерактивный режим
  --non-interactive     неинтерактивный режим, ответы из переменных окружения
  --yes                 отвечать «да» на все подтверждения
  --prepare-only        только проверки, секреты и конфигурация; стек не поднимать
  --skip-docker-install не устанавливать Docker (считать, что он уже есть)
  --skip-port-check     не проверять занятость портов и исходящий 25-й
  --help                эта справка

Переменные (они же — строки файла ответов):
  MAILTRUE_DOMAIN            почтовый домен, например example.ru
  MAILTRUE_HOSTNAME          имя сервера, например mail.example.ru
  MAILTRUE_ADMIN_EMAIL       адрес администратора, например admin@example.ru
  MAILTRUE_ADMIN_PASSWORD    пароль администратора (ящик и админка)
  MAILTRUE_MAILBOX_PASSWORD  отдельный пароль для ящика (если нужен другой)
  MAILTRUE_ADMIN_LOGIN       логин в админке (по умолчанию — часть до @)
  MAILTRUE_CLAMAV            yes|no — антивирус ClamAV (около 1 ГБ памяти)
  MAILTRUE_TLS               letsencrypt|selfsigned
  MAILTRUE_LE_EMAIL          адрес для уведомлений Let's Encrypt
  MAILTRUE_BIND_ADDRESS      адрес публикации портов (по умолчанию 0.0.0.0)
EOF
}

# ------------------------------------------------------------------
# Разбор аргументов
# ------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --answers)
            [ -n "${2:-}" ] || die "--answers требует путь к файлу"
            [ -f "$2" ] || die "файл ответов не найден: $2"
            set -a
            # shellcheck disable=SC1090
            . "$2"
            set +a
            MT_NONINTERACTIVE=1
            shift 2 ;;
        --non-interactive) MT_NONINTERACTIVE=1; shift ;;
        --yes|-y)          FORCE_YES=1; shift ;;
        --prepare-only)    PREPARE_ONLY=1; shift ;;
        --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift ;;
        --skip-port-check) SKIP_PORT_CHECK=1; shift ;;
        --help|-h)         usage; exit 0 ;;
        *) die "неизвестный ключ: $1 (--help для справки)" ;;
    esac
done

MT_NONINTERACTIVE="${MT_NONINTERACTIVE:-${MAILTRUE_NONINTERACTIVE:-0}}"
MT_ASSUME_YES="${MT_ASSUME_YES:-0}"
if [ "$FORCE_YES" = "1" ]; then MT_ASSUME_YES=1; fi
if [ "${MAILTRUE_SKIP_PORT_CHECK:-0}" = "1" ]; then SKIP_PORT_CHECK=1; fi
export MT_NONINTERACTIVE MT_ASSUME_YES

printf '%s\n' "$C_BOLD"
cat <<'EOF'
  Mail.True — установка почтового сервера
EOF
printf '%s' "$C_OFF"
info "Каталог проекта: $REPO_DIR"

# ==================================================================
step "1. Проверка системы"
# ==================================================================

if [ "$(id -u)" -ne 0 ]; then
    if [ "$PREPARE_ONLY" = "1" ]; then
        warn "запущено не от root — часть проверок недоступна (режим --prepare-only)"
    else
        die "запускать нужно от root: sudo bash install/install.sh"
    fi
fi

preflight_system


# ==================================================================
step "2. Docker"
# ==================================================================

# install_docker живёт в install/lib/common.sh: тем же самым лечится
# snap-Docker, а на него натыкается и мастер первого запуска.

# В режиме --prepare-only Docker не обязателен: там только проверки,
# секреты и конфигурация — их удобно готовить и на машине без Docker.
docker_problem() {
    if [ "$PREPARE_ONLY" = "1" ]; then
        warn "$1"
        return 0
    fi
    die "$1"
}

# Snap-Docker выглядит совершенно рабочим — и версию покажет, и `docker
# info` ответит, — но каталога проекта не видит, и установка падает через
# шаг на «no such file or directory». Меняем его на официальный ДО всех
# остальных проверок; подробности и разбор — в install/lib/common.sh.
if [ "$SKIP_DOCKER_INSTALL" = "1" ]; then
    if docker_from_snap; then
        warn "Docker из snap: он не видит $REPO_DIR, стек не поднимется"
        hint "замена пропущена по --skip-docker-install"
    fi
else
    ensure_docker_native
fi

DOCKER_READY=0
if have docker && docker info >/dev/null 2>&1; then
    ok "Docker уже установлен и работает ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
    DOCKER_READY=1
elif [ "$SKIP_DOCKER_INSTALL" = "1" ]; then
    warn "Docker не отвечает, установка пропущена (--skip-docker-install)"
else
    if have docker; then
        warn "Docker установлен, но демон не отвечает"
        if have systemctl; then
            systemctl start docker >/dev/null 2>&1 || true
        fi
        if docker info >/dev/null 2>&1; then
            ok "демон Docker запущен"; DOCKER_READY=1
        else
            docker_problem "демон Docker не запускается — проверьте: systemctl status docker"
        fi
    else
        install_docker
        if docker info >/dev/null 2>&1; then
            DOCKER_READY=1
        else
            docker_problem "Docker установлен, но демон не отвечает"
        fi
    fi
fi

if [ "$DOCKER_READY" = "1" ]; then
    COMPOSE_VER="$(docker compose version --short 2>/dev/null | tr -d 'v' || true)"
    if [ -z "$COMPOSE_VER" ]; then
        docker_problem "нет плагина docker compose (пакет docker-compose-plugin)"
    elif version_ge "$COMPOSE_VER" "$MT_MIN_COMPOSE"; then
        ok "docker compose $COMPOSE_VER"
    else
        docker_problem "docker compose $COMPOSE_VER слишком старый, нужен от $MT_MIN_COMPOSE (install/compose.prod.yml использует тег !override)"
    fi

    # Видит ли docker каталог проекта. После замены snap-Docker выше это
    # почти всегда так, но остаётся экзотика — удалённый контекст, чужой
    # namespace, права: пусть она выясняется здесь, а не при подъёме стека.
    if [ "$PREPARE_ONLY" = "1" ]; then
        docker_sees_repo || warn "Docker не видит файлы в $REPO_DIR — при подъёме стека это станет ошибкой"
    else
        require_docker_sees_repo
    fi
fi

# ==================================================================
step "3. Настройки установки"
# ==================================================================

# Значения из прошлой установки — предлагаем как значения по умолчанию.
PREV_DOMAIN="$(env_get MAIL_DOMAIN)"
PREV_HOST="$(env_get MAIL_HOSTNAME)"
PREV_ADMIN=''
if [ -f "$STATE_FILE" ]; then PREV_ADMIN="$(sed -n 's/^ADMIN_EMAIL=//p' "$STATE_FILE" | tail -1)"; fi

DOMAIN="${MAILTRUE_DOMAIN:-$PREV_DOMAIN}"
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "mail.local" ]; then
    DOMAIN="${MAILTRUE_DOMAIN:-}"
fi
while :; do
    ask DOMAIN "Почтовый домен (то, что после @ в адресах)" "${PREV_DOMAIN:-}"
    is_fqdn "$DOMAIN" && break
    fail "«$DOMAIN» не похоже на доменное имя"
    if [ "$MT_NONINTERACTIVE" = "1" ]; then die "поправьте MAILTRUE_DOMAIN"; fi
    DOMAIN=''
done

MAIL_HOST="${MAILTRUE_HOSTNAME:-$PREV_HOST}"
while :; do
    ask MAIL_HOST "Имя почтового сервера (FQDN, попадёт в HELO и сертификат)" "mail.$DOMAIN"
    is_fqdn "$MAIL_HOST" && break
    fail "«$MAIL_HOST» не похоже на доменное имя"
    if [ "$MT_NONINTERACTIVE" = "1" ]; then die "поправьте MAILTRUE_HOSTNAME"; fi
    MAIL_HOST=''
done

ADMIN_EMAIL="${MAILTRUE_ADMIN_EMAIL:-$PREV_ADMIN}"
while :; do
    ask ADMIN_EMAIL "Адрес администратора" "admin@$DOMAIN"
    if is_email "$ADMIN_EMAIL" && [ "${ADMIN_EMAIL#*@}" = "$DOMAIN" ]; then break; fi
    fail "адрес должен быть вида имя@$DOMAIN"
    if [ "$MT_NONINTERACTIVE" = "1" ]; then die "поправьте MAILTRUE_ADMIN_EMAIL"; fi
    ADMIN_EMAIL=''
done

ADMIN_LOGIN="${MAILTRUE_ADMIN_LOGIN:-${ADMIN_EMAIL%@*}}"

ADMIN_PASSWORD="${MAILTRUE_ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ] && [ "$MT_NONINTERACTIVE" = "1" ]; then
    ADMIN_PASSWORD="$(rand_secret 20)"
    GENERATED_ADMIN_PASSWORD=1
    info "пароль администратора не задан — сгенерирован случайный, он будет показан в конце"
else
    ask_secret ADMIN_PASSWORD "Пароль администратора (ящик и админка), минимум 10 символов"
    GENERATED_ADMIN_PASSWORD=0
fi
[ "${#ADMIN_PASSWORD}" -ge 10 ] || die "пароль администратора короче 10 символов"
# Заглушка из install/answers.example.env длиннее десяти символов и потому
# спокойно проходила проверку длины — установка заканчивалась боевым
# сервером с общеизвестным паролем администратора.
if is_placeholder_password "$ADMIN_PASSWORD"; then
    die "MAILTRUE_ADMIN_PASSWORD — это пароль-заглушка из примера («$ADMIN_PASSWORD»).
Придумайте свой: он открывает и ящик администратора, и админку."
fi
MAILBOX_PASSWORD="${MAILTRUE_MAILBOX_PASSWORD:-$ADMIN_PASSWORD}"
if [ "$MAILBOX_PASSWORD" != "$ADMIN_PASSWORD" ]; then
    [ "${#MAILBOX_PASSWORD}" -ge 10 ] || die "пароль ящика короче 10 символов"
    if is_placeholder_password "$MAILBOX_PASSWORD"; then
        die "MAILTRUE_MAILBOX_PASSWORD — это пароль-заглушка из примера"
    fi
fi

CLAMAV_CHOICE="${MAILTRUE_CLAMAV:-}"
if [ -z "$CLAMAV_CHOICE" ] && [ "$MT_NONINTERACTIVE" != "1" ]; then
    printf '\n'
    info "Антивирус ClamAV проверяет вложения. Честное предупреждение:"
    info "  он держит базы сигнатур в памяти — это около 1 ГБ дополнительно,"
    info "  тогда как весь остальной стек занимает около 310 МБ."
    info "  На машине с 2 ГБ это больше половины памяти. Включать имеет смысл,"
    info "  если памяти 4 ГБ и больше. Включить можно и потом."
fi
ask_yes_no CLAMAV_CHOICE "Включить антивирус ClamAV" "no"
if [ "$CLAMAV_CHOICE" = "yes" ] && [ "$RAM_MB" -lt "$MT_MIN_RAM_CLAMAV_MB" ] && [ "$RAM_MB" -gt 0 ]; then
    warn "памяти ${RAM_MB} МБ, а с антивирусом нужно от ${MT_MIN_RAM_CLAMAV_MB} МБ"
    if ! confirm "Всё равно включить антивирус?"; then
        CLAMAV_CHOICE=no
        info "антивирус выключен; включить позже: MAILTRUE_CLAMAV=yes bash install/install.sh"
    fi
fi

TLS_MODE="${MAILTRUE_TLS:-}"
if [ -z "$TLS_MODE" ]; then
    if [ "$MT_NONINTERACTIVE" = "1" ]; then
        TLS_MODE=letsencrypt
    else
        local_choice=''
        ask_yes_no local_choice "Выпустить сертификат Let's Encrypt (нужно, чтобы домен уже указывал на этот сервер)" "yes"
        [ "$local_choice" = "yes" ] && TLS_MODE=letsencrypt || TLS_MODE=selfsigned
    fi
else
    # Опечатка («letsencript», «self-signed») раньше молча трактовалась как
    # значение по умолчанию: человек просил самоподписанный, получал попытку
    # выпуска Let's Encrypt — или наоборот.
    if ! TLS_MODE="$(normalize_choice "$TLS_MODE" "letsencrypt selfsigned")"; then
        die "непонятное значение MAILTRUE_TLS=«${MAILTRUE_TLS}». Допустимо: letsencrypt или selfsigned"
    fi
fi
LE_EMAIL="${MAILTRUE_LE_EMAIL:-$ADMIN_EMAIL}"
BIND_ADDRESS="${MAILTRUE_BIND_ADDRESS:-0.0.0.0}"

printf '\n'
info "Домен:          $DOMAIN"
info "Сервер:         $MAIL_HOST"
info "Администратор:  $ADMIN_EMAIL (логин в админке: $ADMIN_LOGIN)"
info "Антивирус:      $CLAMAV_CHOICE"
info "Сертификат:     $TLS_MODE"
if [ "$MT_NONINTERACTIVE" != "1" ]; then
    confirm "Всё верно, продолжаем?" || die "установка отменена"
fi

# ==================================================================
step "4. Секреты и конфигурация"
# ==================================================================

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [ ! -f "$ENV_FILE" ]; then
    [ -f "$ENV_EXAMPLE" ] || die "нет образца $ENV_EXAMPLE"
    # Берём образец только ради комментариев; все значения ниже перезаписываются.
    #
    # Копируем через tr, а не cp: образец редактируют в том числе на Windows,
    # и один раз он уже уехал в репозиторий с концами строк CRLF. Такой .env
    # ломает установку самым неприятным из возможных способов — молча:
    # docker compose «\r» отбрасывает и контейнеры работают, а bash его
    # сохраняет, и POSTGRES_USER в скриптах становится «mailserver» с
    # невидимым хвостом. Дальше psql отвечает «role does not exist» на
    # каждую миграцию при исправной базе.
    tr -d '\r' < "$ENV_EXAMPLE" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "создан $ENV_FILE"
else
    # Одна резервная копия, а не по одной на каждый запуск: в файле пароли,
    # и плодить их копии по каталогу — плохая идея.
    cp "$ENV_FILE" "$ENV_FILE.bak"
    chmod 600 "$ENV_FILE.bak"
    ok "найден существующий $ENV_FILE (прежний сохранён в .env.bak)"
fi

env_set MAIL_DOMAIN   "$DOMAIN"
env_set MAIL_HOSTNAME "$MAIL_HOST"
env_set BIND_ADDRESS  "$BIND_ADDRESS"

# Секреты: генерируются один раз и при повторной установке не меняются —
# иначе пароль в .env разъехался бы с паролем внутри уже созданной базы.
#
# QUEUE_AGENT_TOKEN и SERVICE_AGENT_TOKEN стоят в этом списке не для красоты. В infra/.env.example
# он ПУСТОЙ, а пустое значение означает «посредника к очереди Postfix не
# запускать вовсе» (infra/postfix/entrypoint.sh) и «раздел „Очередь“ в панели
# недоступен». Установщик копирует образец как есть и раньше этот ключ не
# трогал — значит на КАЖДОЙ установке с нуля целый раздел панели молча
# отсутствовал, и узнать, что его надо включить руками, было неоткуда.
NEW_SECRETS=0
for pair in \
    "POSTGRES_PASSWORD:32" \
    "REDIS_PASSWORD:32" \
    "RSPAMD_PASSWORD:24" \
    "DOVECOT_MASTER_PASSWORD:32" \
    "AI_ENCRYPTION_KEY:48" \
    "SESSION_SECRET:48" \
    "ADMIN_SESSION_SECRET:48" \
    "EXTERNAL_ACCOUNTS_KEY:48" \
    "QUEUE_AGENT_TOKEN:64" \
    "SERVICE_AGENT_TOKEN:64"
do
    key="${pair%%:*}"; len="${pair##*:}"
    current="$(env_get "$key")"
    case "$current" in
        ''|change-me*|смените*)
            env_set "$key" "$(rand_secret "$len")"
            NEW_SECRETS=$((NEW_SECRETS + 1)) ;;
    esac
done
if [ "$NEW_SECRETS" -gt 0 ]; then
    ok "сгенерировано случайных секретов: $NEW_SECRETS"
else
    ok "секреты уже были сгенерированы — оставлены как есть"
fi

# Значения, обязательные для боевой установки
env_ensure POSTGRES_DB          mailserver || true
env_ensure POSTGRES_USER        mailserver || true
env_ensure DKIM_SELECTOR        mail       || true
env_ensure DOVECOT_MASTER_USER  mtadmin    || true
# ------------------------------------------------------------------
# Публикуемые порты.
#
# По умолчанию — стандартные, и менять их на боевом сервере не нужно:
# чужие почтовые серверы стучатся в 25-й, почтовые программы — в 587/993,
# и наша же автонастройка называет им именно эти номера.
#
# Но значения ЖЁСТКО зашитыми быть не могут: на машине, где уже стоит
# один стенд, второй не поднимется вовсе — docker откажет «port is already
# allocated». Раньше единственным выходом было править infra/.env после
# установщика и поднимать стек заново руками, потому что установщик
# переписывал порты при каждом запуске. Теперь любой из них можно задать
# заранее (MAILTRUE_SMTP_PORT и т.д.) — этим и пользуется веб-установщик,
# у которого есть шаг «Порты».
# ------------------------------------------------------------------
env_set POSTGRES_PORT   "${MAILTRUE_POSTGRES_PORT:-5432}"
env_set REDIS_PORT      "${MAILTRUE_REDIS_PORT:-6379}"
env_set SMTP_PORT       "${MAILTRUE_SMTP_PORT:-25}"
env_set SUBMISSION_PORT "${MAILTRUE_SUBMISSION_PORT:-587}"
env_set SUBMISSIONS_PORT "${MAILTRUE_SUBMISSIONS_PORT:-465}"
env_set IMAP_PORT       "${MAILTRUE_IMAP_PORT:-143}"
env_set IMAPS_PORT      "${MAILTRUE_IMAPS_PORT:-993}"
env_set POP3_PORT       "${MAILTRUE_POP3_PORT:-110}"
env_set POP3S_PORT      "${MAILTRUE_POP3S_PORT:-995}"
env_set AUTOCONFIG_PORT "${MAILTRUE_AUTOCONFIG_PORT:-8025}"
env_set NGINX_HTTP_PORT "${MAILTRUE_NGINX_HTTP_PORT:-80}"
env_set NGINX_HTTPS_PORT "${MAILTRUE_NGINX_HTTPS_PORT:-443}"

# ------------------------------------------------------------------
# Резервный вход в панель: адрес, на котором его слушать.
#
# Панель отвечает только на имя admin.<домен>. Пока DNS не разошёлся — а
# на внутреннем домене он не разойдётся никогда — управлять сервером
# нечем. Поэтому есть второй вход по адресу, и здесь решается, кому он
# виден.
#
# Берём ЛОКАЛЬНЫЙ адрес сервера (192.168.x, 10.x, 172.16–31.x), если он
# есть: почти всегда админ сидит в той же сети, и вход должен работать
# сразу. Нет частного адреса (машина смотрит в интернет напрямую) —
# оставляем 127.0.0.1: снаружи такой порт недоступен вовсе, а зайти можно
# пробросом через SSH. Открывать управление сервером в интернет по
# умолчанию нельзя ни при каких удобствах.
# ------------------------------------------------------------------
ADMIN_LOCAL_BIND="${MAILTRUE_ADMIN_LOCAL_BIND:-}"
if [ -z "$ADMIN_LOCAL_BIND" ]; then
    ADMIN_LOCAL_BIND="$(private_ip)"
    ADMIN_LOCAL_BIND="${ADMIN_LOCAL_BIND:-127.0.0.1}"
fi
env_set ADMIN_LOCAL_BIND "$ADMIN_LOCAL_BIND"
env_set ADMIN_LOCAL_PORT "${MAILTRUE_ADMIN_LOCAL_PORT:-8081}"
env_set API_LOG_LEVEL info
# Веб-интерфейс: cookie сессии отдаётся только по HTTPS. Отладочный порт
# сервера приложения наружу не публикуется (install/compose.prod.yml).
env_set COOKIE_SECURE true
env_set TLS_REJECT_UNAUTHORIZED false
env_set UNBOUND_LOG_QUERIES no

# ------------------------------------------------------------------
# Подсеть стека и фиксированные адреса в ней.
#
# Подсеть меняют не от скуки: 172.28.0.0/16 бывает занята VPN или другим
# хозяйством машины. Но адресов внутри неё ДВА — свой резольвер и Dovecot
# (Postfix отдаёт почту по адресу, а не по имени), — и оба задаются
# отдельными ключами. Поменяв одну подсеть, человек получал отказ docker:
#   «no configured subnet contains IP address 172.28.0.54»
# Ни имени файла, ни имени настройки в этом сообщении нет, а стек при этом
# не поднимается вовсе. Проверяем согласованность здесь и говорим словами.
# ------------------------------------------------------------------
STACK_SUBNET="$(env_get DOCKER_SUBNET)"
if [ -n "$STACK_SUBNET" ]; then
    for ip_key in RESOLVER_IP DOVECOT_IP; do
        ip_value="$(env_get "$ip_key")"
        [ -n "$ip_value" ] || continue
        subnet_contains "$STACK_SUBNET" "$ip_value" || die \
"$ip_key=$ip_value не входит в DOCKER_SUBNET=$STACK_SUBNET.
       Поправьте $ENV_FILE: подсеть и адреса внутри неё (RESOLVER_IP, DOVECOT_IP)
       меняются только вместе, иначе стек не поднимется вовсе."
    done
    ok "подсеть стека и адреса внутри неё согласованы ($STACK_SUBNET)"
fi

# ------------------------------------------------------------------
# Публичный адрес сервера.
#
# По нему панель проверяет обратную запись (PTR) — ту самую, без которой
# крупные почтовые службы отбивают письма ещё на подключении. Раньше эта
# переменная не выставлялась НИКОГДА, и проверка PTR в админке навсегда
# оставалась в состоянии «неизвестно»: она честно не могла узнать, какой
# у сервера адрес.
#
# Спрашиваем внешнюю службу, а не смотрим на свои интерфейсы: за NAT
# локальный адрес не имеет отношения к тому, с которого сервер виден миру,
# а PTR заводится именно на видимый.
#
# Если спросить не удалось — оставляем пустым и говорим об этом. Записать
# сюда локальный адрес было бы хуже пустоты: проверка PTR уверенно ругалась
# бы на верную настройку.
if [ -z "${MAIL_PUBLIC_IPV4:-}" ]; then
    PUBLIC_IP=""
    for probe in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
        candidate="$(curl -fsS --max-time 5 "$probe" 2>/dev/null | tr -d '[:space:]')" || true
        # Простая проверка формы: четыре числа через точку. Строгую разбирает
        # уже сама панель — здесь важно не записать в настройку HTML страницы
        # ошибки, который иные службы отдают вместо адреса.
        case "$candidate" in
            [0-9]*.[0-9]*.[0-9]*.[0-9]*) PUBLIC_IP="$candidate"; break ;;
        esac
    done
else
    PUBLIC_IP="$MAIL_PUBLIC_IPV4"
fi

env_set MAIL_PUBLIC_IPV4 "$PUBLIC_IP"
if [ -n "$PUBLIC_IP" ]; then
    ok "публичный адрес сервера: $PUBLIC_IP (по нему проверяется обратная запись PTR)"
else
    warn "не удалось определить публичный адрес сервера — проверка обратной записи PTR"
    hint "  будет опираться на A-запись почтового хоста. Чтобы задать точно:"
    hint "  впишите MAIL_PUBLIC_IPV4=<адрес> в $ENV_FILE и перезапустите api"
fi
env_set CLAMAV_ENABLED "$([ "$CLAMAV_CHOICE" = yes ] && echo true || echo false)"

ok "конфигурация записана в $ENV_FILE (права 600)"

cat > "$STATE_FILE" <<EOF
# Состояние установки Mail.True. Пишется install.sh, читают остальные скрипты.
INSTALLED_AT=$(date -Iseconds)
MAIL_DOMAIN=$DOMAIN
MAIL_HOSTNAME=$MAIL_HOST
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_LOGIN=$ADMIN_LOGIN
CLAMAV=$CLAMAV_CHOICE
TLS_MODE=$TLS_MODE
LE_EMAIL=$LE_EMAIL
BIND_ADDRESS=$BIND_ADDRESS
REPO_DIR=$REPO_DIR
EOF
chmod 600 "$STATE_FILE"

load_env

# ==================================================================
step "5. TLS-сертификат (временный)"
# ==================================================================
# Стек не поднимется без файлов сертификата, а Let's Encrypt нельзя выпустить
# до того, как заработает HTTP. Поэтому сначала — самоподписанный,
# потом заменяем его настоящим.

mkdir -p "$CERT_DIR"

# ------------------------------------------------------------------
# Каталог сертификатов доступен на запись серверу приложения (uid 5000,
# тот же, что у почтового хранилища).
#
# Это нужно разделу «Сертификат» в панели: замена сертификата на живом
# сервере не должна требовать доступа по SSH. Сокета Docker серверу
# приложения при этом не дают — он равен правам root на всей машине;
# службы перечитывают файл сами (infra/nginx/watch-certs.sh и entrypoint
# почтовых служб).
#
# Права самих ФАЙЛОВ не меняются: mail.crt читаем всем, mail.key — только
# владельцу. Открывается ровно каталог, и ровно одному пользователю.
# ------------------------------------------------------------------
if chgrp 5000 "$CERT_DIR" 2>/dev/null && chmod 2775 "$CERT_DIR" 2>/dev/null; then
    ok "каталог сертификатов открыт панели на запись (замена сертификата без SSH)"
else
    warn "не удалось открыть каталог сертификатов серверу приложения"
    hint "раздел «Сертификат» в панели сможет только показывать, но не менять"
    hint "поправить: chgrp 5000 $CERT_DIR && chmod 2775 $CERT_DIR"
fi

# Откуда взялся сертификат. Файлом рядом с ним, а не ключом в infra/.env:
# писать сюда должен и сервер приложения (у него нет доступа к .env), а
# читать — и install/renew-certs.sh на хосте, и мастер первого запуска.
CERT_SOURCE_FILE="$CERT_DIR/source"
# Читаем ТОЛЬКО существующий файл, и без конвейера.
#
# Было: CERT_SOURCE="$(cat "$CERT_SOURCE_FILE" 2>/dev/null | tr -d ...)".
# На чистом сервере файла ещё нет, `cat` возвращает единицу, `pipefail`
# тянет её в подстановку, и `set -e` обрывает установку — молча, без
# единого слова об ошибке: последнее, что видел человек, была строка про
# каталог сертификатов, а дальше «прервалось, код 1». У нас это не
# всплывало годами, потому что на стенде файл source давно существовал.
CERT_SOURCE=''
if [ -f "$CERT_SOURCE_FILE" ]; then
    CERT_SOURCE="$(tr -d '[:space:]' < "$CERT_SOURCE_FILE" 2>/dev/null || true)"
fi

if [ -f "$CERT_DIR/mail.crt" ] && [ -f "$CERT_DIR/mail.key" ]; then
    CERT_CN="$(openssl x509 -in "$CERT_DIR/mail.crt" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p')"
    ok "сертификат уже есть (CN=${CERT_CN:-?})"
else
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$CERT_DIR/mail.key" -out "$CERT_DIR/mail.crt" \
        -subj "/CN=$MAIL_HOST/O=Mail.True" \
        -addext "subjectAltName=DNS:$MAIL_HOST,DNS:$DOMAIN,DNS:mail.$DOMAIN,DNS:admin.$DOMAIN,DNS:autoconfig.$DOMAIN,DNS:autodiscover.$DOMAIN" \
        >/dev/null 2>&1 || die "не удалось сгенерировать самоподписанный сертификат"
    chmod 644 "$CERT_DIR/mail.crt"; chmod 600 "$CERT_DIR/mail.key"
    ok "самоподписанный сертификат создан (CN=$MAIL_HOST)"
    CERT_SOURCE=selfsigned
    printf 'selfsigned\n' > "$CERT_SOURCE_FILE"
fi

# ------------------------------------------------------------------
# Свой сертификат уважается и переустановкой.
#
# Если в панели поставили свой сертификат (или его положили сюда руками
# и отметили файлом source), повторный запуск установщика НЕ пытается
# выпустить Let's Encrypt поверх: продление стёрло бы чужой сертификат
# молча, и узналось бы это по звонку «Outlook ругается».
#
# Настоять на возврате к Let's Encrypt можно явно: MAILTRUE_TLS=letsencrypt.
# ------------------------------------------------------------------
if [ "$CERT_SOURCE" = "custom" ] && [ -z "${MAILTRUE_TLS:-}" ]; then
    info "на сервере стоит свой сертификат — оставляем его"
    hint "вернуться к Let's Encrypt: MAILTRUE_TLS=letsencrypt sudo bash install/install.sh"
    TLS_MODE=custom
fi
if [ -z "$CERT_SOURCE" ]; then
    # Сертификат уже лежал, а отметки не было: так выглядит сервер,
    # установленный до появления раздела «Сертификат».
    printf '%s\n' "$TLS_MODE" > "$CERT_SOURCE_FILE"
fi
chmod 644 "$CERT_SOURCE_FILE" 2>/dev/null || true

if [ "$PREPARE_ONLY" = "1" ]; then
    step "Готово (режим --prepare-only)"
    info "конфигурация подготовлена, стек не поднимался."
    info "Поднять: docker compose -f infra/docker-compose.yml -f install/compose.prod.yml up -d"
    exit 0
fi

# ==================================================================
step "6. Сборка и запуск стека"
# ==================================================================

# ------------------------------------------------------------------
# Сначала ОДНА база — и сразу схема, до всего остального.
#
# Раньше здесь поднимался весь стек, а миграции применялись шагом ниже.
# При установке с нуля разницы нет: Postgres сам выполняет каталог миграций
# при создании пустого тома. А вот при ОБНОВЛЕНИИ порядок был обратный
# нужному: новый код сервера приложения запускался против СТАРОЙ схемы и
# работал так до четверти часа (столько отведено на сборку образов и подъём).
# Всё это время планировщики нового кода — отложенная отправка, отложенные
# письма, сбор контактов, сбор показателей — обращались к таблицам, которых
# ещё нет. Процесс от этого не падает (стоят перехватчики), но каждое такое
# обращение — потерянный тик планировщика: письмо, которое должно было уйти
# по расписанию, в этот тик не ушло.
#
# База поднимается отдельно и раньше: это дёшево (образ postgres не
# собирается) и снимает окно рассогласования целиком.
# ------------------------------------------------------------------
dc up -d postgres || die "не удалось поднять базу данных (подробности: docker compose logs postgres)"
if ! wait_healthy 180 postgres; then
    printf '\n'
    dc logs --tail=30 postgres 2>&1 | tail -30
    die "база данных не поднялась (журнал выше)"
fi
printf '\r%-72s\r' ' '
ok "база данных поднята"

# Postgres сам выполняет содержимое каталога миграций, но только при создании
# базы на пустом томе. На уже существующей базе — то есть при обновлении —
# применяем их сами.
#
# Перебираем каталог, а не список в коде. Раньше здесь был зашитый перечень
# «0003 и 0004», в него забыли внести появившуюся позже миграцию настроек и
# внешних ящиков. При установке с нуля это не проявлялось, а при обновлении
# таблицы не создавались, и настройки с фильтрами переставали работать.
# Список в коде всегда отстаёт от каталога — поэтому его здесь больше нет.
#
# Что именно применять, решает журнал schema_migrations: раньше применялся
# ВЕСЬ каталог при каждом запуске, и содержательные миграции (0008 переписывает
# историю доставки) выполнялись заново на каждом обновлении. Подробности —
# в apply_migrations (install/lib/common.sh) и в миграции 0000.
apply_migrations "install.sh" || true
MIG_FAILED="$MT_MIG_FAILED"

# Непринятая миграция — это отсутствующая таблица или колонка. Ничего не
# «сломается» громко: стек поднимется, почта пойдёт, а разделы панели,
# которым нужна новая таблица, будут отвечать ошибкой каждому, кто их
# откроет. Раньше установщик в этом случае печатал предупреждение среди
# сотни строк вывода и заканчивался словом «Готово» с кодом 0 — то есть
# сообщал об успехе установки с неполной схемой. Отказываемся явно:
# install.sh идемпотентен, повторный запуск после починки ничего не портит.
#
# Отказ ДО сборки образов важен отдельно: на обновлении это значит, что
# работающий сервер остался на прежнем коде и прежней схеме — то есть
# продолжает работать, а не превращается в новый код поверх старой базы.
if [ -n "$MIG_FAILED" ]; then
    printf '\n'
    printf '  Схема базы применена НЕ ПОЛНОСТЬЮ:%s\n' "$MIG_FAILED"
    printf '  Часть разделов панели будет отвечать ошибкой, пока это не исправлено.\n'
    printf '  Применить вручную и посмотреть полную ошибку:\n\n'
    printf '    docker compose -f infra/docker-compose.yml exec -T postgres \\\n'
    printf '      psql -v ON_ERROR_STOP=1 -U %s -d %s \\\n' "$POSTGRES_USER" "$POSTGRES_DB"
    printf '      < infra/postgres/migrations/<файл>\n\n'
    die "установка остановлена: база не соответствует версии продукта"
fi

info "первый запуск собирает образы почтового стека и веб-интерфейса — это 5–15 минут"
dc up -d --build || die "не удалось поднять стек (подробности: docker compose logs)"
ok "контейнеры запущены"

CORE_SERVICES=(postgres redis unbound dovecot rspamd postfix autoconfig api web admin nginx)
if wait_healthy 420 "${CORE_SERVICES[@]}"; then
    printf '\r%-72s\r' ' '
    ok "все сервисы здоровы"
else
    printf '\n'
    dc ps
    # Показываем хвост журнала каждого нездорового сервиса: без этого
    # человеку остаётся только гадать, что именно не поднялось.
    for svc in "${CORE_SERVICES[@]}"; do
        state="$(service_state "$svc")"
        case "$state" in
            # «unhealthy» содержит «healthy»: без этой ветки журнал
            # пропускался ровно у той службы, ради которой его и показывают.
            *unhealthy*) : ;;
            *healthy*) continue ;;
        esac
        printf '\n--- журнал %s (последние строки) ---\n' "$svc"
        dc logs --tail=15 "$svc" 2>&1 | tail -15
    done
    die "часть сервисов не поднялась (журналы выше)"
fi

# ==================================================================
step "7. Домен и администратор"
# ==================================================================
# Схема базы уже применена шагом выше — до сборки образов, чтобы новый код
# никогда не запускался против старой схемы.

# Выполнить SQL со stdin в контейнере postgres.
psql_run() {
    dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA
}

# Домен
if printf "INSERT INTO virtual_domains (name) VALUES ('%s') ON CONFLICT (name) DO NOTHING;\n" "$DOMAIN" \
        | psql_run >/dev/null; then
    ok "домен $DOMAIN есть в базе"
else
    fail "не удалось добавить домен $DOMAIN в базу"
fi

# Ящик администратора
if bash "$INFRA_DIR/scripts/create-mailbox.sh" "$ADMIN_EMAIL" "$MAILBOX_PASSWORD" >/dev/null 2>&1; then
    ok "ящик $ADMIN_EMAIL создан (или обновлён пароль)"
else
    fail "не удалось создать ящик $ADMIN_EMAIL"
fi

# Служебные адреса по RFC 2142: postmaster обязателен, abuse ожидают все
for alias_name in postmaster abuse; do
    printf "INSERT INTO virtual_aliases (domain_id, source, destination)
            SELECT id, '%s@%s', '%s' FROM virtual_domains WHERE name = '%s'
            ON CONFLICT (source, destination) DO NOTHING;\n" \
        "$alias_name" "$DOMAIN" "$ADMIN_EMAIL" "$DOMAIN" | psql_run >/dev/null || true
done
ok "алиасы postmaster@$DOMAIN и abuse@$DOMAIN ведут на $ADMIN_EMAIL"

# Учётная запись администратора в админке.
# Хэш считает node внутри контейнера autoconfig — тот же алгоритм, что в
# apps/api/src/admin/passwords.ts (scrypt$N$r$p$соль$ключ, base64url).
# Пароль передаём через stdin, чтобы он не попал в список процессов.
ADMIN_HASH="$(printf '%s' "$ADMIN_PASSWORD" | dc exec -T autoconfig node -e '
let pw = "";
process.stdin.on("data", (c) => { pw += c; });
process.stdin.on("end", () => {
  const { randomBytes, scryptSync } = require("node:crypto");
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  const key = scryptSync(pw.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  process.stdout.write(["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$"));
});' | tr -d '\r\n')"

if [ -z "$ADMIN_HASH" ]; then
    fail "не удалось посчитать хэш пароля администратора"
else
    # Переменные раскрываются внутри контейнера, поэтому кавычки одинарные.
    # shellcheck disable=SC2016
    CREATED="$(dc exec -T -e A_LOGIN="$ADMIN_LOGIN" -e A_HASH="$ADMIN_HASH" -e A_NAME="$ADMIN_EMAIL" postgres \
        sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
               -v login="$A_LOGIN" -v hash="$A_HASH" -v name="$A_NAME"' <<'SQL' || true
INSERT INTO admin_users (login, password_hash, display_name, role)
VALUES (:'login', :'hash', :'name', 'owner')
ON CONFLICT (login) DO NOTHING
RETURNING login;
SQL
)"
    if [ -n "$CREATED" ]; then
        ok "администратор «$ADMIN_LOGIN» создан (роль owner)"
    else
        ok "администратор «$ADMIN_LOGIN» уже существовал — пароль не менялся"
        hint "сменить пароль: см. docs/install.md, раздел «Обслуживание»"
    fi
fi

# ==================================================================
step "8. Настоящий TLS-сертификат"
# ==================================================================

issue_letsencrypt() {
    local names=("$MAIL_HOST")
    if [ "$MAIL_HOST" != "$DOMAIN" ]; then names+=("$DOMAIN"); fi
    # mail.<домен> и admin.<домен> — веб-интерфейс почты и админка.
    # В сертификат попадут только те имена, чья запись уже указывает на
    # этот сервер: из-за одного неопубликованного имени Let's Encrypt
    # отказал бы во всём выпуске целиком.
    names+=("mail.$DOMAIN" "admin.$DOMAIN" "autoconfig.$DOMAIN" "autodiscover.$DOMAIN")

    local server_ip resolved matched=0 name
    server_ip="$(public_ip)"
    info "внешний адрес сервера: ${server_ip:-не определён}"

    # Выпуск не начнётся, пока имя не указывает на нас: Let's Encrypt
    # проверяет владение через HTTP-запрос по этому имени.
    local reachable=()
    for name in "${names[@]}"; do
        resolved="$(resolve_a "$name" | tr '\n' ' ')"
        if [ -z "$resolved" ]; then
            warn "$name — A-записи нет, имя в сертификат не попадёт"
            continue
        fi
        if [ -n "$server_ip" ] && printf '%s' "$resolved" | grep -qw "$server_ip"; then
            ok "$name → $resolved (это мы)"
            reachable+=("$name"); matched=1
        else
            warn "$name → $resolved, а сервер имеет адрес ${server_ip:-?}"
        fi
    done
    if [ "$matched" = "0" ]; then
        fail "ни одно имя не указывает на этот сервер — Let's Encrypt откажет"
        hint "Опубликуйте A-запись $MAIL_HOST → ${server_ip:-<адрес сервера>}"
        hint "и CNAME mail.$DOMAIN, admin.$DOMAIN, autoconfig.$DOMAIN,"
        hint "autodiscover.$DOMAIN → $MAIL_HOST"
        hint "Затем повторите: sudo bash install/install.sh"
        return 1
    fi

    if ! have certbot; then
        info "устанавливаем certbot"
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot >/dev/null 2>&1 \
            || { warn "не удалось установить certbot"; return 1; }
    fi

    # Certbot слушает 80-й сам, поэтому nginx на время выпуска останавливаем.
    # Останавливается только веб-вход автонастройки; почта продолжает ходить.
    local args=(certonly --standalone --non-interactive --agree-tos
                --email "$LE_EMAIL" --cert-name mailtrue --keep-until-expiring)
    for name in "${reachable[@]}"; do args+=(-d "$name"); done

    info "останавливаем nginx на время проверки (почта не прерывается)"
    dc stop nginx >/dev/null 2>&1 || true
    local rc=0
    certbot "${args[@]}" || rc=$?
    dc start nginx >/dev/null 2>&1 || true
    if [ "$rc" -ne 0 ]; then
        warn "Let's Encrypt не выпустил сертификат (код $rc)"
        hint "подробности: /var/log/letsencrypt/letsencrypt.log"
        hint "остаётся самоподписанный сертификат; повторить можно так:"
        hint "  sudo bash install/renew-certs.sh --force"
        return 1
    fi
    # MT_RENEW_TRIGGER=install — чтобы в отчёте о продлении первая запись
    # честно называлась установкой, а не «запуском руками»: иначе панель
    # на свежем сервере показывала бы «последний раз продление запускали
    # вручную», чего никто не делал.
    MT_RENEW_TRIGGER=install bash "$INSTALL_DIR/renew-certs.sh" --deploy-only || return 1
    return 0
}

if [ "$TLS_MODE" = "custom" ]; then
    info "на сервере стоит свой сертификат — установщик его не трогает"
    info "заменить: раздел «Сертификат» в панели управления"
elif [ "$TLS_MODE" = "letsencrypt" ]; then
    if issue_letsencrypt; then
        ok "сертификат Let's Encrypt выпущен и установлен"
        printf 'letsencrypt\n' > "$CERT_SOURCE_FILE"
        # Автопродление: сертификат живёт 90 дней, продлевать надо заранее.
        # Сам таймер заводит install_cert_timer (lib/common.sh) — он же
        # нужен renew-certs.sh --install-timer после установки из браузера,
        # где systemd хоста контейнеру недоступен.
        if install_cert_timer "$INSTALL_DIR"; then
            ok "автопродление сертификата включено (systemd-таймер)"
        elif have systemctl; then
            warn "не удалось включить таймер продления"
        else
            warn "systemd недоступен — продление сертификата придётся запускать самому"
            hint "на хосте: sudo bash $INSTALL_DIR/renew-certs.sh --install-timer"
            hint "либо в cron: 17 3 * * * /bin/bash $INSTALL_DIR/renew-certs.sh"
        fi
        # Состояние автопродления — в отчёт, сразу. Три ветки выше кончаются
        # по-разному, а панель обязана показать итог любой из них: молчание
        # про невключившийся таймер и есть тот самый молчаливый отказ, из-за
        # которого сертификаты истекают.
        renew_report_refresh || warn "не удалось записать отчёт о продлении: $(renew_report_path)"
    else
        warn "работаем с самоподписанным сертификатом"
        hint "почта ходит, но клиенты будут ругаться на сертификат,"
        hint "а Outlook откажется настраиваться автоматически"
        renew_report_write install issue failed '' 0 \
            "Let's Encrypt не выпустил сертификат при установке — на сервере остался самоподписанный. Повторить: sudo bash install/renew-certs.sh --force" \
            || true
    fi
else
    info "выбран самоподписанный сертификат (MAILTRUE_TLS=selfsigned)"
fi

# ==================================================================
step "9. DNS-записи для публикации"
# ==================================================================

DNS_OUT="$STATE_DIR/dns-records.txt"
SERVER_IP="$(public_ip)"

{
    printf '; ------------------------------------------------------------\n'
    printf '; DNS-записи Mail.True для домена %s\n' "$DOMAIN"
    printf '; Сформировано %s\n' "$(date -Iseconds)"
    printf '; ------------------------------------------------------------\n'
    printf '%-24s %-6s %s\n' "$MAIL_HOST." "A" "${SERVER_IP:-<адрес сервера>}"
} > "$DNS_OUT"

if dc exec -T autoconfig node -e "
fetch('http://127.0.0.1:8080/api/dns-records?domain=' + encodeURIComponent('$DOMAIN'))
  .then((r) => r.json())
  .then((j) => { process.stdout.write(j.zoneFile); })
  .catch((e) => { process.stderr.write(String(e)); process.exit(1); });
" >> "$DNS_OUT" 2>/dev/null; then
    ok "записи получены от сервиса автонастройки"
else
    warn "сервис автонастройки не ответил — записи придётся взять позже"
    hint "curl 'http://127.0.0.1:8025/api/dns-records?domain=$DOMAIN'"
fi

cat >> "$DNS_OUT" <<EOF

; Веб-интерфейс. Почта открывается и на самом домене, и на mail.<домен>;
; админка живёт на отдельном имени — её удобно закрыть отдельно от почты.
$(printf '%-24s %-6s %s' "mail.$DOMAIN." "CNAME" "$MAIL_HOST.")
$(printf '%-24s %-6s %s' "admin.$DOMAIN." "CNAME" "$MAIL_HOST.")
; Если у корневого домена ещё нет A-записи, добавьте и её — тогда почта
; будет открываться просто по адресу https://$DOMAIN
$(printf '%-24s %-6s %s' "$DOMAIN." "A" "${SERVER_IP:-<адрес сервера>}")

; Обратная зона (PTR) настраивается НЕ здесь, а в панели хостинга:
;   ${SERVER_IP:-<адрес сервера>}  PTR  $MAIL_HOST.
; Без PTR крупные почтовые службы (Google, Mail.ru, Яндекс) отклоняют письма.
EOF

printf '\n'
cat "$DNS_OUT"
printf '\n'
info "эти же записи сохранены в $DNS_OUT"

# ==================================================================
step "Отметка «установлено»"
# ==================================================================
# Ставится ПОСЛЕДНИМ шагом и только здесь: до этой строки могли не
# примениться миграции, не подняться сервисы, не создаться ящик — и
# отметка «установлено» на таком сервере была бы ложью.
#
# Отметок две, и это не дублирование. INSTALL_COMPLETED_AT лежит в
# infra/.env — рядом с каталогом проекта, который можно потерять или
# развернуть заново поверх СТАРЫХ томов с почтой. Строка в install_state
# лежит в самой базе, то есть ровно там, где живёт то, что переустановка
# способна испортить. Веб-установщик считает сервер установленным, если
# нашёл ЛЮБУЮ из них.
#
# Снимаются обе одной осознанной командой: install/allow-reinstall.sh
env_set INSTALL_COMPLETED_AT "$(date -Iseconds)"

if printf "INSERT INTO install_state (id, completed_at, installed_by, mail_domain, mail_hostname, admin_login)
           VALUES (true, now(), '%s', '%s', '%s', '%s')
           ON CONFLICT (id) DO UPDATE
              SET completed_at = now(), installed_by = EXCLUDED.installed_by,
                  mail_domain = EXCLUDED.mail_domain,
                  mail_hostname = EXCLUDED.mail_hostname,
                  admin_login = EXCLUDED.admin_login;\n" \
        "${MT_INSTALL_SOURCE:-install.sh}" "$DOMAIN" "$MAIL_HOST" "$ADMIN_LOGIN" | psql_run >/dev/null 2>&1; then
    ok "сервер отмечен как установленный (infra/.env и таблица install_state)"
else
    # Не повод ронять установку: почта уже работает. Но молчать нельзя —
    # без отметки в базе веб-установщик, поднятый на этом сервере после
    # потери infra/.env, счёл бы его чистым.
    warn "отметка в базе не поставлена (таблица install_state недоступна)"
    hint "проверьте: bash install/selfcheck.sh — и повторите установку, она идемпотентна"
fi

# ==================================================================
step "Установка завершена"
# ==================================================================
MEM_USED="$(dc ps -q 2>/dev/null | xargs -r docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | \
    sed 's#/.*##' | awk '{ u=$0; gsub(/[A-Za-z]/,"",u);
        if ($0 ~ /GiB/) s += u*1024; else if ($0 ~ /MiB/) s += u; else if ($0 ~ /KiB/) s += u/1024 }
        END { printf "%d", s }' || echo '')"


# Схема адресов: с настоящим сертификатом — https, с самоподписанным
# браузер всё равно будет ругаться, но открывать надо тоже по https.
WEB_SCHEME=https

cat <<EOF

  ── Куда заходить ─────────────────────────────────────────────

  Почта:    $WEB_SCHEME://mail.$DOMAIN   (и $WEB_SCHEME://$DOMAIN)
            логин — полный адрес ящика: $ADMIN_EMAIL
            пароль — тот же, что у администратора

  Панель:   $WEB_SCHEME://admin.$DOMAIN
            логин — $ADMIN_LOGIN
EOF
if [ "${GENERATED_ADMIN_PASSWORD:-0}" != "1" ]; then
    printf '            пароль — тот, что вы задали при установке\n'
fi
cat <<EOF

  Почтовый сервер:   $MAIL_HOST
  Домен:             $DOMAIN
EOF

# ------------------------------------------------------------------
# Резервный вход и строка для hosts.
#
# Оба пункта — про один и тот же час после установки: DNS ещё не
# разошёлся (а на внутреннем домене не разойдётся вовсе), и по именам
# ничего не открывается. Человек в этот момент видит работающий сервер,
# в который не может войти, — и идёт искать, что сломалось.
# ------------------------------------------------------------------
ADMIN_BIND="$(env_get ADMIN_LOCAL_BIND)"
ADMIN_LPORT="$(env_get ADMIN_LOCAL_PORT)"
if [ -n "$ADMIN_BIND" ] && [ "$ADMIN_BIND" != "127.0.0.1" ]; then
cat <<EOF

  Панель без DNS:    https://$ADMIN_BIND:${ADMIN_LPORT:-8081}/
                     (отвечает только машинам из локальной сети)
EOF
elif [ -n "$ADMIN_BIND" ]; then
cat <<EOF

  Панель без DNS:    https://127.0.0.1:${ADMIN_LPORT:-8081}/ — только с самого сервера.
                     Со своей машины: ssh -L ${ADMIN_LPORT:-8081}:127.0.0.1:${ADMIN_LPORT:-8081} $(whoami)@${SERVER_IP:-<IP>}
                     и открыть https://127.0.0.1:${ADMIN_LPORT:-8081}/
EOF
fi

cat <<EOF

  Пока DNS-записи не разошлись, имена можно прописать у себя.
  Windows: C:\\Windows\\System32\\drivers\\etc\\hosts, Linux и macOS: /etc/hosts

    ${SERVER_IP:-<IP сервера>}  $DOMAIN mail.$DOMAIN admin.$DOMAIN autoconfig.$DOMAIN
EOF
if [ "${GENERATED_ADMIN_PASSWORD:-0}" = "1" ]; then
cat <<EOF
  Пароль:            $ADMIN_PASSWORD
                     ^ сгенерирован случайно, сохраните его сейчас
EOF
fi
if [ "${MEM_USED:-0}" -gt 0 ] 2>/dev/null; then
    printf '  Память стека:      %s МБ\n' "$MEM_USED"
fi

cat <<EOF

  Что делать дальше:
    1. Опубликовать DNS-записи (выше, они же в $DNS_OUT).
       Веб-интерфейс откроется, как только разойдутся записи
       mail.$DOMAIN и admin.$DOMAIN
    2. Попросить хостера сделать PTR: ${SERVER_IP:-<IP>} → $MAIL_HOST
    3. Через 10–15 минут (пока расходится DNS) проверить установку:
         sudo bash install/selfcheck.sh
    4. Открыть почту: $WEB_SCHEME://mail.$DOMAIN
       Логин — полный адрес ящика ($ADMIN_EMAIL) и его пароль.
       Админка: $WEB_SCHEME://admin.$DOMAIN, логин «$ADMIN_LOGIN»
    5. Резервные копии:
         sudo bash install/backup.sh

  Полезное:
    состояние     docker compose -f infra/docker-compose.yml -f install/compose.prod.yml ps
    журналы       docker compose -f infra/docker-compose.yml logs -f postfix
    новый ящик    bash infra/scripts/create-mailbox.sh user@$DOMAIN 'пароль'

EOF
exit 0
