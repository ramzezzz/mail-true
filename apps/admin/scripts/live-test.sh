#!/usr/bin/env bash
# ==================================================================
# Живая проверка админки Mail.True против ПОДНЯТОГО почтового стека.
# Повторяемая: чистит за собой и может запускаться сколько угодно раз.
#
#   bash apps/admin/scripts/live-test.sh
#
# Что проверяется (главное — что админка создаёт РАБОЧИЕ ящики,
# а не строки в таблице):
#   1.  миграция 0003 применяется к работающей базе
#   2.  создаётся администратор, вход в админку выдаёт сессию
#   3.  почтовые учётные данные в админку не пускают и наоборот
#   4.  права проверяются на сервере (роль «только чтение» получает 403)
#   5.  через API создаётся почтовый ящик
#   6.  ящик РЕАЛЬНО работает: вход по IMAP + приём письма по SMTP + чтение
#   7.  блокировка через API закрывает вход по IMAP, разблокировка возвращает
#   8.  смена пароля через API действует на IMAP
#   9.  вход администратора в ящик служебным доступом Dovecot:
#       причина обязательна, письмо видно, отправка запрещена,
#       запись появилась в журнале
#   10. журнал аудита пополняется на каждое изменяющее действие
#   11. импорт из CSV: предпросмотр и создание
#   12. проверка DNS отвечает понятным отчётом
#   13. почтовый стек цел — infra/test-delivery.sh остаётся зелёным
# ==================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")
set -a; . "$INFRA_DIR/.env"; set +a

# Отдельный порт, чтобы не мешать уже запущенному API разработчика
API_PORT="${ADMIN_LIVETEST_PORT:-3011}"
API_URL="http://127.0.0.1:$API_PORT"
COOKIES="$(mktemp -t mt-admin-cookies.XXXXXX)"
COOKIES_RO="$(mktemp -t mt-admin-cookies-ro.XXXXXX)"
API_LOG="$(mktemp -t mt-admin-api.XXXXXX.log)"

STAMP="$(date +%s)"
ADMIN_LOGIN="livetest-$STAMP"
ADMIN_PASS="Zhivoj-Test-Parol-$STAMP"
ADMIN_RO_LOGIN="livetest-ro-$STAMP"
ADMIN_RO_PASS="Tolko-Chtenie-$STAMP"
BOX_USER="admbox$STAMP@${MAIL_DOMAIN}"
BOX_PASS="korobka-$STAMP"
IMPORT_A="imp-a-$STAMP@${MAIL_DOMAIN}"
IMPORT_B="imp-b-$STAMP@${MAIL_DOMAIN}"

