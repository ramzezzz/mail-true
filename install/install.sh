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

MT_MIN_RAM_MB=1800
MT_MIN_RAM_CLAMAV_MB=3000
MT_MIN_DISK_GB=10
MT_MIN_COMPOSE=2.24

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

# --- Инструменты, без которых нечем проверять ----------------------
# Ставим до проверок: на голой Ubuntu Server нет ни curl, ни dig,
# а без ss нечем посмотреть, кто занял порты.
ensure_prereqs() {
    local missing=()
    have curl    || missing+=(curl)
    have openssl || missing+=(openssl)
    have dig     || missing+=(dnsutils)
    have ss      || missing+=(iproute2)
    if [ "${#missing[@]}" -eq 0 ]; then
        return 0
    fi
    if ! have apt-get; then
        warn "не хватает: ${missing[*]}, а apt-get нет — поставьте вручную"
        return 0
    fi
    info "доустанавливаем: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null 2>&1 || true
}
if [ "$(id -u)" -eq 0 ]; then
    ensure_prereqs
fi

# --- Операционная система -----------------------------------------
OS_NAME='неизвестна'; OS_ID=''; OS_VER=''
if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-$NAME}"; OS_ID="${ID:-}"; OS_VER="${VERSION_ID:-}"
fi
case "$OS_ID:$OS_VER" in
    ubuntu:22.04) ok "ОС: $OS_NAME (целевая система)" ;;
    ubuntu:24.04|ubuntu:20.04|debian:12|debian:11)
        ok "ОС: $OS_NAME"
        info "проект рассчитан на Ubuntu Server 22.04, но эта система тоже подойдёт" ;;
    *)
        warn "ОС: $OS_NAME — не Ubuntu 22.04"
        hint "проверялось на Ubuntu Server 22.04; на других системах возможны сюрпризы" ;;
esac

# --- Архитектура ---------------------------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|aarch64) ok "архитектура: $ARCH" ;;
    *) warn "архитектура $ARCH — образы стека собраны под x86_64 и aarch64" ;;
esac

# --- Память --------------------------------------------------------
RAM_MB=0
if [ -r /proc/meminfo ]; then
    RAM_MB=$(awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo)
fi
if [ "$RAM_MB" -ge "$MT_MIN_RAM_MB" ]; then
    ok "память: ${RAM_MB} МБ (стек в простое занимает около 310 МБ)"
else
    warn "память: ${RAM_MB} МБ — рекомендуется от ${MT_MIN_RAM_MB} МБ"
    hint "стек поднимется и на меньшем объёме, но запаса на письма и поиск не останется"
fi

