#!/usr/bin/env bash
# ------------------------------------------------------------------
# Смена основного домена: часть, которую делает СЕРВЕР
# ------------------------------------------------------------------
# Панель («Смена домена») уже сделала всё, что живёт в базе и в томе
# писем: адреса ящиков, алиасы, настройки людей, каталоги почты, выпуск
# ключа DKIM. Почта на новый домен ходит с этого момента — карты Postfix
# и запросы Dovecot читаются прямо из базы.
#
# Осталось то, до чего панель дотянуться не может и не должна:
#
#   * ключ DKIM в томе rspamd            (том смонтирован только в rspamd)
#   * новый домен в списке своих         (maps.d, каталог контейнера rspamd)
#   * MAIL_DOMAIN / MAIL_HOSTNAME        (infra/.env, файл на хосте)
#   * server_name в nginx                (шаблон разворачивается при старте)
#   * TLS-сертификаты                    (файлы на хосте)
#
# Чтобы панель делала это сама, ей нужен сокет Docker. Сокет Docker — это
# права root на всей машине; отдать их серверу приложения, смотрящему в
# интернет, ради удобства одной операции нельзя. Поэтому здесь скрипт,
# который запускает человек с доступом к серверу.
#
# Запуск:
#     sudo bash infra/scripts/change-domain.sh
#     sudo bash infra/scripts/change-domain.sh --dry-run   # показать и выйти
#
# Скрипт идемпотентен: повторный запуск после успешного ничего не ломает.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Файл настроек и имя проекта можно переопределить: на одной машине
# держат больше одного стека (стенд рядом с боевым), и скрипт, жёстко
# прибитый к infra/.env, перенастроил бы не тот.
ENV_FILE="${MT_ENV_FILE:-$INFRA_DIR/.env}"
CERT_DIR="${MT_CERT_DIR:-$INFRA_DIR/data/certs}"
#
# БОЕВОЕ ПЕРЕОПРЕДЕЛЕНИЕ ОБЯЗАТЕЛЬНО.
#
# Публикация почтовых и веб-портов наружу живёт ТОЛЬКО в
# install/compose.prod.yml (`${BIND_ADDRESS:-0.0.0.0}:…`). В базовом файле
# те же порты слушают 127.0.0.1 — так задумано, чтобы разработка на своей
# машине не выставляла почтовый сервер в сеть.
#
# Скрипт пересоздаёт службы (`up -d --force-recreate` ниже). Без этого
# файла пересоздание перевешивало 25/587/465/143/993/110/995/80/443 на
# loopback: чужие почтовые серверы перестают доставлять письма, клиенты не
# подключаются, и ни одна из служб об этом не сообщает — они здоровы.
# Заодно терялись COOKIE_SECURE, FORCE_HTTPS, боевой CORS_ORIGIN, скрытие
# порта 3000 у api и ограничения размера журналов. Всё это — после смены
# домена, то есть ровно тогда, когда за сервером и так следят с тревогой.
#
# Тот же набор собирает compose_args() в install/lib/common.sh; здесь он
# повторён потому, что скрипт запускают отдельно от установщика.
COMPOSE_PROD="${MT_COMPOSE_PROD:-$INFRA_DIR/../install/compose.prod.yml}"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")
if [ -f "$COMPOSE_PROD" ] && [ "${MT_USE_PROD_OVERRIDE:-1}" = "1" ]; then
    COMPOSE+=(-f "$COMPOSE_PROD")
fi
COMPOSE+=(--env-file "$ENV_FILE")
[ -n "${MT_PROJECT:-}" ] && COMPOSE+=(-p "$MT_PROJECT")
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say()  { printf '%s\n' "$*"; }
fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "не найден $ENV_FILE — запускайте из каталога установки"