PASS=0; FAIL=0
ok()   { echo "  [OK] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
info() { echo "  ... $1"; }

API_PID=""
cleanup() {
    echo
    echo "=== Уборка ==="
    if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
        kill "$API_PID" 2>/dev/null
        wait "$API_PID" 2>/dev/null
    fi
    # Тестовые ящики и администраторы уходят из базы
    "${COMPOSE[@]}" exec -T -e M1="$BOX_USER" -e M2="$IMPORT_A" -e M3="$IMPORT_B" \
        -e A1="$ADMIN_LOGIN" -e A2="$ADMIN_RO_LOGIN" postgres \
        sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
                 -c "DELETE FROM virtual_users WHERE email IN ('"'"'$M1'"'"','"'"'$M2'"'"','"'"'$M3'"'"')" \
                 -c "DELETE FROM admin_users WHERE login IN ('"'"'$A1'"'"','"'"'$A2'"'"')"' \
        >/dev/null 2>&1
    # ...а вместе с ними — их каталоги в хранилище и индексы Dovecot.
    # Раньше здесь убиралась только строка в базе, и от каждого прогона
    # оставался осиротевший Maildir: к разбору дефектов их накопилось десять.
    for BOX in "$BOX_USER" "$IMPORT_A" "$IMPORT_B"; do
        BOX_LOCAL="${BOX%@*}"; BOX_DOMAIN="${BOX#*@}"
        "${COMPOSE[@]}" exec -T dovecot sh -c \
            "rm -rf '/var/mail/vhosts/$BOX_DOMAIN/$BOX_LOCAL' '/var/mail/index/$BOX_DOMAIN/$BOX_LOCAL'" \
            >/dev/null 2>&1
    done
    rm -f "$COOKIES" "$COOKIES_RO" "$REQ_BODY" "$RES_BODY" "$CODE_FILE"
    echo "  временные ящики и администраторы удалены вместе с каталогами почты"
    echo "  (журнал аудита сохранён — он не чистится)"
    echo "  лог API: $API_LOG"
}
trap cleanup EXIT

# curl с админской cookie; печатает тело, код статуса кладёт в $(code).
# Тело запроса всегда идёт файлом: в аргументах командной строки Windows
# ломает кодировку UTF-8, и Content-Length перестаёт сходиться с телом.
# Код статуса пишется в файл: вызовы делаются в подоболочке $( ),
# и обычная переменная оттуда наружу не вернулась бы.
CODE_FILE="$(mktemp -t mt-admin-code.XXXXXX)"
REQ_BODY="$(mktemp -t mt-admin-req.XXXXXX.json)"
RES_BODY="$(mktemp -t mt-admin-res.XXXXXX.json)"
api() {
    local method="$1" path="$2" data="${3:-}" jar="${4:-$COOKIES}"
    if [ -n "$data" ]; then
        printf '%s' "$data" > "$REQ_BODY"
        curl -s -o "$RES_BODY" -w '%{http_code}' -X "$method" "$API_URL$path" \
                -H 'Content-Type: application/json' -b "$jar" -c "$jar" \
                --data-binary "@$REQ_BODY" > "$CODE_FILE"
    else
        curl -s -o "$RES_BODY" -w '%{http_code}' -X "$method" "$API_URL$path" \
                -b "$jar" -c "$jar" > "$CODE_FILE"
    fi
    cat "$RES_BODY"
}
# Код последнего запроса
code() { cat "$CODE_FILE"; }

# Значение поля верхнего уровня из JSON (без jq — его может не быть)
jget() {
    node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{
          const j=JSON.parse(s);
          const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],j);
          process.stdout.write(v===undefined||v===null?"":String(v));
        }catch{process.stdout.write("")}
      });' "$1"
}

# Вход по IMAP из контейнера postfix (у него есть curl и он в сети docker)
imap_login() {
    "${COMPOSE[@]}" exec -T postfix curl -s --max-time 10 \
        --url "imap://dovecot:143/INBOX" --user "$1:$2" -X "STATUS INBOX (MESSAGES)" 2>/dev/null
}

echo "==================================================================="
echo " Живая проверка админки Mail.True"
echo "==================================================================="

# ------------------------------------------------------------------
echo "=== 1. Стек и миграция 0003 ==="
for svc in postgres redis dovecot postfix; do
    state=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' "$svc" 2>/dev/null | awk '{print $2}')
    [ "$state" = "running" ] && ok "$svc запущен" || { bad "$svc: ${state:-нет}"; }
done

# Базовая схема вместо прежнего 0003_admin.sql: 36 файлов свёрнуты в один,
# и проверяем ровно то же свойство — схема накатывается на работающую базу
# повторно и без вреда. Свойство важнее номера файла: обновление боевого
# сервера начинается именно с повторного прогона.
if "${COMPOSE[@]}" exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        < "$INFRA_DIR/postgres/migrations/0001_baseline.sql" >/dev/null 2>&1; then
    ok "базовая схема применена к работающей базе (повторно — без вреда)"
else
    bad "базовая схема не применилась"
fi

