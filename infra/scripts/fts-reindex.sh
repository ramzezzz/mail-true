#!/usr/bin/env bash
# Переиндексация полнотекстового поиска (Xapian).
#
#   bash infra/scripts/fts-reindex.sh                 # все активные ящики
#   bash infra/scripts/fts-reindex.sh user@mail.local # один ящик
#   bash infra/scripts/fts-reindex.sh --purge ...     # снести индекс и собрать заново
#
# Без --purge индекс достраивается: Dovecot добавит только то, чего в нём нет.
# С --purge каталог xapian-indexes удаляется целиком — нужно после смены
# настроек индексации (partial/full) или если индекс повреждён.
set -uo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")

PURGE=0
PURGE_NOTE=""
if [ "${1:-}" = "--purge" ]; then
    PURGE=1
    PURGE_NOTE=" (с очисткой)"
    shift
fi
TARGET="${1:-}"

if [ -n "$TARGET" ]; then
    SCOPE=(-u "$TARGET")
    echo "Переиндексация ящика $TARGET$PURGE_NOTE"
else
    SCOPE=(-A)
    echo "Переиндексация всех активных ящиков$PURGE_NOTE"
fi

if [ "$PURGE" = "1" ]; then
    if [ -n "$TARGET" ]; then
        # /var/mail/index/<домен>/<логин>/xapian-indexes
        DOM="${TARGET#*@}"; LOC="${TARGET%@*}"
        "${COMPOSE[@]}" exec -T dovecot rm -rf "/var/mail/index/$DOM/$LOC/xapian-indexes"
    else
        "${COMPOSE[@]}" exec -T dovecot sh -c \
            'find /var/mail/index -maxdepth 3 -name xapian-indexes -type d -exec rm -rf {} +'
    fi
    echo "  старый индекс удалён"
fi

# rescan сверяет индекс с содержимым ящика, index '*' строит его для всех папок
"${COMPOSE[@]}" exec -T dovecot doveadm fts rescan "${SCOPE[@]}" 2>&1 | grep -v '^$' || true
"${COMPOSE[@]}" exec -T dovecot doveadm index "${SCOPE[@]}" '*'
rc=$?

if [ $rc -eq 0 ]; then
    echo "Готово."
else
    echo "Переиндексация завершилась с кодом $rc" >&2
fi
exit $rc
