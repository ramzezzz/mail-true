#!/usr/bin/env bash
# ------------------------------------------------------------------
# Восстановление Mail.True из резервной копии.
#
#   sudo bash install/restore.sh /var/backups/mailtrue/mailtrue-20260805-120000.tar.gz
#   sudo bash install/restore.sh <архив> --dry-run   # только посмотреть, что внутри
#   sudo bash install/restore.sh <архив> --only db   # только база (или mail, config)
#
# Восстановление ЗАМЕЩАЕТ текущие данные: базу, письма, ключи DKIM и
# настройки. Перед этим скрипт делает страховочную копию текущего
# состояния базы — на случай, если восстановились не из того архива.
#
# Индексы поиска не восстанавливаются и очищаются намеренно: они целиком
# выводятся из писем, и после восстановления Dovecot соберёт их заново.
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ARCHIVE=''
DRY_RUN=0
ONLY=''
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --only)    ONLY="${2:?--only требует db|mail|config}"; shift 2 ;;
        --yes|-y)  MT_ASSUME_YES=1; shift ;;
        --help|-h) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) die "неизвестный ключ: $1" ;;
        *)  ARCHIVE="$1"; shift ;;
    esac
done
export MT_ASSUME_YES="${MT_ASSUME_YES:-0}"

[ -n "$ARCHIVE" ] || die "укажите файл копии: install/restore.sh <архив.tar.gz>"
[ -f "$ARCHIVE" ] || die "файл не найден: $ARCHIVE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step "1. Распаковка и проверка копии"
tar xzf "$ARCHIVE" -C "$WORK" || die "архив не распаковывается — копия повреждена"
[ -f "$WORK/manifest.txt" ] || die "в архиве нет описи manifest.txt — это не копия Mail.True"
printf '\n'
sed 's/^/     /' "$WORK/manifest.txt"
printf '\n'

if [ -f "$WORK/checksums.txt" ]; then
    if ( cd "$WORK" && sha256sum -c --quiet checksums.txt ) 2>/dev/null; then
        ok "контрольные суммы совпали — копия целая"
    else
        fail "контрольные суммы НЕ совпали: копия повреждена"
        if ! confirm "Всё равно восстанавливать?"; then die "восстановление отменено"; fi
    fi
else
    warn "в копии нет контрольных сумм (сделана старой версией backup.sh)"
fi

EXPECTED_PARTS=(database.sql config)
for spec in "${MT_BACKUP_VOLUMES[@]}"; do
    rest="${spec#*:}"
    EXPECTED_PARTS+=("${rest%%:*}")
done
for part in "${EXPECTED_PARTS[@]}"; do
    if [ -e "$WORK/$part" ]; then
        ok "в копии есть: $part"
    else
        warn "в копии нет: $part"
    fi
done

if [ "$DRY_RUN" = "1" ]; then
    step "Режим --dry-run: ничего не менялось"
    exit 0
fi

printf '\n'
warn "восстановление ЗАМЕСТИТ текущие письма, базу и настройки"
if ! confirm "Продолжить?"; then die "восстановление отменено"; fi

load_env
PROJECT="${COMPOSE_PROJECT_NAME:-mailtrue}"

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# --- Страховочная копия текущей базы -------------------------------
SAFETY="$STATE_DIR/pre-restore-$(date +%Y%m%d-%H%M%S).sql"
mkdir -p "$STATE_DIR"
if dc exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists > "$SAFETY" 2>/dev/null; then
    ok "текущая база сохранена на всякий случай: $SAFETY"
else
    warn "не удалось сохранить текущую базу (возможно, стек не запущен)"
fi

