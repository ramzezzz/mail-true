#!/usr/bin/env bash
# ------------------------------------------------------------------
# Резервная копия Mail.True.
#
#   sudo bash install/backup.sh                    # в /var/backups/mailtrue
#   sudo bash install/backup.sh --dir /mnt/backup  # в свой каталог
#   sudo bash install/backup.sh --keep 14          # хранить 14 последних копий
#
# Что попадает в копию:
#   база данных   — домены, ящики, алиасы, администраторы, настройки, журналы
#   Maildir       — сами письма (том mailtrue_vmail)
#   ключи DKIM    — том mailtrue_rspamd-data: без них подпись сменится
#                   и придётся менять DNS-запись
#   очередь почты — том mailtrue_postfix-spool: письма, которые сервер уже
#                   принял, но ещё не доставил. Без них потеря копии —
#                   это тихая потеря принятых писем
#   настройки     — infra/.env, install/state, сертификаты, списки антиспама
#
# Чего в копии НЕТ намеренно: индексы поиска (том mailindex). Они полностью
# восстанавливаются из писем, а места занимают много. После восстановления
# Dovecot переиндексирует почту сам.
#
# Копия — это архив .tar.gz плюс файл с описью и контрольными суммами.
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

BACKUP_ROOT="${MAILTRUE_BACKUP_DIR:-/var/backups/mailtrue}"
KEEP=7

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)  BACKUP_ROOT="${2:?--dir требует путь}"; shift 2 ;;
        --keep) KEEP="${2:?--keep требует число}"; shift 2 ;;
        --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "неизвестный ключ: $1" ;;
    esac
done

load_env
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$BACKUP_ROOT/mailtrue-$STAMP.tar.gz"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

step "Резервная копия Mail.True"
info "каталог назначения: $BACKUP_ROOT"

# --- 1. База данных ------------------------------------------------
# pg_dump снимает согласованный снимок: останавливать сервер не нужно.
#
# --exclude-table-data=sender_logo_cache — это КЭШ скачанных из интернета
# логотипов доменов (apps/api/src/logos/store.ts). До пяти тысяч картинок,
# в выгрузке они лежат шестнадцатеричным текстом, то есть вдвое крупнее
# себя. Класть их в копию незачем: они восстанавливаются сами из сети, а
# без сети ничего не значат. САМА ТАБЛИЦА в выгрузке остаётся (только без
# данных) — иначе после восстановления её пришлось бы заводить заново.
#
# Ручные логотипы администратора лежат в ДРУГОЙ таблице
# (sender_logo_overrides) и в копию входят полностью: восстановить их
# неоткуда — исходник картинки остался у того, кто её загружал.
step "1. База данных"
if dc exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
        --exclude-table-data=sender_logo_cache \
        > "$WORK/database.sql" 2>"$WORK/pg.err"; then
    # «|| true» здесь и ниже — не небрежность: под set -euo pipefail
    # ненулевой код внутри подстановки обрывает копию МОЛЧА, на середине,
    # уже после удачной выгрузки базы. Пустое значение — штатный случай,
    # его показывают как «?».
    SIZE="$(du -h "$WORK/database.sql" | cut -f1 || true)"
    ok "выгружена база $POSTGRES_DB ($SIZE)"
else
    cat "$WORK/pg.err" >&2
    die "не удалось выгрузить базу"
fi
rm -f "$WORK/pg.err"

# --- 2. Письма и ключи ---------------------------------------------
# Тома забираем через временный контейнер: так не важно, где docker
# держит их на диске, и не нужны права на /var/lib/docker.
dump_volume() {
    local volume="$1" out="$2" label="$3"
    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
        warn "тома $volume нет — пропускаем ($label)"
        return 0
    fi
    if docker run --rm -v "$volume":/src:ro -v "$WORK":/out alpine:3.20 \
            tar czf "/out/$out" -C /src . 2>/dev/null; then
        ok "$label: $(du -h "$WORK/$out" | cut -f1)"
    else
        die "не удалось сохранить том $volume"
    fi
}

step "2. Письма, ключи и очередь"