# --- Место на диске ------------------------------------------------
DISK_GB=$(df -BG --output=avail "$REPO_DIR" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
DISK_GB="${DISK_GB:-0}"
if [ "$DISK_GB" -ge "$MT_MIN_DISK_GB" ]; then
    ok "свободно на диске: ${DISK_GB} ГБ"
else
    warn "свободно на диске: ${DISK_GB} ГБ — рекомендуется от ${MT_MIN_DISK_GB} ГБ"
    hint "образы стека занимают около 1.5 ГБ, остальное — письма и индексы поиска"
fi

# --- Порты ---------------------------------------------------------
STACK_RUNNING=0
if have docker && docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null | grep -q .; then
    STACK_RUNNING=1
fi

if [ "$SKIP_PORT_CHECK" = "1" ]; then
    info "проверка портов пропущена (--skip-port-check)"
elif ! have ss && ! have netstat; then
    warn "нет ни ss, ни netstat — занятость портов проверить нечем"
else
    BUSY_FOREIGN=0
    for port in "${MT_REQUIRED_PORTS[@]}"; do
        listener="$(port_listener "$port")"
        if [ -z "$listener" ]; then
            ok "порт $port свободен"
        elif [ "$STACK_RUNNING" = "1" ] && printf '%s' "$listener" | grep -qi 'docker'; then
            ok "порт $port занят нашим же стеком (повторная установка)"
        else
            proc=$(printf '%s' "$listener" | sed -n 's/.*users:((\("[^"]*"\).*/\1/p' | tr -d '"')
            if [ -n "$proc" ]; then
                fail "порт $port занят процессом «$proc»"
            else
                fail "порт $port занят (имя процесса определить не удалось)"
                hint "кто именно: fuser -v $port/tcp  или  lsof -i :$port"
            fi
            BUSY_FOREIGN=1
        fi
    done
    # 465 стек пока не слушает — просто предупреждаем, если он кем-то занят
    if [ -n "$(port_listener 465)" ]; then
        info "порт 465 кем-то занят; стек его не использует (см. docs/install.md)"
    fi
    if [ "$BUSY_FOREIGN" = "1" ]; then
        # Раньше здесь было только предупреждение, и установка шла дальше
        # до падения `docker compose up` с сырой ошибкой про занятый порт.
        # Спрашиваем: продолжать почти всегда бессмысленно.
        fail "часть портов занята чужими процессами — стек не сможет их открыть"
        hint "посмотреть кто: ss -ltnp | grep -E ':(25|80|443|143|993|110|995|587)\\b'"
        hint "освободите порты или запустите с --skip-port-check, если знаете, что делаете"
        if ! confirm "Всё равно продолжить установку (стек, скорее всего, не поднимется)?"; then
            die "установка прервана: сначала освободите занятые порты"
        fi
    fi
fi

# --- Чужой MTA -----------------------------------------------------
# Ubuntu ставит postfix или exim4 «прицепом» к другим пакетам, и он
# молча занимает 25-й порт. Ищем и запущенные службы, и просто
# установленные: остановленный сегодня MTA запустится при перезагрузке.
FOREIGN_MTA=''
FOREIGN_INSTALLED=''
for unit in postfix exim4 sendmail opensmtpd nullmailer msmtpd; do
    if have systemctl && systemctl is-active --quiet "$unit" 2>/dev/null; then
        FOREIGN_MTA="$FOREIGN_MTA $unit"
    elif have dpkg-query && dpkg-query -W -f='${Status}' "$unit" 2>/dev/null | grep -q 'ok installed'; then
        FOREIGN_INSTALLED="$FOREIGN_INSTALLED $unit"
    fi
done
if [ -z "$FOREIGN_MTA" ] && [ -n "$FOREIGN_INSTALLED" ]; then
    warn "установлены пакеты почтовых служб:$FOREIGN_INSTALLED (сейчас не запущены)"
    hint "после перезагрузки они могут занять 25-й порт и сломать приём почты"
    hint "лучше убрать заранее: apt-get purge -y$FOREIGN_INSTALLED"
fi
if [ -n "$FOREIGN_MTA" ]; then
    fail "на сервере уже работает почтовая служба:$FOREIGN_MTA"
    hint "Ubuntu часто ставит postfix или exim4 вместе с другими пакетами."
    hint "Он держит порт 25, и наш Postfix не запустится. Отключите его:"
    for unit in $FOREIGN_MTA; do
        hint "  systemctl disable --now $unit"
    done
    hint "Если чужой MTA нужен — перенесите его на другой порт или уберите совсем:"
    hint "  apt-get purge -y$FOREIGN_MTA"
    if ! confirm "Продолжить установку несмотря на это?"; then
        die "установка прервана: сначала уберите чужой MTA"
    fi
elif [ -z "$FOREIGN_INSTALLED" ]; then
    ok "чужих почтовых служб (postfix/exim/sendmail) не установлено"
fi

# --- Исходящий 25-й порт -------------------------------------------
# Самая частая причина «письма не уходят»: хостер закрывает исходящий 25-й.
# Проверяем заранее, чтобы это не выяснилось через неделю после установки.
if [ "$SKIP_PORT_CHECK" = "1" ]; then
    info "проверка исходящего 25-го порта пропущена"
else
    OUT_OK=0
    for mx in gmail-smtp-in.l.google.com alt1.aspmx.l.google.com mx.yandex.ru; do
        if tcp_probe "$mx" 25 6; then OUT_OK=1; break; fi
    done
    if [ "$OUT_OK" = "1" ]; then
        ok "исходящий порт 25 открыт — письма смогут уходить наружу"
    elif tcp_probe 1.1.1.1 443 5; then
        fail "исходящий порт 25 закрыт: соединение с чужими MX не устанавливается"
        hint "Интернет при этом работает — значит порт режет провайдер или хостер."
        hint "Это самая частая причина «почта приходит, но не уходит»."
        hint "Что делать: написать в поддержку хостинга и попросить открыть"
        hint "исходящий TCP/25 (обычно открывают после короткой переписки),"
        hint "либо настроить отправку через внешний релей (docs/install.md)."
        if ! confirm "Продолжить установку?"; then
            die "установка прервана"
        fi
    else
        warn "не удалось проверить исходящий 25-й порт: сеть недоступна вообще"
    fi
fi

# ==================================================================
step "2. Docker"
# ==================================================================

install_docker() {
    step "2.1 Установка Docker"
    have apt-get || die "нет apt-get — поставьте Docker вручную: https://docs.docker.com/engine/install/"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null
    install -m 0755 -d /etc/apt/keyrings
    local repo_id="${OS_ID:-ubuntu}"
    case "$repo_id" in ubuntu|debian) : ;; *) repo_id=ubuntu ;; esac
    curl -fsSL "https://download.docker.com/linux/$repo_id/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    local codename
    codename="${VERSION_CODENAME:-jammy}"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$(dpkg --print-architecture)" "$repo_id" "$codename" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    if have systemctl; then
        systemctl enable --now docker >/dev/null 2>&1 || true
    fi
    ok "Docker установлен"
}

