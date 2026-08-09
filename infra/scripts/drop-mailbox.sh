#!/usr/bin/env bash
# Полное удаление ящика со стенда — для уборки после проверок.
#
# Зачем отдельный скрипт. Проверки заводили временные ящики и убирали за
# собой строкой `DELETE FROM virtual_users` — то есть только сам ящик. Всё
# остальное оставалось: правила фильтрации, подписи, настройки, привязанные
# ящики, состояние переноса, каталог почты и каталог поисковых индексов.
#
# Цена этого оказалась не «немного мусора в базе». Осиротевшие строки дожили
# до проверки, и она приняла их за дефект продукта: доложила, что удаление
# ящика в админке оставляет хвосты. Пришлось разбираться и убеждаться, что
# админка как раз убирает всё правильно (см. purgeMailboxData), а мусор —
# от самих проверок. Отладочный мусор, притворяющийся дефектом, стоит
# дороже, чем кажется.
#
# Список таблиц здесь ОДИН и совпадает с тем, что убирает админка.
#
# Запуск: bash infra/scripts/drop-mailbox.sh адрес@домен [ещё@адрес ...]
set -u

HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/../docker-compose.yml"

dc()  { MSYS_NO_PATHCONV=1 $COMPOSE "$@"; }
sql() { dc exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" \
        -d "${POSTGRES_DB:-mailserver}" -qtA -c "$1" 2>&1; }

[ $# -gt 0 ] || { echo "укажите хотя бы один адрес"; exit 2; }

# ------------------------------------------------------------------
# АДРЕСА ПРОВЕРЯЮТСЯ ВСЕ И ДО ПЕРВОГО РАЗРУШИТЕЛЬНОГО ДЕЙСТВИЯ.
#
# Проверка «аргументов хотя бы один» пропускала ПУСТУЮ строку: вызов вида
# `drop-mailbox.sh "$MAIL"` с незаполненной переменной — обычное дело в
# скриптах проверок. Дальше «${MAIL%%@*}» и «${MAIL##*@}» давали пустые
# половинки, и строка ниже превращалась в
#
#     rm -rf /var/mail/vhosts//
#
# то есть в удаление почты ВСЕХ доменов стенда одним движением. Ошибка
# при этом ничем себя не выдавала: скрипт бодро печатал «ящик  удалён
# полностью» и заканчивался нулевым кодом.
#
# Заодно отсекаются адреса со слэшем, кавычкой и обратной чертой: имена
# частей адреса подставляются и в путь на диске, и в SQL-строку, и такой
# адрес — это либо опечатка, либо попытка вылезти из каталога.
#
# Проверяем ВЕСЬ список заранее: обнаружить негодный третий адрес после
# того, как первые два уже снесены, — это худший из возможных моментов.
# ------------------------------------------------------------------
for MAIL in "$@"; do
    case "$MAIL" in
        '')       echo "пустой адрес в аргументах — нечего удалять"; exit 2 ;;
        *[!-a-zA-Z0-9._@+]*)
                  echo "адрес «$MAIL» содержит недопустимые символы"; exit 2 ;;
        *@*@*)    echo "в адресе «$MAIL» больше одной собаки"; exit 2 ;;
        @*|*@)    echo "адрес «$MAIL» неполон: нужно имя@домен"; exit 2 ;;
        *@*)      ;;
        *)        echo "«$MAIL» — не адрес: нужно имя@домен"; exit 2 ;;
    esac
done

for MAIL in "$@"; do
    USER_PART="${MAIL%%@*}"
    DOMAIN_PART="${MAIL##*@}"

    # Почта и индексы — руками самого Dovecot, пока ящик ещё есть в базе:
    # после удаления строки он не пустит даже служебного пользователя.
    dc exec -T dovecot sh -c "doveadm expunge -u '$MAIL' mailbox '*' all" >/dev/null 2>&1
    dc exec -T dovecot sh -c "rm -rf /var/mail/vhosts/$DOMAIN_PART/$USER_PART" >/dev/null 2>&1
    dc exec -T dovecot sh -c "rm -rf /var/mail/index/$DOMAIN_PART/$USER_PART" >/dev/null 2>&1

    # Всё, что принадлежит ящику в базе. Пара «таблица:колонка» — колонка
    # с адресом называется в каждой таблице по-своему, и попытка писать
    # везде `email` однажды уже привела к молча не работавшей уборке.
    for pair in mail_filters:account_email mail_signatures:account_email \
                mail_user_settings:account_email ai_user_settings:account_email \
                external_accounts:owner_email linked_accounts:owner_email \
                linked_accounts:linked_email \
                migrate_messages:account migrate_cursors:account; do
        table="${pair%%:*}"; column="${pair##*:}"
        out="$(sql "DELETE FROM $table WHERE lower($column) = lower('$MAIL');")"
        # Отсутствие таблицы — не беда (миграция могла не применяться),
        # а вот прочие ошибки надо видеть, а не глотать.
        case "$out" in
            *'does not exist'*) ;;
            *ERROR*) echo "  уборка $table: $out" ;;
        esac
    done

    out="$(sql "DELETE FROM virtual_aliases WHERE lower(destination) = lower('$MAIL');")"
    case "$out" in *ERROR*) echo "  уборка virtual_aliases: $out" ;; esac

    out="$(sql "DELETE FROM virtual_users WHERE lower(email) = lower('$MAIL');")"
    case "$out" in *ERROR*) echo "  уборка virtual_users: $out" ;; esac

    echo "  ящик $MAIL удалён полностью"
done