# ------------------------------------------------------------------
# 1. Что именно поменялось
# ------------------------------------------------------------------
# Источник истины — БАЗА, а не аргументы командной строки. Домен, набранный
# здесь руками, разошёлся бы с тем, на который панель уже перевела ящики,
# и разошёлся бы молча.
say '== Читаю выполненную смену домена из базы =='
DC_OUTPUT="$("${COMPOSE[@]}" exec -T api node apps/api/dist/admin/cli.js domain-change-last 2>/dev/null)" \
    || fail "выполненных смен домена в базе нет — сначала выполните смену в панели"

# shellcheck disable=SC2046
eval "$DC_OUTPUT"

: "${DC_ID:?}" "${DC_NEW_DOMAIN:?}" "${DC_OLD_DOMAIN:?}" "${DC_NEW_HOSTNAME:?}"
: "${DC_DKIM_SELECTOR:=mail}" "${DC_HAS_KEY:=0}"

say "  было:  $DC_OLD_DOMAIN  (сервер $DC_OLD_HOSTNAME)"
say "  стало: $DC_NEW_DOMAIN  (сервер $DC_NEW_HOSTNAME)"
say "  ключ DKIM: селектор $DC_DKIM_SELECTOR, сохранён в базе: $([ "$DC_HAS_KEY" = 1 ] && echo да || echo нет)"

if [ "$DRY_RUN" = 1 ]; then
    say ''
    say 'Пробный запуск: ничего не менял.'
    exit 0
fi

# ------------------------------------------------------------------
# 2. Ключ DKIM в том rspamd
# ------------------------------------------------------------------
# Кладём ключ ДО правки .env: если что-то пойдёт не так, стек ещё не
# перезапускался и продолжает работать со старым доменом.
if [ "$DC_HAS_KEY" = 1 ]; then
    say '== Кладу ключ DKIM нового домена в том rspamd =='
    KEY_NAME="$DC_NEW_DOMAIN.$DC_DKIM_SELECTOR.key"
    TMP_KEY="$(mktemp)"
    trap 'rm -f "$TMP_KEY"' EXIT
    "${COMPOSE[@]}" exec -T api node apps/api/dist/admin/cli.js domain-change-key "$DC_ID" > "$TMP_KEY" \
        || fail "не удалось получить ключ (нет ADMIN_SESSION_SECRET/SESSION_SECRET?)"
    [ -s "$TMP_KEY" ] || fail 'получен пустой ключ DKIM'

    # `exec -T … tee` вместо `docker cp`: контейнер может быть пересоздан
    # между командами, а тут всё делается одним заходом внутрь работающего.
    "${COMPOSE[@]}" exec -T rspamd sh -c \
        "mkdir -p /var/lib/rspamd/dkim && cat > /var/lib/rspamd/dkim/$KEY_NAME \
         && chown _rspamd:_rspamd /var/lib/rspamd/dkim/$KEY_NAME \
         && chmod 600 /var/lib/rspamd/dkim/$KEY_NAME" < "$TMP_KEY" \
        || fail 'не удалось положить ключ в контейнер rspamd'
    rm -f "$TMP_KEY"
    trap - EXIT
    say "  готово: /var/lib/rspamd/dkim/$KEY_NAME"
    say "  ВАЖНО: запись $DC_DKIM_SELECTOR._domainkey.$DC_NEW_DOMAIN должна быть уже"
    say '         опубликована в DNS — её показывала панель на шаге плана.'
else
    say '== Ключа DKIM в базе нет — выпускаю на сервере =='
    "${COMPOSE[@]}" exec -T rspamd sh -c \
        "rspamadm dkim_keygen -d '$DC_NEW_DOMAIN' -s '$DC_DKIM_SELECTOR' -b 2048 \
            -k /var/lib/rspamd/dkim/$DC_NEW_DOMAIN.$DC_DKIM_SELECTOR.key \
          > /var/lib/rspamd/dkim/$DC_NEW_DOMAIN.$DC_DKIM_SELECTOR.dns.txt \
         && chown -R _rspamd:_rspamd /var/lib/rspamd/dkim"
    say '  запись для DNS:'
    "${COMPOSE[@]}" exec -T rspamd cat \
        "/var/lib/rspamd/dkim/$DC_NEW_DOMAIN.$DC_DKIM_SELECTOR.dns.txt"
    say '  ОПУБЛИКУЙТЕ ЕЁ — до этого письма с нового домена идут без подписи.'
