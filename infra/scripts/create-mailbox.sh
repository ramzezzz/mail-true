#!/usr/bin/env bash
# Создание (или обновление пароля) почтового ящика.
#   Использование: create-mailbox.sh <email> <пароль> [SHA512-CRYPT|ARGON2ID]
#   Пример:        create-mailbox.sh test@mail.local test12345
# Домен из адреса должен существовать в virtual_domains (основной домен
# сидируется автоматически при инициализации БД).
set -euo pipefail

EMAIL="${1:?Использование: create-mailbox.sh <email> <пароль> [SHA512-CRYPT|ARGON2ID]}"
PASSWORD="${2:?Не задан пароль}"
SCHEME="${3:-SHA512-CRYPT}"

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")

# Переменные подключения к БД из .env.
# Возврат каретки вычищаем: .env, сохранённый с концами строк Windows, даёт
# POSTGRES_USER с невидимым хвостом, и psql отвечает «role "mailserver" does
# not exist» при полностью исправной базе. Так же поступает load_env
# в install/lib/common.sh.
set -a; . <(tr -d '\r' < "$INFRA_DIR/.env"); set +a

DOMAIN="${EMAIL#*@}"
[ "$DOMAIN" != "$EMAIL" ] || { echo "Ошибка: '$EMAIL' — не e-mail"; exit 1; }

# Хэш пароля считает doveadm внутри контейнера dovecot (с префиксом {SCHEME})
HASH=$("${COMPOSE[@]}" exec -T dovecot doveadm pw -s "$SCHEME" -p "$PASSWORD" | tr -d '\r\n')

"${COMPOSE[@]}" exec -T \
    -e M_EMAIL="$EMAIL" -e M_DOMAIN="$DOMAIN" -e M_HASH="$HASH" \
    postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -v email="$M_EMAIL" -v domain="$M_DOMAIN" -v hash="$M_HASH"' <<'SQL'
INSERT INTO virtual_domains (name) VALUES (:'domain')
ON CONFLICT (name) DO NOTHING;
INSERT INTO virtual_users (domain_id, email, password)
SELECT id, :'email', :'hash' FROM virtual_domains WHERE name = :'domain'
ON CONFLICT (email) DO UPDATE
    SET password = EXCLUDED.password, active = TRUE, updated_at = now();
SQL

echo "Ящик $EMAIL создан/обновлён (схема $SCHEME)"
