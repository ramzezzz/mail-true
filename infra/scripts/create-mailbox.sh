#!/usr/bin/env bash
# Создание (или обновление пароля) почтового ящика.
#   Использование: create-mailbox.sh <email> <пароль> [SHA512-CRYPT|ARGON2ID]
#                  create-mailbox.sh <email> - [схема] < файл-с-паролем
#   Пример:        create-mailbox.sh test@mail.local test12345
# Домен из адреса должен существовать в virtual_domains (основной домен
# сидируется автоматически при инициализации БД).
#
# ------------------------------------------------------------------
# ПОЧЕМУ У ПАРОЛЯ ЕСТЬ ВТОРОЙ СПОСОБ ПОПАСТЬ СЮДА — «-»
# ------------------------------------------------------------------
# Строка запуска любого процесса лежит в /proc/<pid>/cmdline и читается
# ЛЮБЫМ пользователем машины: права на этот файл — 444. Значит
# «bash create-mailbox.sh admin@example.org тайна» показывает пароль
# ящика администратора всем, у кого есть учётная запись на сервере, —
# и не мгновение, а пока идёт создание. Плюс он остаётся в истории
# оболочки того, кто запускал.
#
# Поэтому пароль можно подать на ВВОД, поставив вместо него «-». Так его
# и передаёт установщик. Прежний способ (пароль вторым аргументом)
# оставлен: скрипт зовут руками и из чужих сценариев.
# ------------------------------------------------------------------
set -euo pipefail

EMAIL="${1:?Использование: create-mailbox.sh <email> <пароль|-> [SHA512-CRYPT|ARGON2ID]}"
PASSWORD="${2:?Не задан пароль (или «-», чтобы прочитать его со ввода)}"
SCHEME="${3:-SHA512-CRYPT}"

if [ "$PASSWORD" = "-" ]; then
    IFS= read -r PASSWORD || true
    [ -n "$PASSWORD" ] || { echo "Ошибка: пароль на вводе пуст" >&2; exit 1; }
fi

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
#
# «|| true» и проверка ниже — вместо молчаливого обрыва: под set -e
# неподнятый Dovecot заканчивал скрипт без единого слова, и человек не
# понимал, создан ящик или нет. Пустой хэш пускать в базу нельзя тем
# более: получился бы ящик, в который невозможно войти.
#
# Пароль уходит в контейнер ЧЕРЕЗ ВВОД и там кладётся в переменную
# окружения: строку запуска `docker` на хосте читают все, окружение
# процесса (/proc/<pid>/environ) — только его владелец и root.
#
# Честно о том, что осталось: сам doveadm получает пароль аргументом
# внутри контейнера — ключа «взять из окружения» у него нет. Наружу это
# уже не видно, но и совсем аргумент отсюда не убрать, не меняя doveadm
# на другой способ считать хэш.
HASH=$(printf '%s\n' "$PASSWORD" | "${COMPOSE[@]}" exec -T dovecot sh -c '
    IFS= read -r mt_pw
    exec doveadm pw -s "$1" -p "$mt_pw"
' _ "$SCHEME" | tr -d '\r\n' || true)
if [ -z "$HASH" ]; then
    echo "Ошибка: не удалось посчитать хэш пароля — Dovecot не ответил." >&2
    echo "Проверьте: docker compose ps dovecot" >&2
    exit 1
fi

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