# В режиме --prepare-only Docker не обязателен: там только проверки,
# секреты и конфигурация — их удобно готовить и на машине без Docker.
docker_problem() {
    if [ "$PREPARE_ONLY" = "1" ]; then
        warn "$1"
        return 0
    fi
    die "$1"
}

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
    # Берём образец только ради комментариев; все значения ниже перезаписываются
    cp "$ENV_EXAMPLE" "$ENV_FILE"
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
NEW_SECRETS=0
for pair in \
    "POSTGRES_PASSWORD:32" \
    "REDIS_PASSWORD:32" \
    "RSPAMD_PASSWORD:24" \
    "DOVECOT_MASTER_PASSWORD:32" \
    "AI_ENCRYPTION_KEY:48" \
    "SESSION_SECRET:48" \
    "ADMIN_SESSION_SECRET:48" \
    "EXTERNAL_ACCOUNTS_KEY:48"
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
env_set POSTGRES_PORT 5432
env_set REDIS_PORT    6379
env_set SMTP_PORT 25
env_set SUBMISSION_PORT 587
env_set IMAP_PORT 143
env_set IMAPS_PORT 993
env_set POP3_PORT 110
env_set POP3S_PORT 995
env_set AUTOCONFIG_PORT 8025
env_set NGINX_HTTP_PORT 80
env_set NGINX_HTTPS_PORT 443
env_set API_LOG_LEVEL info
# Веб-интерфейс: cookie сессии отдаётся только по HTTPS. Отладочный порт
# сервера приложения наружу не публикуется (install/compose.prod.yml).
env_set COOKIE_SECURE true
env_set TLS_REJECT_UNAUTHORIZED false
env_set UNBOUND_LOG_QUERIES no
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
fi

if [ "$PREPARE_ONLY" = "1" ]; then
    step "Готово (режим --prepare-only)"
    info "конфигурация подготовлена, стек не поднимался."
    info "Поднять: docker compose -f infra/docker-compose.yml -f install/compose.prod.yml up -d"
    exit 0