TABLES=$("${COMPOSE[@]}" exec -T postgres psql -tAq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_name IN
       ('admin_users','admin_audit_log','admin_mailbox_access','domain_settings')" 2>/dev/null | tr -d '\r')
[ "$TABLES" = "4" ] && ok "все четыре таблицы админки на месте" || bad "таблиц админки: $TABLES из 4"

MASTER_FILE=$("${COMPOSE[@]}" exec -T dovecot sh -c 'wc -l < /etc/dovecot/master-users' 2>/dev/null | tr -d '\r ')
[ "${MASTER_FILE:-0}" -ge 1 ] && ok "служебный пользователь Dovecot настроен" \
    || bad "служебный пользователь Dovecot не настроен (DOVECOT_MASTER_USER в infra/.env)"

# ------------------------------------------------------------------
echo "=== 2. Сборка и запуск API с админкой ==="
( cd "$ROOT_DIR" && npm run build --workspace @mail-true/api ) >/dev/null 2>&1 \
    && ok "apps/api собран без ошибок типов" || bad "сборка apps/api не прошла"
( cd "$ROOT_DIR" && npm run test --workspace @mail-true/api ) >/dev/null 2>&1 \
    && ok "юнит-тесты apps/api зелёные" || bad "юнит-тесты apps/api не прошли"
( cd "$ROOT_DIR" && npm run build --workspace @mail-true/admin ) >/dev/null 2>&1 \
    && ok "apps/admin собран без ошибок типов" || bad "сборка apps/admin не прошла"
( cd "$ROOT_DIR" && npm run test --workspace @mail-true/admin ) >/dev/null 2>&1 \
    && ok "юнит-тесты apps/admin зелёные" || bad "юнит-тесты apps/admin не прошли"

export ADMIN_DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:${POSTGRES_PORT:-5432}/$POSTGRES_DB"
export DOVECOT_MASTER_USER DOVECOT_MASTER_PASSWORD MAIL_DOMAIN MAIL_HOSTNAME
export PORT="$API_PORT"

( cd "$ROOT_DIR/apps/api" && PORT="$API_PORT" node dist/server.js ) >"$API_LOG" 2>&1 &
API_PID=$!
for i in $(seq 1 30); do
    curl -s --max-time 2 "$API_URL/healthz" >/dev/null 2>&1 && break
    sleep 1
done
if curl -s --max-time 2 "$API_URL/healthz" | grep -q '"ok":true'; then
    ok "API поднялся на порту $API_PORT"
else
    bad "API не поднялся; лог: $API_LOG"; tail -20 "$API_LOG"; exit 1
fi

# ------------------------------------------------------------------
echo "=== 3. Администраторы и вход ==="
( cd "$ROOT_DIR/apps/api" && node dist/admin/cli.js create-admin "$ADMIN_LOGIN" "$ADMIN_PASS" owner ) >/dev/null 2>&1 \
    && ok "администратор $ADMIN_LOGIN создан (роль owner)" || bad "не удалось создать администратора"
( cd "$ROOT_DIR/apps/api" && node dist/admin/cli.js create-admin "$ADMIN_RO_LOGIN" "$ADMIN_RO_PASS" readonly ) >/dev/null 2>&1 \
    && ok "администратор $ADMIN_RO_LOGIN создан (роль readonly)" || bad "не удалось создать readonly-администратора"

BODY=$(api GET /api/admin/overview)
[ "$(code)" = "401" ] && ok "без входа админка отвечает 401" || bad "без входа получен код $(code)"

BODY=$(api POST /api/admin/auth/login "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"неверный\"}")
[ "$(code)" = "401" ] && ok "неверный пароль администратора отклонён" || bad "неверный пароль дал код $(code)"

BODY=$(api POST /api/admin/auth/login "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASS\"}")
if [ "$(code)" = "200" ]; then
    ok "вход в админку выполнен, роль: $(printf '%s' "$BODY" | jget role)"
else
    bad "вход в админку не удался (код $(code)): $BODY"
fi

# Почтовые учётные данные в админку не пускают
BODY=$(api POST /api/admin/auth/login "{\"login\":\"test@$MAIL_DOMAIN\",\"password\":\"test12345\"}")
[ "$(code)" = "401" ] && ok "почтовые учётные данные в админку не пускают" \
    || bad "почтовый пользователь вошёл в админку (код $(code))"

# Админская cookie не даёт доступа к почтовым маршрутам
BODY=$(api GET /api/account)
[ "$(code)" = "401" ] && ok "админская сессия не открывает почтовые маршруты" \
    || bad "админская сессия пустила в /api/account (код $(code))"

BODY=$(api GET /api/admin/auth/session)
[ "$(printf '%s' "$BODY" | jget masterAccess)" = "true" ] \
    && ok "API видит настроенный служебный доступ Dovecot" \
    || bad "API не видит служебный доступ Dovecot"

# ------------------------------------------------------------------
echo "=== 4. Проверка прав на сервере ==="
api POST /api/admin/auth/login "{\"login\":\"$ADMIN_RO_LOGIN\",\"password\":\"$ADMIN_RO_PASS\"}" "$COOKIES_RO" >/dev/null
BODY=$(api GET /api/admin/users "" "$COOKIES_RO")
[ "$(code)" = "200" ] && ok "readonly: список ящиков читается" || bad "readonly не смог прочитать список (код $(code))"
BODY=$(api POST /api/admin/users "{\"email\":\"ro-test@$MAIL_DOMAIN\",\"password\":\"parol12345\"}" "$COOKIES_RO")
[ "$(code)" = "403" ] && ok "readonly: создание ящика запрещено (403)" || bad "readonly создал ящик! код $(code)"
BODY=$(api GET /api/admin/admins "" "$COOKIES_RO")
[ "$(code)" = "403" ] && ok "readonly: список администраторов закрыт (403)" || bad "readonly увидел администраторов (код $(code))"

# ------------------------------------------------------------------
echo "=== 5. Создание почтового ящика через API ==="
BODY=$(api POST /api/admin/users \
    "{\"email\":\"$BOX_USER\",\"password\":\"$BOX_PASS\",\"displayName\":\"Живой Тест\",\"quotaBytes\":1073741824}")
USER_ID=$(printf '%s' "$BODY" | jget id)
if [ "$(code)" = "201" ] && [ -n "$USER_ID" ]; then
    ok "ящик $BOX_USER создан через API (id=$USER_ID)"
else
    bad "создание ящика не удалось (код $(code)): $BODY"
fi

BODY=$(api POST /api/admin/users "{\"email\":\"$BOX_USER\",\"password\":\"parol12345\"}")
[ "$(code)" = "409" ] && ok "повторное создание того же адреса отклонено (409)" || bad "дубликат создался (код $(code))"

# ------------------------------------------------------------------
echo "=== 6. Ящик действительно рабочий (IMAP + SMTP) ==="
if imap_login "$BOX_USER" "$BOX_PASS" | grep -q "STATUS"; then
    ok "вход по IMAP с паролем, заданным админкой, работает"
else
    bad "IMAP не пустил только что созданного пользователя"
fi

TOKEN="adm$STAMP"
if "${COMPOSE[@]}" exec -T postfix swaks --server postfix:25 --helo client.example.com \
        --from sender@example.com --to "$BOX_USER" \
        --header "Subject: admin-livetest $TOKEN" --body "telo-$TOKEN" >/dev/null 2>&1; then
    ok "письмо принято Postfix для нового ящика"
else
    bad "Postfix не принял письмо для нового ящика"
fi

DELIVERED=""
for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T dovecot doveadm search -u "$BOX_USER" \
            mailbox INBOX HEADER Subject "$TOKEN" 2>/dev/null | grep -q .; then
        DELIVERED=1; break
    fi
    sleep 1
done
[ -n "$DELIVERED" ] && ok "письмо доставлено в Maildir нового ящика (~${i}s)" \
    || bad "письмо не дошло за 30 секунд"

SEQ=$("${COMPOSE[@]}" exec -T postfix curl -s --url "imap://dovecot:143/INBOX" \
        --user "$BOX_USER:$BOX_PASS" -X "SEARCH SUBJECT \"$TOKEN\"" 2>/dev/null \
        | tr -d '\r' | sed 's/^\* SEARCH //' | awk '{print $NF}')
if [ -n "$SEQ" ]; then
    MSG=$("${COMPOSE[@]}" exec -T postfix curl -s --url "imap://dovecot:143/INBOX;MAILINDEX=$SEQ" \
            --user "$BOX_USER:$BOX_PASS" 2>/dev/null)
    printf '%s' "$MSG" | grep -q "telo-$TOKEN" && ok "письмо прочитано по IMAP владельцем ящика" \
        || bad "тело письма не совпало"
else
    bad "IMAP SEARCH не нашёл письмо в новом ящике"
fi

# ------------------------------------------------------------------
echo "=== 7. Изменение и блокировка ==="
BODY=$(api PATCH "/api/admin/users/$USER_ID" '{"displayName":"Пере Именован","quotaBytes":2147483648}')
if [ "$(code)" = "200" ] && [ "$(printf '%s' "$BODY" | jget quotaBytes)" = "2147483648" ]; then
    ok "имя и квота изменены через API"
else
    bad "изменение имени/квоты не удалось (код $(code)): $BODY"
fi
BODY=$(api PATCH "/api/admin/users/$USER_ID" '{"active":false}')
[ "$(code)" = "200" ] && ok "ящик заблокирован через API" || bad "блокировка не удалась (код $(code))"
sleep 1
if imap_login "$BOX_USER" "$BOX_PASS" | grep -q "STATUS"; then
    bad "заблокированный пользователь ВСЁ ЕЩЁ входит по IMAP"
else
    ok "заблокированный пользователь по IMAP не входит"
fi

BODY=$(api PATCH "/api/admin/users/$USER_ID" '{"active":true}')
sleep 1
imap_login "$BOX_USER" "$BOX_PASS" | grep -q "STATUS" \
    && ok "после разблокировки вход по IMAP снова работает" \
    || bad "после разблокировки вход не восстановился"

# ------------------------------------------------------------------
echo "=== 8. Смена пароля через API ==="
NEW_PASS="novyj-$STAMP"
BODY=$(api POST "/api/admin/users/$USER_ID/password" "{\"password\":\"$NEW_PASS\"}")
[ "$(code)" = "200" ] && ok "пароль сменён через API" || bad "смена пароля не удалась (код $(code))"
sleep 1
imap_login "$BOX_USER" "$NEW_PASS" | grep -q "STATUS" \
    && ok "новый пароль принимается Dovecot" || bad "новый пароль Dovecot не принял"
imap_login "$BOX_USER" "$BOX_PASS" | grep -q "STATUS" \
    && bad "старый пароль всё ещё работает" || ok "старый пароль больше не работает"

BODY=$(api POST "/api/admin/users/$USER_ID/password" '{}')
GEN_PASS=$(printf '%s' "$BODY" | jget generatedPassword)
if [ -n "$GEN_PASS" ]; then
    sleep 1
    imap_login "$BOX_USER" "$GEN_PASS" | grep -q "STATUS" \
        && ok "сгенерированный админкой пароль тоже рабочий" \
        || bad "сгенерированный пароль Dovecot не принял"
else
    bad "API не вернул сгенерированный пароль"
fi

# ------------------------------------------------------------------
echo "=== 9. Вход администратора в ящик пользователя ==="
BODY=$(api POST /api/admin/mailbox/enter "{\"email\":\"$BOX_USER\"}")
[ "$(code)" = "400" ] && ok "без причины вход в ящик запрещён (400)" || bad "вход без причины дал код $(code)"

REASON="Обращение в поддержку №$STAMP: пользователь не видит письмо от контрагента"
BODY=$(api POST /api/admin/mailbox/enter "{\"email\":\"$BOX_USER\",\"reason\":\"$REASON\"}")
if [ "$(code)" = "200" ] && [ "$(printf '%s' "$BODY" | jget adminSession)" = "true" ]; then
    ok "администратор вошёл в ящик служебным доступом (сеанс помечен административным)"
else
    bad "вход администратора в ящик не удался (код $(code)): $BODY"
fi
[ "$(printf '%s' "$BODY" | jget canSend)" = "false" ] && ok "сеанс помечен как «отправка запрещена»" \
    || bad "сеанс не помечен запретом отправки"

BODY=$(api GET /api/admin/mailbox/folders)
printf '%s' "$BODY" | grep -q "INBOX" && ok "папки чужого ящика читаются без пароля владельца" \
    || bad "папки не прочитались (код $(code)): $BODY"

BODY=$(api GET "/api/admin/mailbox/messages?path=INBOX&limit=20")
printf '%s' "$BODY" | grep -q "admin-livetest $TOKEN" \
    && ok "то самое письмо видно администратору в ящике пользователя" \
    || bad "письмо не найдено в списке администратора: $BODY"

BODY=$(api POST /api/admin/mailbox/send '{"to":"a@b.c","subject":"x","text":"y"}')
[ "$(code)" = "403" ] && ok "отправка письма в административном режиме запрещена (403)" \
    || bad "отправка в административном режиме НЕ запрещена (код $(code))"

BODY=$(api GET "/api/admin/audit/mailbox-access?mailbox=$BOX_USER")
if printf '%s' "$BODY" | grep -q "Обращение в поддержку №$STAMP"; then
    ok "вход записан в журнал вместе с причиной"
else
    bad "записи о входе в журнале нет: $BODY"
fi

BODY=$(api POST /api/admin/mailbox/leave)
[ "$(code)" = "200" ] && ok "сеанс входа в ящик закрыт" || bad "сеанс не закрылся (код $(code))"
BODY=$(api GET /api/admin/mailbox/folders)
[ "$(code)" = "401" ] && ok "после выхода чужой ящик снова недоступен" \
    || bad "после выхода ящик всё ещё доступен (код $(code))"

# ------------------------------------------------------------------
echo "=== 10. Журнал аудита ==="
BODY=$(api GET "/api/admin/audit?search=$BOX_USER&limit=50")
for action in user.create user.update user.password user.block mailbox.impersonate; do
    printf '%s' "$BODY" | grep -q "\"$action\"" && ok "в журнале есть действие $action" \
        || bad "в журнале нет действия $action"
done
printf '%s' "$BODY" | grep -qi "$BOX_PASS" && bad "ПАРОЛЬ ПОПАЛ В ЖУРНАЛ АУДИТА" \
    || ok "паролей в журнале нет"

BODY=$(api GET "/api/admin/audit?action=admin.login.failed&limit=5")
printf '%s' "$BODY" | grep -q "admin.login.failed" && ok "неудачные входы тоже пишутся в журнал" \
    || bad "неудачный вход в журнал не попал"

# ------------------------------------------------------------------
echo "=== 11. Импорт из CSV ==="
CSV="email,name,password,quota\\n$IMPORT_A,Первый Импорт,parol12345,500M\\n$IMPORT_B,Второй Импорт,,1G\\nсовсем-не-адрес,Плохая Строка,parol12345,1G"
BODY=$(api POST /api/admin/users/import/preview "{\"csv\":\"$CSV\"}")
VALID=$(printf '%s' "$BODY" | jget validCount)
INVALID=$(printf '%s' "$BODY" | jget invalidCount)
[ "$VALID" = "2" ] && [ "$INVALID" = "1" ] \
    && ok "предпросмотр импорта: 2 годных, 1 отброшена — до создания" \
    || bad "предпросмотр посчитал $VALID годных / $INVALID плохих: $BODY"
printf '%s' "$BODY" | grep -q "parol12345" && bad "предпросмотр вернул пароли открытым текстом" \
    || ok "предпросмотр не отдаёт пароли"

COUNT_BEFORE=$("${COMPOSE[@]}" exec -T postgres psql -tAq -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT count(*) FROM virtual_users WHERE email LIKE 'imp-%$STAMP@%'" 2>/dev/null | tr -d '\r ')
[ "$COUNT_BEFORE" = "0" ] && ok "предпросмотр ничего не создал в базе" || bad "предпросмотр уже создал ящики!"

# Импорт — задание: ответ приходит сразу, результат забирается по номеру.
# Так сделано затем, чтобы обрыв связи не уносил с собой сгенерированные
# пароли: раньше они существовали только в теле ответа.
BODY=$(api POST /api/admin/users/import "{\"csv\":\"$CSV\"}")
JOB_ID=$(printf '%s' "$BODY" | jget jobId)
[ -n "$JOB_ID" ] && ok "импорт запущен как задание №$JOB_ID" || bad "импорт не вернул номер задания: $BODY"

JOB=""
for _ in $(seq 1 30); do
    JOB=$(api GET "/api/admin/users/import/jobs/$JOB_ID")
    [ "$(printf '%s' "$JOB" | jget state)" = "running" ] || break
    sleep 1
done
printf '%s' "$JOB" | grep -q "$IMPORT_A" && ok "импорт создал ящики" || bad "импорт не создал ящики: $JOB"

# Главное в этом дефекте: результат переживает обрыв связи. Проверяем,
# что тот же результат отдаётся повторно — то есть лежит на сервере.
JOB2=$(api GET "/api/admin/users/import/jobs/$JOB_ID")
printf '%s' "$JOB2" | grep -q "$IMPORT_B" \
    && ok "результат импорта (и пароли) забирается повторно — обрыв связи его не теряет" \
    || bad "повторный запрос результата импорта ничего не вернул: $JOB2"
sleep 1
imap_login "$IMPORT_A" "parol12345" | grep -q "STATUS" \
    && ok "импортированный ящик работает по IMAP" || bad "импортированный ящик по IMAP не пускает"

# ------------------------------------------------------------------
echo "=== 12. Домены и проверка DNS ==="
BODY=$(api GET /api/admin/domains)
DOMAIN_ID=$(node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const j=JSON.parse(s);const d=(j.items||[]).find(x=>x.name===process.argv[1]);
      process.stdout.write(d?String(d.id):"")}catch{process.stdout.write("")}});' "$MAIL_DOMAIN" <<<"$BODY")