# Redis держит обучение антиспама в памяти и сбрасывает его на диск по своему
# расписанию (раз в час при одной правке). Без явного сброса в копию попал бы
# файл часовой давности — то есть обучение, сделанное людьми за последний час,
# в копии бы отсутствовало, а сама копия выглядела бы полной.
#
# BGSAVE не блокирует Redis; ждём завершения по времени последнего успешного
# сохранения. Если Redis недоступен, копию всё равно делаем — но говорим об
# этом вслух, а не молчим.
if REDIS_PASSWORD="$(grep -E '^REDIS_PASSWORD=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)" \
   && [ -n "${REDIS_PASSWORD:-}" ]; then
    redis_cli() { dc exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning "$@" 2>/dev/null; }
    BEFORE="$(redis_cli lastsave | tr -d '\r' || true)"
    if [ -n "$BEFORE" ] && redis_cli bgsave >/dev/null; then
        for _ in $(seq 1 30); do
            AFTER="$(redis_cli lastsave | tr -d '\r' || true)"
            [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && break
            sleep 1
        done
        if [ "${AFTER:-}" != "$BEFORE" ]; then
            ok "обучение антиспама сброшено на диск"
        else
            warn "Redis не подтвердил сохранение — обучение антиспама может отстать на час"
        fi
    else
        warn "Redis не отвечает — обучение антиспама попадёт в копию в том виде, что лежит на диске"
    fi
fi

# Имя проекта compose задано в infra/docker-compose.yml (name: mailtrue),
# отсюда и префикс имён томов.
PROJECT="${COMPOSE_PROJECT_NAME:-mailtrue}"
# Список томов — общий с restore.sh (install/lib/common.sh). Раздельные
# перечни уже привели к тому, что появившийся в стеке том очереди Postfix
# в копию не попал, а потеря очереди — это тихая потеря принятых писем.
for spec in "${MT_BACKUP_VOLUMES[@]}"; do
    vol="${spec%%:*}"; rest="${spec#*:}"
    file="${rest%%:*}"; label="${rest#*:}"
    dump_volume "${PROJECT}_${vol}" "$file" "$label"
done

# --- 3. Настройки --------------------------------------------------
step "3. Настройки"
mkdir -p "$WORK/config"
for item in "$ENV_FILE" "$STATE_FILE"; do
    if [ -f "$item" ]; then
        cp -a "$item" "$WORK/config/$(basename "$item")"
    fi
done
if [ -d "$CERT_DIR" ]; then
    mkdir -p "$WORK/config/certs"
    cp -a "$CERT_DIR/." "$WORK/config/certs/" 2>/dev/null || true
fi
# Карты антиспама больше не копируются отсюда: они переехали в том
# rspamd-maps и снимаются вместе с остальными томами (MT_BACKUP_VOLUMES).
# В рабочем дереве остались только заготовки, они и так лежат в git.
if [ -d /etc/letsencrypt ]; then
    if tar czf "$WORK/letsencrypt.tar.gz" -C /etc letsencrypt 2>/dev/null; then
        ok "сертификаты Let's Encrypt сохранены"
    else
        warn "не удалось сохранить /etc/letsencrypt"
    fi
fi
ok "настройки, сертификаты и списки антиспама сохранены"

# --- 4. Опись ------------------------------------------------------
COUNTS="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA -c \
    "SELECT (SELECT count(*) FROM virtual_domains) || ' доменов, ' ||
            (SELECT count(*) FROM virtual_users)   || ' ящиков, ' ||
            (SELECT count(*) FROM virtual_aliases) || ' алиасов';" 2>/dev/null | tr -d '\r')"

cat > "$WORK/manifest.txt" <<EOF
Резервная копия Mail.True
Создана:      $(date -Iseconds)
Сервер:       ${MAIL_HOSTNAME:-?}
Домен:        ${MAIL_DOMAIN:-?}
Содержимое:   ${COUNTS:-не удалось посчитать}
Версия схемы: $(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
                -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d '\r') таблиц

Восстановление:
  sudo bash install/restore.sh $(basename "$ARCHIVE")
EOF
( cd "$WORK" && find . -type f -exec sha256sum {} + > "$WORK.sums" && mv "$WORK.sums" checksums.txt )
ok "опись и контрольные суммы записаны"

# --- 5. Архив ------------------------------------------------------
step "4. Архив"
tar czf "$ARCHIVE" -C "$WORK" .
chmod 600 "$ARCHIVE"
ok "готово: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

mkdir -p "$STATE_DIR"
date -Iseconds > "$STATE_DIR/last-backup"

# --- 6. Чистка старых ----------------------------------------------
if [ "$KEEP" -gt 0 ]; then
    mapfile -t OLD < <(find "$BACKUP_ROOT" -maxdepth 1 -name 'mailtrue-*.tar.gz' -printf '%T@ %p\n' \
        | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)
    if [ "${#OLD[@]}" -gt 0 ]; then
        for f in "${OLD[@]}"; do rm -f "$f"; done
        info "удалено старых копий: ${#OLD[@]} (храним последние $KEEP)"
    fi
fi

cat <<EOF

  Копия без проверенного восстановления копией не является.
  Проверьте её на тестовой машине:

      sudo bash install/restore.sh $ARCHIVE --dry-run   # что внутри
      sudo bash install/restore.sh $ARCHIVE             # восстановить

EOF