# --- Останавливаем то, что пишет в восстанавливаемые тома ----------
step "2. Остановка сервисов"
#
# Останавливать нужно ВСЁ, что пишет в тома из копии, а не только почтовые
# службы. Redis держит обучение антиспама в памяти и сбрасывает его на диск
# по своему расписанию: оставленный работающим, он через минуту-другую
# перезапишет только что восстановленный файл своим содержимым — и
# восстановление обучения молча отменится. Сервер приложения так же пишет
# в том незавершённых загрузок.
dc stop postfix dovecot rspamd redis api >/dev/null 2>&1 || true
ok "postfix, dovecot, rspamd, redis и сервер приложения остановлены"

# --- База ----------------------------------------------------------
if want db && [ -f "$WORK/database.sql" ]; then
    step "3. База данных"
    dc up -d postgres >/dev/null 2>&1 || true
    wait_healthy 120 postgres >/dev/null 2>&1 || true
    if dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q \
            < "$WORK/database.sql" >/dev/null 2>"$WORK/psql.err"; then
        ok "база восстановлена"
    else
        tail -20 "$WORK/psql.err" >&2
        die "не удалось восстановить базу (страховочная копия: $SAFETY)"
    fi

    # Дамп заменяет схему целиком — вместе с ней откатывается и версия схемы.
    # Восстановление СТАРОЙ копии на более новую установку оставляло базу без
    # миграций, появившихся позже: таблицы настроек и внешних ящиков просто
    # исчезали. Миграции идемпотентны, применяем недостающие.
    #
    # Журнал schema_migrations восстанавливается ИЗ ДАМПА вместе со схемой —
    # то есть отражает состояние копии, а не текущей установки. Это ровно то,
    # что здесь нужно: миграции, появившиеся после снятия копии, в журнале
    # копии отсутствуют и потому будут применены. Если копия старая настолько,
    # что журнала в ней ещё нет, apply_migrations заведёт его и применит
    # каталог целиком — как и раньше.
    apply_migrations "restore.sh" || true
    if [ -z "$MT_MIG_FAILED" ]; then
        ok "миграции схемы применены поверх дампа (копия могла быть от старой версии)"
        MIG_FAILED=0
    else
        MIG_FAILED=1
        hint "  docker compose -f infra/docker-compose.yml exec -T postgres \\"
        hint "    psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB < infra/postgres/migrations/<файл>"
    fi
fi