fi

# Старый ключ НЕ удаляем: старый домен продолжает принимать почту и
# отправлять от своего имени (алиасы «старый адрес → новый» позволяют это
# штатно), а без ключа его письма перестали бы проходить проверку.

# ------------------------------------------------------------------
# 3. Новый домен в списке своих
# ------------------------------------------------------------------
#
# Дописываем в ЖИВУЮ карту внутри контейнера, а не в заготовку из дерева.
#
# infra/rspamd/maps.d — это семя, примонтированное только для чтения
# (/etc/rspamd/maps.seed). Рабочие списки лежат в томе rspamd-maps, и
# точка входа копирует туда семя ТОЛЬКО когда файла ещё нет. На сервере,
# который хоть раз запускался, дописанная в семя строка не доезжала до
# rspamd никогда: новый домен оставался чужим, и своя же почта с него
# оценивалась как внешняя.
#
# Вторая половина той же беды: файл семени отслеживается git, и правка
# рабочего дерева ломала обновление через `git pull` — «Your local changes
# would be overwritten». Ради этого карты и уехали в том.
say "== Добавляю $DC_NEW_DOMAIN в local_domains.map =="
"${COMPOSE[@]}" exec -T rspamd sh -c "
    MAP=/etc/rspamd/maps.d/local_domains.map
    [ -f \"\$MAP\" ] || exit 0
    grep -qx '$DC_NEW_DOMAIN' \"\$MAP\" && exit 0
    echo '$DC_NEW_DOMAIN' >> \"\$MAP\"
    chown _rspamd:_rspamd \"\$MAP\" 2>/dev/null || true
" || say '  ПРЕДУПРЕЖДЕНИЕ: не удалось дописать домен — проверьте раздел «Спам» в панели'

# ------------------------------------------------------------------
# 4. infra/.env
# ------------------------------------------------------------------
say '== Правлю infra/.env =='
cp -p "$ENV_FILE" "$ENV_FILE.before-domain-change-$DC_ID"
say "  прежний файл сохранён: $ENV_FILE.before-domain-change-$DC_ID"

set_env() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        # Значение подставляем через awk, а не sed: домен содержит точки,
        # а в правой части sed-замены ещё и «&» имеет особый смысл.
        # Результат кладётся ПОВЕРХ прежнего файла, а не переименовывается
        # на его место. Разница не стилистическая: infra/.env примонтирован
        # в посредник отдельным файлом, а такой bind-mount держит не имя, а
        # конкретный файл на диске. После mv контейнер остался бы со старым
        # файлом-призраком: тот же путь, разное содержимое — и настройки из
        # панели молча перестали бы доходить до служб.
        awk -v k="$key" -v v="$value" \
            'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
            "$ENV_FILE" > "$ENV_FILE.tmp" && cat "$ENV_FILE.tmp" > "$ENV_FILE"
        rm -f "$ENV_FILE.tmp"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
    say "  $key=$value"
}
set_env MAIL_DOMAIN "$DC_NEW_DOMAIN"
set_env MAIL_HOSTNAME "$DC_NEW_HOSTNAME"
set_env DKIM_SELECTOR "$DC_DKIM_SELECTOR"