fi

# ==================================================================
step "6. Сборка и запуск стека"
# ==================================================================
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
            *healthy*) continue ;;
        esac
        printf '\n--- журнал %s (последние строки) ---\n' "$svc"
        dc logs --tail=15 "$svc" 2>&1 | tail -15
    done
    die "часть сервисов не поднялась (журналы выше)"
fi

# ==================================================================
step "7. База данных и администратор"
# ==================================================================

# Выполнить SQL со stdin в контейнере postgres.
psql_run() {
    dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA
}

# Postgres сам выполняет содержимое каталога миграций, но только при создании
# базы на пустом томе. На уже существующей базе — то есть при обновлении —
# применяем их сами. Все миграции идемпотентны, повторное применение безопасно.
#
# Перебираем каталог, а не список в коде. Раньше здесь был зашитый перечень
# «0003 и 0004», в него забыли внести появившуюся позже миграцию настроек и
# внешних ящиков. При установке с нуля это не проявлялось, а при обновлении
# таблицы не создавались, и настройки с фильтрами переставали работать.
# Список в коде всегда отстаёт от каталога — поэтому его здесь больше нет.
for mig in "$INFRA_DIR"/postgres/migrations/*.sql; do
    [ -f "$mig" ] || continue
    mig_name=$(basename "$mig")
    # 0001 создаёт схему с нуля и на живой базе не нужен, но безвреден:
    # он весь на CREATE TABLE IF NOT EXISTS.
    if dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q \
            < "$mig" >/dev/null 2>&1; then
        ok "миграция $mig_name применена"
    else
        warn "миграция $mig_name не применилась — проверьте вручную:"
        warn "  docker compose -f infra/docker-compose.yml exec -T postgres \\"
        warn "    psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB < infra/postgres/migrations/$mig_name"
    fi
done

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
    bash "$INSTALL_DIR/renew-certs.sh" --deploy-only || return 1
    return 0
}

if [ "$TLS_MODE" = "letsencrypt" ]; then
    if issue_letsencrypt; then
        ok "сертификат Let's Encrypt выпущен и установлен"
        # Автопродление: сертификат живёт 90 дней, продлевать надо заранее
        if have systemctl && [ -d /etc/systemd/system ]; then
            cat > /etc/systemd/system/mailtrue-certs.service <<EOF
[Unit]
Description=Mail.True: продление TLS-сертификата Let's Encrypt
After=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash $INSTALL_DIR/renew-certs.sh
EOF
            cat > /etc/systemd/system/mailtrue-certs.timer <<'EOF'
[Unit]
Description=Mail.True: проверка срока TLS-сертификата дважды в сутки

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
            systemctl daemon-reload >/dev/null 2>&1 || true
            if systemctl enable --now mailtrue-certs.timer >/dev/null 2>&1; then
                ok "автопродление сертификата включено (systemd-таймер)"
            else
                warn "не удалось включить таймер продления"
            fi
        else
            warn "systemd недоступен — продление сертификата придётся запускать самому"
            hint "добавьте в cron: 17 3 * * * /bin/bash $INSTALL_DIR/renew-certs.sh"
        fi
    else
        warn "работаем с самоподписанным сертификатом"
        hint "почта ходит, но клиенты будут ругаться на сертификат,"
        hint "а Outlook откажется настраиваться автоматически"
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

  Почта в браузере:  $WEB_SCHEME://mail.$DOMAIN   (и $WEB_SCHEME://$DOMAIN)
  Админка:           $WEB_SCHEME://admin.$DOMAIN

  Почтовый сервер:   $MAIL_HOST
  Домен:             $DOMAIN
  Ящик админа:       $ADMIN_EMAIL
  Логин в админке:   $ADMIN_LOGIN
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
