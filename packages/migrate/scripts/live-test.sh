#!/usr/bin/env bash
# Повторяемый живой тест переноса почты на реальном стеке.
#
#   bash packages/migrate/scripts/live-test.sh
#
# Что делает:
#   1. Проверяет, что docker-стек поднят.
#   2. Создаёт (идемпотентно) два ящика: источник и приёмник.
#   3. Собирает пакет и запускает node dist/livetest.js — тот наполняет
#      источник письмами, выполняет перенос, проверяет результат и
#      повторные запуски (отсутствие дублей).
#   4. Если удаётся прочитать infra/.env — дополнительно прогоняет
#      smoke-тест хранилища состояния в Postgres.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG="$ROOT/packages/migrate"

SRC_USER="${MIGRATE_TEST_SRC:-migsrc@mail.local}"
DST_USER="${MIGRATE_TEST_DST:-migdst@mail.local}"
PASSWORD="${MIGRATE_TEST_PASS:-migr8-test-12345}"

echo "== Проверка стека =="
docker compose -f "$ROOT/infra/docker-compose.yml" ps --format '{{.Name}} {{.Status}}' | grep -q "mail-dovecot Up" \
  || { echo "Стек не поднят: docker compose -f infra/docker-compose.yml up -d"; exit 1; }

echo "== Создание тестовых ящиков =="
bash "$ROOT/infra/scripts/create-mailbox.sh" "$SRC_USER" "$PASSWORD"
bash "$ROOT/infra/scripts/create-mailbox.sh" "$DST_USER" "$PASSWORD"

echo "== Сборка пакета =="
(cd "$PKG" && npx tsc -b)

# DSN Postgres для smoke-теста PgStateStore (необязательно)
if [ -z "${MIGRATE_PG_DSN:-}" ] && [ -f "$ROOT/infra/.env" ]; then
  # shellcheck disable=SC1091
  set +u; . "$ROOT/infra/.env"; set -u
  if [ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ] && [ -n "${POSTGRES_DB:-}" ]; then
    export MIGRATE_PG_DSN="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
  fi
fi

echo "== Живой тест =="
MIGRATE_TEST_SRC="$SRC_USER" MIGRATE_TEST_DST="$DST_USER" MIGRATE_TEST_PASS="$PASSWORD" \
  node "$PKG/dist/livetest.js"