# ------------------------------------------------------------------
# 5. Сертификаты
# ------------------------------------------------------------------
# Самоподписанный перевыпускаем сразу на ОБА домена. Старые имена
# (mail.старый, admin.старый) остаются рабочими: старый домен продолжает
# принимать почту, и люди какое-то время будут ходить по прежним ссылкам.
# Сертификат, покрывающий только новое имя, сломал бы им вход в тот же
# день, а выигрыша не дал бы никакого.
if [ -f "$CERT_DIR/mail.crt" ] && openssl x509 -in "$CERT_DIR/mail.crt" -noout -issuer 2>/dev/null \
        | grep -qi "Let's Encrypt\|ISRG"; then
    say '== Сертификат выписан Let'"'"'s Encrypt — не трогаю =='
    say '   Его нельзя перевыпустить с этой машины без подтверждения владения'
    say "   новым доменом. Что нужно сделать администратору:"
    say "     1) убедиться, что A-запись $DC_NEW_HOSTNAME ведёт на этот сервер;"
    say "     2) выпустить сертификат на все имена сразу, например:"
    say "        certbot certonly --webroot -w /var/www/html \\"
    say "          -d $DC_NEW_HOSTNAME -d mail.$DC_NEW_DOMAIN -d admin.$DC_NEW_DOMAIN \\"
    say "          -d autoconfig.$DC_NEW_DOMAIN \\"
    say "          -d $DC_OLD_HOSTNAME -d mail.$DC_OLD_DOMAIN -d admin.$DC_OLD_DOMAIN"
    say "     3) положить fullchain.pem в $CERT_DIR/mail.crt, privkey.pem в mail.key;"
    say "     4) повторить этот скрипт или перезапустить nginx, dovecot и postfix."
    say '   До этого почтовые клиенты будут ругаться на несовпадение имени.'
else
    say '== Перевыпускаю самоподписанный сертификат на оба домена =='
    mkdir -p "$CERT_DIR"
    [ -f "$CERT_DIR/mail.crt" ] && cp -p "$CERT_DIR/mail.crt" "$CERT_DIR/mail.crt.before-$DC_ID"
    [ -f "$CERT_DIR/mail.key" ] && cp -p "$CERT_DIR/mail.key" "$CERT_DIR/mail.key.before-$DC_ID"
    SAN="DNS:$DC_NEW_HOSTNAME,DNS:$DC_NEW_DOMAIN,DNS:*.$DC_NEW_DOMAIN"
    SAN="$SAN,DNS:$DC_OLD_HOSTNAME,DNS:$DC_OLD_DOMAIN,DNS:*.$DC_OLD_DOMAIN"
    SAN="$SAN,DNS:localhost,IP:127.0.0.1"
    ( cd "$CERT_DIR" && MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout mail.key -out mail.crt \
        -subj "/CN=$DC_NEW_HOSTNAME/O=Mail.True" \
        -addext "subjectAltName=$SAN" ) >/dev/null 2>&1 \
        || fail 'не удалось выпустить сертификат (нет openssl?)'
    say "  готово: $CERT_DIR/mail.crt (имена: $SAN)"
fi

# ------------------------------------------------------------------
# 6. Перезапуск
# ------------------------------------------------------------------
# Пересоздаём только тех, кто читает MAIL_DOMAIN/MAIL_HOSTNAME при старте.
# Postgres, Redis и unbound трогать незачем: чем меньше пересоздаётся, тем
# короче простой.
say '== Пересоздаю контейнеры, зависящие от домена =='
"${COMPOSE[@]}" up -d --force-recreate nginx autoconfig rspamd postfix dovecot api

say ''
say 'Готово.'
say "  1. Проверьте раздел «Домены» в панели: записи $DC_NEW_DOMAIN должны быть видны."
say "  2. Панель теперь и на https://admin.$DC_NEW_DOMAIN, почта на https://mail.$DC_NEW_DOMAIN."
say "  3. Людям нужно поменять имя пользователя в почтовых программах на «…@$DC_NEW_DOMAIN»:"
say "     старый адрес принимается, но входить под ним больше нельзя."
say "  4. Старый домен $DC_OLD_DOMAIN продолжает принимать почту через алиасы."
say "     Когда решите его отпустить — удалите алиасы в разделе «Алиасы», а затем сам домен."