# --- Тома ----------------------------------------------------------
restore_volume() {
    local volume="$1" archive="$2" label="$3"
    [ -f "$WORK/$archive" ] || { warn "$label: в копии нет $archive"; return 0; }
    docker volume create "$volume" >/dev/null
    # Сначала очищаем том, иначе останутся письма, которых в копии нет,
    # и восстановленное состояние не совпадёт с сохранённым.
    docker run --rm -v "$volume":/dst -v "$WORK":/in:ro alpine:3.20 sh -c '
        rm -rf /dst/..?* /dst/.[!.]* /dst/* 2>/dev/null || true
        tar xzf "/in/'"$archive"'" -C /dst
    ' || die "не удалось восстановить том $volume"
    ok "$label восстановлен"
}

if want mail; then
    step "4. Письма, ключи и очередь"
    # Список томов общий с backup.sh (install/lib/common.sh)
    for spec in "${MT_BACKUP_VOLUMES[@]}"; do
        vol="${spec%%:*}"; rest="${spec#*:}"
        file="${rest%%:*}"; label="${rest#*:}"
        restore_volume "${PROJECT}_${vol}" "$file" "$label"
    done

    # Индексы Dovecot очищаем: они ссылаются на прежние файлы писем.
    # Дальше Dovecot соберёт их заново при первом обращении к папке.
    if docker volume inspect "${PROJECT}_mailindex" >/dev/null 2>&1; then
        docker run --rm -v "${PROJECT}_mailindex":/dst alpine:3.20 \
            sh -c 'rm -rf /dst/..?* /dst/.[!.]* /dst/* 2>/dev/null || true' || true
        ok "индексы поиска очищены — Dovecot соберёт их заново"
    fi
fi

# --- Настройки -----------------------------------------------------
if want config && [ -d "$WORK/config" ]; then
    step "5. Настройки"
    if [ -f "$WORK/config/.env" ]; then
        # infra/.env восстанавливать ОБЯЗАТЕЛЬНО: в нём ключи шифрования
        # (AI_ENCRYPTION_KEY, EXTERNAL_ACCOUNTS_KEY, SESSION_SECRET), без
        # которых сохранённые в базе секреты уже не прочитать.
        #
        # Но пароль Postgres к данным отношения не имеет: он задаётся ОДИН
        # раз при инициализации пустого тома базы и потом игнорируется.
        # Если положить сюда пароль из копии, .env разъедется с томом:
        # сама база работать будет (её healthcheck ходит локальным сокетом,
        # где пароль не спрашивают), а api, postfix и dovecot, которые ходят
        # по TCP, доступ потеряют — и раньше об этом никто не сообщал.
        #
        # Поэтому .env берём из копии целиком, а ключи, привязанные к тому,
        # возвращаем из действующей установки.
        PRESERVED=()
        for key in "${MT_VOLUME_BOUND_ENV_KEYS[@]}"; do
            current_value="$(env_get "$key")"
            if [ -n "$current_value" ]; then PRESERVED+=("$key=$current_value"); fi
        done

        cp -a "$ENV_FILE" "$ENV_FILE.before-restore" 2>/dev/null || true
        install -m 600 "$WORK/config/.env" "$ENV_FILE"

        CHANGED=()
        for pair in "${PRESERVED[@]}"; do
            key="${pair%%=*}"; value="${pair#*=}"
            if [ "$(env_get "$key")" != "$value" ]; then CHANGED+=("$key"); fi
            env_set "$key" "$value"
        done
        ok "infra/.env восстановлен (прежний — в .env.before-restore)"
        if [ "${#CHANGED[@]}" -gt 0 ]; then
            warn "из действующей установки сохранены ключи доступа к тому базы: ${CHANGED[*]}"
            hint "они привязаны к тому pgdata, а не к данным: Postgres принимает"
            hint "POSTGRES_PASSWORD только при создании пустого тома. Значения из"
            hint "копии лежат в $ENV_FILE.before-restore, если том тоже переносили."
        fi
    fi
    if [ -f "$WORK/config/install.conf" ]; then
        install -m 600 "$WORK/config/install.conf" "$STATE_FILE"
        ok "install/state/install.conf восстановлен"
    fi
    if [ -d "$WORK/config/certs" ]; then
        mkdir -p "$CERT_DIR"
        cp -a "$WORK/config/certs/." "$CERT_DIR/"
        chmod 600 "$CERT_DIR/mail.key" 2>/dev/null || true
        ok "TLS-сертификаты восстановлены"
    fi
    if [ -d "$WORK/config/maps.d" ]; then
        cp -a "$WORK/config/maps.d/." "$INFRA_DIR/rspamd/maps.d/" 2>/dev/null || true
        ok "белые и чёрные списки антиспама восстановлены"
    fi
    if [ -f "$WORK/letsencrypt.tar.gz" ] && [ -d /etc ]; then
        if tar xzf "$WORK/letsencrypt.tar.gz" -C /etc 2>/dev/null; then
            ok "сертификаты Let's Encrypt восстановлены в /etc/letsencrypt"
        else
            warn "не удалось восстановить /etc/letsencrypt"
        fi
    fi
fi

# --- Подъём и проверка ---------------------------------------------
step "6. Запуск и проверка"
load_env
dc up -d >/dev/null 2>&1 || die "стек не поднимается после восстановления"
if wait_healthy 300 postgres redis dovecot rspamd postfix; then
    printf '\r%-72s\r' ' '
    ok "сервисы поднялись"
else
    printf '\n'
    fail "часть сервисов не поднялась — смотрите docker compose ps"
fi

USERS="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
    -c 'SELECT count(*) FROM virtual_users;' 2>/dev/null | tr -d '\r')"
DOMAINS="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
    -c 'SELECT count(*) FROM virtual_domains;' 2>/dev/null | tr -d '\r')"
MAILS="$(dc exec -T dovecot sh -c 'find /var/mail/vhosts -type f -name "*." -o -type f -name "*,*" 2>/dev/null | wc -l' 2>/dev/null | tr -d '\r')"

ok "в базе: ${DOMAINS:-?} доменов, ${USERS:-?} ящиков"
ok "файлов писем в Maildir: ${MAILS:-?}"

# --- Доступ к базе ПО ПАРОЛЮ ---------------------------------------
# Оба запроса выше и healthcheck контейнера ходят локальным сокетом, где
# пароль не спрашивают. Именно поэтому неработающий пароль после
# восстановления был не виден вовсе, и скрипт рапортовал успех.
# Здесь заходим по TCP (-h postgres) — так же, как api, postfix и dovecot.
if dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
        psql -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
        -c 'SELECT 1' >/dev/null 2>&1; then
    ok "доступ к базе по паролю из infra/.env работает (проверено по TCP)"
else
    fail "доступ к базе ПО ПАРОЛЮ не работает — сервисы не смогут читать данные"
    hint "Пароль в infra/.env разошёлся с паролем внутри тома базы."
    hint "Postgres принимает POSTGRES_PASSWORD только при создании пустого тома."
    hint "Починить одним из двух способов:"
    hint "  1) вернуть прежний пароль:  POSTGRES_PASSWORD из $ENV_FILE.before-restore"
    hint "  2) сменить пароль в самой базе:"
    hint "     docker compose -f infra/docker-compose.yml exec -T postgres \\"
    hint "       psql -U postgres -c \"ALTER USER $POSTGRES_USER PASSWORD 'новый';\""
    hint "После этого: docker compose -f infra/docker-compose.yml up -d"
fi

# --- Доступ к базе из сервиса, а не только из контейнера базы -------
API_DB="$(dc exec -T api sh -c 'wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null' 2>/dev/null | tr -d '\r')"
case "$API_DB" in
    *'"ok":true'*) ok "сервер приложения отвечает и видит свои зависимости" ;;
    *)
        # Тела нет — значит проба ответила 503 (wget считает это ошибкой)
        # или сервер молчит вовсе. Различить и назвать виновника умеет
        # /health: он отвечает 200 всегда и перечисляет части поимённо.
        API_PARTS="$(dc exec -T api sh -c 'wget -qO- http://127.0.0.1:3000/health 2>/dev/null' 2>/dev/null | tr -d '\r')"
        if [ -n "$API_PARTS" ]; then
            fail "сервер приложения работает не полностью: $API_PARTS"
        else
            warn "сервер приложения не ответил на healthz — проверьте его журнал"
        fi
        ;;
esac

info "сверьте эти числа с описью копии выше — они должны совпадать"
printf '\n'

# ==================================================================
step "Итог восстановления"
# ==================================================================
printf '  пройдено: %s%d%s   предупреждений: %s%d%s   не пройдено: %s%d%s\n\n' \
    "$C_GREEN" "$MT_PASS" "$C_OFF" "$C_YELLOW" "$MT_WARN" "$C_OFF" "$C_RED" "$MT_FAIL" "$C_OFF"

if [ "$MT_FAIL" -gt 0 ]; then
    # Раньше скрипт всегда заканчивался успехом, даже когда доступ к базе
    # был сломан: непройденные пункты просто печатались и терялись в выводе.
    printf '  Восстановление ЗАВЕРШЕНО С ОШИБКАМИ — смотрите пометки «→» выше.\n'
    printf '  Не переключайте на этот сервер боевую почту, пока они не устранены.\n\n'
    printf '  Полная проверка: sudo bash install/selfcheck.sh\n\n'
    exit 1
fi

info "полная проверка: sudo bash install/selfcheck.sh"
exit 0