[ -n "$DOMAIN_ID" ] && ok "домен $MAIL_DOMAIN виден в админке (id=$DOMAIN_ID)" || bad "домен не найден: $BODY"

BODY=$(api POST "/api/admin/domains/$DOMAIN_ID/dns-check")
CHECKS=$(node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const j=JSON.parse(s);process.stdout.write(String((j.checks||[]).length))}catch{process.stdout.write("0")}});' <<<"$BODY")
[ "$CHECKS" = "7" ] && ok "проверка DNS вернула все 7 записей (MX/SPF/DKIM/DMARC/PTR/autoconfig/autodiscover)" \
    || bad "проверка DNS вернула $CHECKS проверок: $BODY"
printf '%s' "$BODY" | grep -q '"hint"' && ok "у каждой проверки есть человеческая подсказка" \
    || bad "подсказок в отчёте DNS нет"
printf '%s' "$BODY" | grep -q "v=spf1" && ok "готовая строка SPF для копирования есть" || bad "нет готовой строки SPF"

# ------------------------------------------------------------------
echo "=== 13. Сводка состояния ==="
BODY=$(api GET /api/admin/overview)
printf '%s' "$BODY" | grep -q '"services"' && ok "сводка отдаёт состояние сервисов" || bad "сводка не отдала services"
printf '%s' "$BODY" | grep -q '"counters"' && ok "сводка отдаёт счётчики" || bad "сводка не отдала counters"

# ------------------------------------------------------------------
echo "=== 14. Удаление ящика (право есть только у owner) ==="
BODY=$(api DELETE "/api/admin/users/$USER_ID" "" "$COOKIES_RO")
[ "$(code)" = "403" ] && ok "readonly не может удалить ящик" || bad "readonly удалил ящик (код $(code))"

# ------------------------------------------------------------------
echo "=== 15. Почтовый стек цел ==="
if bash "$INFRA_DIR/test-delivery.sh" >/tmp/mt-delivery.log 2>&1; then
    ok "infra/test-delivery.sh зелёный"
else
    bad "infra/test-delivery.sh покраснел — см. /tmp/mt-delivery.log"
    tail -25 /tmp/mt-delivery.log
fi

echo
echo "==================================================================="
echo " ИТОГ: OK=$PASS, FAIL=$FAIL"
echo "==================================================================="
[ "$FAIL" -eq 0 ] || exit 1
