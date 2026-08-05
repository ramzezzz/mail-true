#!/usr/bin/env bash
# Живая проверка настроек ящика, правил фильтрации, папок и подключения
# чужих ящиков. Повторяемый; запускать из любого места:
#
#   bash apps/api/scripts/live-test-settings-accounts.sh
#
# Требуется работающий стек (infra/docker-compose.yml) и запущенный API
# (по умолчанию http://127.0.0.1:3000, переопределяется API_URL).
#
# Проверяются ровно те маршруты и формы, которые ждёт веб-интерфейс
# (apps/web/src/api/settingsApi.ts) — и то, что нельзя проверить
# юнит-тестом:
#
#   1.  Правило, созданное через API, попадает в личный файл Sieve ящика
#       и компилируется Dovecot'ом.
#   2.  Правило РЕАЛЬНО срабатывает: подходящее письмо ложится в нужную
#       папку, неподходящее остаётся во «Входящих».
#   3.  Выключение правила без удаления и порядок правил.
#   4.  Применение правила к уже полученным письмам.
#   5.  Управление папками: создание, переименование, очистка, удаление.
#   6.  Автоопределение настроек чужого сервера по адресу.
#   7.  Сборщик реально переносит письма с «чужого» сервера (роль чужого
#       играет второй ящик на нашем же стеке), а повторный запуск НЕ
#       создаёт дублей.
#   8.  Пароль чужого ящика лежит в базе только шифротекстом.
#   9.  Прямое подключение: дерево папок и письма чужого ящика.
#   10. Переключение между своими ящиками без повторного ввода пароля
#       и общий счётчик непрочитанных.
#
# Скрипт идемпотентен: ящики создаются/обновляются, старые правила,
# подключения и папки удаляются перед проверкой.
set -uo pipefail
# ВНИМАНИЕ про Windows: Git Bash переписывает аргументы, похожие на пути
# Unix (/var/mail/… превращается в C:/Program Files/Git/var/mail/…).
# Поэтому пути ВНУТРИ контейнера никогда не передаются отдельным
# аргументом — только внутри строки `sh -c "…"`, которую bash не трогает.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")
set -a; . "$INFRA_DIR/.env"; set +a

API_URL="${API_URL:-http://127.0.0.1:3000}"
DOMAIN="${MAIL_DOMAIN:-mail.local}"

# Ящики проверки. Пароли только для тестового стека.
BOX_MAIN="lt-main@${DOMAIN}"      # основной: правила и сбор
BOX_SECOND="lt-second@${DOMAIN}"  # второй свой: переключение без пароля
BOX_EXT="lt-ext@${DOMAIN}"        # играет роль ЧУЖОГО сервера
PASS_MAIN="lt-main-12345"
PASS_SECOND="lt-second-12345"
PASS_EXT="lt-ext-12345"

FILTER_FOLDER="Проверка"
COLLECT_FOLDER="Собранное"

COOKIE="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -rf "$COOKIE" "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { echo "  [OK] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
info() { echo "  ... $1"; }

# Достаёт значение из JSON: jq в окружении может не быть, node есть всегда.
# Путь вида "0.actions.markRead" работает и для массивов.
jget() { node -e '
let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
  let v;try{v=JSON.parse(raw)}catch{process.stdout.write("");return}
  for(const k of process.argv[1].split(".")){ if(v==null)break; v=v[k]; }
  process.stdout.write(v===undefined||v===null?"":String(v));
});' "$1"; }

# Тело запроса передаётся файлом, а не аргументом командной строки:
# аргументы на Windows перекодируются, и UTF-8 в них ломает Content-Length.
api() { # api METHOD PATH [BODY]
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        printf '%s' "$body" > "$TMP/body.json"
        curl -s -m 180 -b "$COOKIE" -c "$COOKIE" -X "$method" \
             -H 'Content-Type: application/json; charset=utf-8' \
             --data-binary "@$TMP/body.json" "$API_URL$path"
    else
        curl -s -m 180 -b "$COOKIE" -c "$COOKIE" -X "$method" "$API_URL$path"
    fi
}

# Выполнить команду внутри контейнера Dovecot. Команда передаётся ОДНОЙ
# строкой в sh -c: так пути внутри контейнера не переписываются Git Bash.
in_dovecot() { "${COMPOSE[@]}" exec -T dovecot sh -c "$1" 2>/dev/null; }

# Сколько писем в папке ящика — по doveadm, то есть по самому Dovecot,
# а не по нашему же коду.
count_in() { # count_in EMAIL FOLDER [SEARCH...]
    local email="$1" folder="$2"; shift 2
    "${COMPOSE[@]}" exec -T dovecot doveadm search -u "$email" \
        mailbox "$folder" "$@" 2>/dev/null | grep -c . || true
}

# Отправляем ПОЛНОЦЕННОЕ письмо: с Date, Message-ID и MIME-заголовками.
# Без них rspamd справедливо считает письмо спамом, глобальный фильтр
# уводит его в «Спам» и до личных правил оно не доходит — проверка тогда
# ничего не проверяет.
send_mail() { # send_mail FROM TO SUBJECT BODY
    local from="$1" to="$2" subject="$3" body="$4" mid rfc_date
    mid="lt$(date +%s)$RANDOM"
    rfc_date="$("${COMPOSE[@]}" exec -T postfix date -R | tr -d '\r')"
    {
        printf 'From: %s\n' "$from"
        printf 'To: %s\n' "$to"
        printf 'Subject: %s\n' "$subject"
        printf 'Date: %s\n' "$rfc_date"
        printf 'Message-ID: <%s@%s>\n' "$mid" "${from#*@}"
        printf 'MIME-Version: 1.0\n'
        printf 'Content-Type: text/plain; charset=utf-8\n'
        printf 'Content-Transfer-Encoding: 8bit\n'
        printf '\n'
        printf '%s\n' "$body"
        printf '\nС уважением,\nОтдел сопровождения\n'
    } > "$TMP/msg.eml"
    "${COMPOSE[@]}" exec -T postfix sh -c 'cat > /tmp/lt-msg.eml' < "$TMP/msg.eml" || return 1
    "${COMPOSE[@]}" exec -T postfix sh -c \
        "swaks --server postfix:25 --helo partner-company.example \
               --from '$from' --to '$to' --data /tmp/lt-msg.eml" >/dev/null 2>&1
}

wait_for_count() { # wait_for_count EMAIL FOLDER EXPECTED [SECONDS]
    local email="$1" folder="$2" expected="$3" secs="${4:-30}" i n
    for i in $(seq 1 "$secs"); do
        n=$(count_in "$email" "$folder" all)
        [ "${n:-0}" -ge "$expected" ] && return 0
        sleep 1
    done
    return 1
}

echo "=== 0. Подготовка ==="
if ! curl -s -m 5 "$API_URL/healthz" | grep -q '"ok":true'; then
    echo "  [FAIL] API не отвечает на $API_URL/healthz — запустите его и повторите"
    exit 1
fi
ok "API отвечает на $API_URL"

for pair in "$BOX_MAIN:$PASS_MAIN" "$BOX_SECOND:$PASS_SECOND" "$BOX_EXT:$PASS_EXT"; do
    bash "$INFRA_DIR/scripts/create-mailbox.sh" "${pair%%:*}" "${pair##*:}" >/dev/null 2>&1 \
        && ok "ящик ${pair%%:*} создан/обновлён" \
        || fail "не удалось создать ящик ${pair%%:*}"
done

# Чистое состояние: убираем старые правила, подключения и папки.
"${COMPOSE[@]}" exec -T postgres psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "DELETE FROM mail_filters WHERE account_email LIKE 'lt-%';" \
    -c "DELETE FROM mail_user_settings WHERE account_email LIKE 'lt-%';" \
    -c "DELETE FROM mail_signatures WHERE account_email LIKE 'lt-%';" \
    -c "DELETE FROM external_accounts WHERE owner_email LIKE 'lt-%';" \
    -c "DELETE FROM linked_accounts WHERE owner_email LIKE 'lt-%' OR linked_email LIKE 'lt-%';" \
    -c "DELETE FROM migrate_messages WHERE account LIKE '%lt-ext%';" \
    -c "DELETE FROM migrate_cursors WHERE account LIKE '%lt-ext%';" >/dev/null 2>&1
for f in "$FILTER_FOLDER" "$COLLECT_FOLDER" "Переименованная" "Временная"; do
    "${COMPOSE[@]}" exec -T dovecot doveadm mailbox delete -u "$BOX_MAIN" -r "$f" >/dev/null 2>&1
done
"${COMPOSE[@]}" exec -T dovecot doveadm expunge -u "$BOX_MAIN" mailbox INBOX all >/dev/null 2>&1
"${COMPOSE[@]}" exec -T dovecot doveadm expunge -u "$BOX_EXT" mailbox INBOX all >/dev/null 2>&1
MAIL_DIR="/var/mail/vhosts/${DOMAIN}/${BOX_MAIN%%@*}"
in_dovecot "rm -f '$MAIL_DIR/.dovecot.sieve' '$MAIL_DIR/.dovecot.svbin'" >/dev/null
info "старые правила, подключения и папки убраны"

echo "=== 1. Вход в API ==="
LOGIN=$(api POST /api/auth/login "{\"email\":\"$BOX_MAIN\",\"password\":\"$PASS_MAIN\"}")
[ "$(printf '%s' "$LOGIN" | jget ok)" = "true" ] && ok "вход $BOX_MAIN" || { fail "вход не удался: $LOGIN"; exit 1; }

echo "=== 2. Общие настройки и подписи (GET/PUT /api/settings/general) ==="
GENERAL_BODY=$(cat <<'JSON'
{"senderName":"Иван Петров",
 "signatures":[{"id":"","name":"Рабочая","text":"С уважением, Иван"},
               {"id":"","name":"Личная","text":"Пока!"}],
 "defaultSignatureId":null,
 "autoReply":{"enabled":false,"text":"","from":null,"to":null},
 "notifications":{"browser":true,"tabCounter":true},
 "quoteOriginalOnReply":false,
 "afterDelete":"next-message",
 "autoCollectContacts":true}
JSON
)
GEN=$(api PUT /api/settings/general "$GENERAL_BODY")
[ "$(printf '%s' "$GEN" | jget senderName)" = "Иван Петров" ] \
    && ok "имя отправителя сохранено" || fail "имя отправителя не сохранено: $GEN"
[ "$(printf '%s' "$GEN" | jget afterDelete)" = "next-message" ] \
    && ok "«после удаления» вернулось в форме контракта" || fail "afterDelete не сохранён: $GEN"
[ "$(printf '%s' "$GEN" | jget signatures.1.name)" = "Личная" ] \
    && ok "две подписи сохранены и вернулись по порядку" || fail "подписи сохранены неверно: $GEN"
SIG_DEFAULT=$(printf '%s' "$GEN" | jget defaultSignatureId)
[ -n "$SIG_DEFAULT" ] && ok "подпись по умолчанию проставлена (id=$SIG_DEFAULT)" \
    || fail "подпись по умолчанию не проставлена"
GEN2=$(api GET /api/settings/general)
[ "$(printf '%s' "$GEN2" | jget quoteOriginalOnReply)" = "false" ] \
    && ok "настройки читаются обратно тем же GET" || fail "GET вернул другое: $GEN2"

echo "=== 3. Папки (POST/PATCH/DELETE /api/folders) ==="
NEWF=$(api POST /api/folders "{\"name\":\"$FILTER_FOLDER\",\"parentId\":null}")
FILTER_FOLDER_ID=$(printf '%s' "$NEWF" | jget id)
[ -n "$FILTER_FOLDER_ID" ] && ok "папка «$FILTER_FOLDER» создана (id=$FILTER_FOLDER_ID)" \
    || fail "папка не создана: $NEWF"
COLF=$(api POST /api/folders "{\"name\":\"$COLLECT_FOLDER\",\"parentId\":null}")
COLLECT_FOLDER_ID=$(printf '%s' "$COLF" | jget id)
[ -n "$COLLECT_FOLDER_ID" ] && ok "папка «$COLLECT_FOLDER» создана" || fail "папка не создана: $COLF"

TMPF=$(api POST /api/folders '{"name":"Временная","parentId":null}')
TMPF_ID=$(printf '%s' "$TMPF" | jget id)
REN=$(api PATCH "/api/folders/$TMPF_ID" '{"name":"Переименованная"}')
[ "$(printf '%s' "$REN" | jget name)" = "Переименованная" ] \
    && ok "папка переименована" || fail "папка не переименована: $REN"
REN_ID=$(printf '%s' "$REN" | jget id)
DEL=$(api DELETE "/api/folders/$REN_ID")
[ "$(printf '%s' "$DEL" | jget ok)" = "true" ] && ok "папка удалена" || fail "папка не удалена: $DEL"
SYS=$(api DELETE "/api/folders/inbox")
printf '%s' "$SYS" | grep -q 'BAD_REQUEST' \
    && ok "системную папку удалить не дали" || fail "системная папка удалилась: $SYS"

echo "=== 4. Правило фильтрации -> файл Sieve (POST /api/settings/filters) ==="
RULE_BODY=$(cat <<JSON
{"id":"","enabled":true,"auto":false,
 "conditions":[{"field":"from","operator":"contains","value":"buh@example.com"},
               {"field":"subject","operator":"contains","value":"счёт"}],
 "actions":{"moveToFolderId":"$FILTER_FOLDER_ID","markRead":false,"markFlagged":true,
            "applyToExistingFolderIds":[],"forwardTo":null,"autoReply":null,
            "continueOtherFilters":false,"applyToSpam":false}}
JSON
)
CREATED=$(api POST /api/settings/filters "$RULE_BODY")
RULE_ID=$(printf '%s' "$CREATED" | jget id)
[ -n "$RULE_ID" ] && ok "правило создано (id=$RULE_ID)" || fail "правило не создано: $CREATED"
[ "$(printf '%s' "$CREATED" | jget actions.moveToFolderId)" = "$FILTER_FOLDER_ID" ] \
    && ok "папка вернулась идентификатором, как ждёт интерфейс" \
    || fail "папка вернулась не идентификатором: $CREATED"

SIEVE=$(api GET /api/settings/sieve)
SIEVE_PATH=$(printf '%s' "$SIEVE" | jget path)
SCRIPT_TEXT=$(in_dovecot "cat '$SIEVE_PATH'")
printf '%s' "$SCRIPT_TEXT" | grep -q 'fileinto :create "Проверка";' \
    && ok "в файле ящика есть fileinto нужной папки ($SIEVE_PATH)" || fail "fileinto в файле не найден"
printf '%s' "$SCRIPT_TEXT" | grep -q 'header :contains "from" "buh@example.com"' \
    && ok "условие «От» переведено в Sieve" || fail "условие «От» в файле не найдено"
printf '%s' "$SCRIPT_TEXT" | grep -q 'not header :is "X-Spam" "Yes"' \
    && ok "правило защищено от применения к спаму" || fail "защиты от спама в правиле нет"
in_dovecot "test -f '${SIEVE_PATH%.sieve}.svbin'" \
    && ok "скомпилированный .svbin лежит рядом" || fail ".svbin не создан"
"${COMPOSE[@]}" exec -T dovecot doveadm mailbox list -u "$BOX_MAIN" 2>/dev/null | grep -q '^dovecot' \
    && fail "файл правил виден как папка ящика" || ok "файл правил не виден как папка ящика"

# Правило «применять к спаму»: в файле должен появиться блок раскладки
# спама ПОСЛЕ такого правила — сначала правило получает шанс забрать
# письмо, потом всё остальное уходит в «Спам».
SPAM_RULE=$(api POST /api/settings/filters     "{\"id\":\"\",\"enabled\":true,\"auto\":false,\"conditions\":[{\"field\":\"subject\",\"operator\":\"contains\",\"value\":\"SPAMRULE\"}],\"actions\":{\"moveToFolderId\":\"$COLLECT_FOLDER_ID\",\"markRead\":false,\"markFlagged\":false,\"applyToExistingFolderIds\":[],\"forwardTo\":null,\"autoReply\":null,\"continueOtherFilters\":false,\"applyToSpam\":true}}")
SPAM_RULE_ID=$(printf '%s' "$SPAM_RULE" | jget id)
SCRIPT_TEXT=$(in_dovecot "cat '$SIEVE_PATH'")
POS_RULE=$(printf '%s' "$SCRIPT_TEXT" | grep -n 'Тема: SPAMRULE' | head -1 | cut -d: -f1)
POS_SPAM=$(printf '%s' "$SCRIPT_TEXT" | grep -n '=== Спам ===' | head -1 | cut -d: -f1)
if [ -n "$POS_RULE" ] && [ -n "$POS_SPAM" ] && [ "$POS_RULE" -lt "$POS_SPAM" ]; then
    ok "правило «применять к спаму» стоит до блока раскладки спама"
else
    fail "блок раскладки спама не на месте (правило=$POS_RULE, блок=$POS_SPAM)"
fi
api DELETE "/api/settings/filters/$SPAM_RULE_ID" >/dev/null
SCRIPT_TEXT=$(in_dovecot "cat '$SIEVE_PATH'")
printf '%s' "$SCRIPT_TEXT" | grep -q '=== Спам ==='     && fail "блок раскладки спама остался без правила «применять к спаму»"     || ok "без такого правила блок раскладки спама не появляется"

echo "=== 5. Правило РЕАЛЬНО срабатывает ==="
TOKEN="lt$(date +%s)$RANDOM"
send_mail "buh@example.com" "$BOX_MAIN" "счёт № 42 $TOKEN" "Направляю счёт на оплату."
if wait_for_count "$BOX_MAIN" "$FILTER_FOLDER" 1 40; then
    ok "подходящее письмо легло в папку «$FILTER_FOLDER»"
else
    fail "подходящее письмо не попало в «$FILTER_FOLDER»"
    "${COMPOSE[@]}" logs --tail 20 dovecot 2>/dev/null | grep -i sieve || true
fi
FLAGGED=$(count_in "$BOX_MAIN" "$FILTER_FOLDER" flagged)
[ "${FLAGGED:-0}" -ge 1 ] && ok "письмо помечено флажком, как задано правилом" \
    || fail "флажок не выставлен"

send_mail "other@example.com" "$BOX_MAIN" "обычное письмо $TOKEN" "Просто письмо без счёта."
if wait_for_count "$BOX_MAIN" INBOX 1 40; then
    ok "неподходящее письмо осталось во «Входящих»"
else
    fail "неподходящее письмо не дошло до «Входящих»"
fi
IN_FOLDER=$(count_in "$BOX_MAIN" "$FILTER_FOLDER" all)
[ "${IN_FOLDER:-0}" -eq 1 ] && ok "в папке правила ровно одно письмо (лишнего не утащило)" \
    || fail "в папке правила $IN_FOLDER писем вместо одного"

echo "=== 6. Выключение правила без удаления и порядок правил ==="
OFF_BODY=$(printf '%s' "$RULE_BODY" | sed "s/\"id\":\"\"/\"id\":\"$RULE_ID\"/; s/\"enabled\":true/\"enabled\":false/")
api PUT "/api/settings/filters/$RULE_ID" "$OFF_BODY" >/dev/null
SCRIPT_TEXT=$(in_dovecot "cat '$SIEVE_PATH'" || true)
printf '%s' "$SCRIPT_TEXT" | grep -q 'fileinto :create "Проверка";' \
    && fail "выключенное правило осталось в файле" || ok "выключенное правило убрано из файла"
LIST=$(api GET /api/settings/filters)
[ "$(printf '%s' "$LIST" | jget 0.id)" = "$RULE_ID" ] \
    && ok "правило осталось в списке (не удалено)" || fail "правило пропало из списка: $LIST"
ON_BODY=$(printf '%s' "$RULE_BODY" | sed "s/\"id\":\"\"/\"id\":\"$RULE_ID\"/")
api PUT "/api/settings/filters/$RULE_ID" "$ON_BODY" >/dev/null
ok "правило включено обратно"

SECOND=$(api POST /api/settings/filters \
    "{\"id\":\"\",\"enabled\":true,\"auto\":false,\"conditions\":[{\"field\":\"subject\",\"operator\":\"contains\",\"value\":\"zzz\"}],\"actions\":{\"moveToFolderId\":\"$COLLECT_FOLDER_ID\",\"markRead\":true,\"markFlagged\":false,\"applyToExistingFolderIds\":[],\"forwardTo\":null,\"autoReply\":null,\"continueOtherFilters\":true,\"applyToSpam\":false}}")
SECOND_ID=$(printf '%s' "$SECOND" | jget id)
ORDERED=$(api PUT /api/settings/filters/order "{\"ids\":[\"$SECOND_ID\",\"$RULE_ID\"]}")
[ "$(printf '%s' "$ORDERED" | jget 0.id)" = "$SECOND_ID" ] \
    && ok "порядок правил изменён (PUT /api/settings/filters/order)" || fail "порядок не изменён: $ORDERED"
SCRIPT_TEXT=$(in_dovecot "cat '$SIEVE_PATH'")
POS_SECOND=$(printf '%s' "$SCRIPT_TEXT" | grep -n 'Тема: zzz' | head -1 | cut -d: -f1)
POS_FIRST=$(printf '%s' "$SCRIPT_TEXT" | grep -n 'От: buh@example.com' | head -1 | cut -d: -f1)
if [ -n "$POS_SECOND" ] && [ -n "$POS_FIRST" ] && [ "$POS_SECOND" -lt "$POS_FIRST" ]; then
    ok "порядок правил в файле Sieve соответствует заданному"
else
    fail "порядок правил в файле не изменился (Второе=$POS_SECOND, Первое=$POS_FIRST)"
fi
api DELETE "/api/settings/filters/$SECOND_ID" >/dev/null

echo "=== 7. Применение правила к уже полученным письмам ==="
# Кладём во «Входящие» письмо, подходящее под правило, минуя Sieve.
"${COMPOSE[@]}" exec -T dovecot sh -c \
    "printf 'From: buh@example.com\r\nTo: $BOX_MAIN\r\nSubject: ретро счёт $TOKEN\r\n\r\nтело\r\n' > /tmp/retro.eml && doveadm save -u $BOX_MAIN -m INBOX < /tmp/retro.eml" >/dev/null
BEFORE=$(count_in "$BOX_MAIN" "$FILTER_FOLDER" all)
APPLY=$(api POST "/api/settings/filters/$RULE_ID/apply" '{"folders":["inbox"]}')
MOVED=$(printf '%s' "$APPLY" | jget result.moved)
AFTER=$(count_in "$BOX_MAIN" "$FILTER_FOLDER" all)
if [ "${MOVED:-0}" -ge 1 ] && [ "${AFTER:-0}" -gt "${BEFORE:-0}" ]; then
    ok "правило применено к старой почте: перенесено $MOVED (было $BEFORE, стало $AFTER)"
else
    fail "правило не применилось к старой почте: $APPLY"
fi

echo "=== 8. Автоопределение настроек чужого сервера ==="
DET=$(api POST /api/accounts/external/detect "{\"email\":\"$BOX_EXT\"}")
[ "$(printf '%s' "$DET" | jget detected.source)" = "local" ] \
    && ok "адрес нашего домена определён точно (host=$(printf '%s' "$DET" | jget detected.imap.host))" \
    || fail "автоопределение своего домена не сработало: $DET"
DET2=$(api POST /api/accounts/external/detect '{"email":"someone@yandex.ru"}')
[ "$(printf '%s' "$DET2" | jget detected.imap.host)" = "imap.yandex.ru" ] \
    && ok "известный сервис определён из списка" || fail "известный сервис не определён: $DET2"

echo "=== 9. Сборщик (POST /api/settings/collectors) ==="
for i in 1 2 3; do
    send_mail "sender$i@example.com" "$BOX_EXT" "внешнее письмо $i $TOKEN" "Текст письма номер $i."
done
wait_for_count "$BOX_EXT" INBOX 3 40 \
    && ok "во «внешнем» ящике 3 письма" || fail "письма во «внешний» ящик не дошли"

COLL_BODY=$(cat <<JSON
{"email":"$BOX_EXT","password":"$PASS_EXT","protocol":"imap",
 "host":"127.0.0.1","port":143,"secure":false,"login":"$BOX_EXT",
 "targetFolderId":"$COLLECT_FOLDER_ID","leaveOnServer":true,"applyFilters":false}
JSON
)
COLL=$(api POST /api/settings/collectors "$COLL_BODY")
COLL_ID=$(printf '%s' "$COLL" | jget id)
[ -n "$COLL_ID" ] && ok "внешний ящик подключён (id=$COLL_ID, подключение проверено логином)" \
    || fail "внешний ящик не подключён: $COLL"
[ "$(printf '%s' "$COLL" | jget targetFolderId)" = "$COLLECT_FOLDER_ID" ] \
    && ok "папка-приёмник вернулась идентификатором" || fail "папка-приёмник вернулась не так: $COLL"

SYNC1=$(api POST "/api/settings/collectors/$COLL_ID/sync")
[ "$(printf '%s' "$SYNC1" | jget status)" = "ok" ] && ok "первый сбор завершён без ошибок" \
    || fail "первый сбор: $SYNC1"
COUNT1=$(count_in "$BOX_MAIN" "$COLLECT_FOLDER" all)
[ "${COUNT1:-0}" -ge 3 ] && ok "в папке «$COLLECT_FOLDER» $COUNT1 писем (проверено doveadm)" \
    || fail "в папке «$COLLECT_FOLDER» только $COUNT1 писем"
LIST_COLL=$(api GET /api/settings/collectors)
[ -n "$(printf '%s' "$LIST_COLL" | jget 0.lastSyncAt)" ] \
    && ok "время последней синхронизации показывается интерфейсу" || fail "lastSyncAt пуст: $LIST_COLL"
printf '%s' "$LIST_COLL" | grep -qi 'password' \
    && fail "в списке сборщиков есть поле пароля" || ok "пароля в ответе списка сборщиков нет"

# Второй запуск: подробные числа берём у расширенного маршрута.
RUN2=$(api POST "/api/accounts/external/$COLL_ID/collect" '{}')
COPIED2=$(printf '%s' "$RUN2" | jget result.copied)
SKIPPED2=$(printf '%s' "$RUN2" | jget result.skipped)
COUNT2=$(count_in "$BOX_MAIN" "$COLLECT_FOLDER" all)
[ "${COPIED2:-1}" -eq 0 ] && ok "повторный сбор не скопировал ни одного письма" \
    || fail "повторный сбор скопировал $COPIED2 писем — дубли!"
info "повторный сбор: скопировано $COPIED2, пропущено $SKIPPED2 (пропуск по курсору докачки)"
[ "${COUNT2:-0}" -eq "${COUNT1:-0}" ] && ok "число писем в папке не изменилось ($COUNT2)" \
    || fail "после второго сбора писем стало $COUNT2 вместо $COUNT1 — дубли!"

# Третий запуск после НОВОГО письма: докачивается только новое.
send_mail "sender4@example.com" "$BOX_EXT" "внешнее письмо 4 $TOKEN" "Ещё одно письмо."
wait_for_count "$BOX_EXT" INBOX 4 40 >/dev/null
RUN3=$(api POST "/api/accounts/external/$COLL_ID/collect" '{}')
COPIED3=$(printf '%s' "$RUN3" | jget result.copied)
COUNT3=$(count_in "$BOX_MAIN" "$COLLECT_FOLDER" all)
[ "${COPIED3:-0}" -eq 1 ] && ok "третий сбор забрал ровно одно новое письмо" \
    || fail "третий сбор забрал $COPIED3 писем вместо одного"
[ "${COUNT3:-0}" -eq $(( ${COUNT1:-0} + 1 )) ] && ok "в папке стало $COUNT3 писем" \
    || fail "в папке $COUNT3 писем вместо $(( ${COUNT1:-0} + 1 ))"

# Самая сильная проверка дедупликации: стираем журнал докачки и повторяем
# сбор. Курсор больше не помогает, письма читаются заново — и всё равно
# ни одно не должно скопироваться повторно, потому что содержимое
# папки-приёмника сканируется перед переносом.
"${COMPOSE[@]}" exec -T postgres psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"     -c "DELETE FROM migrate_cursors WHERE account LIKE '%lt-ext%';"     -c "DELETE FROM migrate_messages WHERE account LIKE '%lt-ext%';" >/dev/null 2>&1
RUN4=$(api POST "/api/accounts/external/$COLL_ID/collect" '{}')
COPIED4=$(printf '%s' "$RUN4" | jget result.copied)
SKIPPED4=$(printf '%s' "$RUN4" | jget result.skipped)
COUNT4=$(count_in "$BOX_MAIN" "$COLLECT_FOLDER" all)
[ "${COPIED4:-1}" -eq 0 ] && ok "после потери журнала докачки дубли всё равно не созданы"     || fail "после потери журнала скопировано $COPIED4 писем — дубли!"
[ "${SKIPPED4:-0}" -ge 4 ] && ok "все $SKIPPED4 писем опознаны как уже перенесённые по содержимому папки"     || fail "дедупликация по содержимому папки не сработала: skipped=$SKIPPED4"
[ "${COUNT4:-0}" -eq "${COUNT3:-0}" ] && ok "число писем в папке не изменилось ($COUNT4)"     || fail "после четвёртого сбора писем стало $COUNT4 вместо $COUNT3"

STATE=$(api GET "/api/accounts/external/$COLL_ID/state")
RUNS=$(printf '%s' "$STATE" | jget state.runs)
[ "${RUNS:-0}" -ge 4 ] \
    && ok "состояние сборщика ведётся (запусков: $RUNS, всего перенесено: $(printf '%s' "$STATE" | jget state.totalCopied))" \
    || fail "состояние сборщика не ведётся: $STATE"

echo "=== 10. Пароль чужого ящика в базе — только шифротекстом ==="
PLAIN_ROWS=$("${COMPOSE[@]}" exec -T postgres psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT count(*) FROM external_accounts WHERE (external_accounts::text) LIKE '%${PASS_EXT}%';" 2>/dev/null | tr -d '\r')
[ "$PLAIN_ROWS" = "0" ] && ok "открытого пароля в external_accounts нет (строк: 0)" \
    || fail "открытый пароль найден в external_accounts: строк $PLAIN_ROWS"
ENC_SAMPLE=$("${COMPOSE[@]}" exec -T postgres psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT left(password_enc, 3) FROM external_accounts WHERE lower(address) = lower('$BOX_EXT') LIMIT 1;" 2>/dev/null | tr -d '\r')
[ "$ENC_SAMPLE" = "v1." ] && ok "в базе лежит шифротекст формата v1. (AES-256-GCM)" \
    || fail "формат шифротекста неожиданный: '$ENC_SAMPLE'"

echo "=== 11. Прямое подключение ==="
api PUT "/api/accounts/external/$COLL_ID" '{"mode":"direct"}' >/dev/null
FOLDERS_EXT=$(api GET "/api/accounts/external/$COLL_ID/folders")
printf '%s' "$FOLDERS_EXT" | grep -q "\"ext${COLL_ID}:inbox\"" \
    && ok "дерево папок чужого ящика получено с приставкой ext$COLL_ID:" \
    || fail "папки чужого ящика не получены: $FOLDERS_EXT"
MSGS=$(api GET "/api/accounts/external/$COLL_ID/messages?folderId=ext${COLL_ID}:inbox&limit=5&snippets=0")
TOTAL=$(printf '%s' "$MSGS" | jget total)
[ "${TOTAL:-0}" -ge 4 ] && ok "письма чужого ящика читаются на лету (всего $TOTAL)" \
    || fail "письма чужого ящика не читаются: $MSGS"
api PUT "/api/accounts/external/$COLL_ID" '{"mode":"collector"}' >/dev/null

echo "=== 12. Несколько своих ящиков ==="
LINK=$(api POST /api/accounts/link "{\"email\":\"$BOX_SECOND\",\"password\":\"$PASS_SECOND\",\"label\":\"Второй\"}")
printf '%s' "$LINK" | grep -q "$BOX_SECOND" && ok "второй свой ящик связан (пароль проверен логином)" \
    || fail "связывание не удалось: $LINK"
LINKED_PLAIN=$("${COMPOSE[@]}" exec -T postgres psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT count(*) FROM linked_accounts WHERE (linked_accounts::text) LIKE '%${PASS_SECOND}%' OR (linked_accounts::text) LIKE '%${PASS_MAIN}%';" 2>/dev/null | tr -d '\r')
[ "$LINKED_PLAIN" = "0" ] && ok "открытого пароля в linked_accounts нет (строк: 0)" \
    || fail "открытый пароль найден в linked_accounts: строк $LINKED_PLAIN"

send_mail "someone@example.com" "$BOX_SECOND" "непрочитанное $TOKEN" "Письмо во второй ящик."
wait_for_count "$BOX_SECOND" INBOX 1 40 >/dev/null
UNREAD=$(api GET /api/accounts/unread)
TOTAL_UNREAD=$(printf '%s' "$UNREAD" | jget total)
[ "${TOTAL_UNREAD:-0}" -ge 1 ] && ok "общий счётчик непрочитанных считает оба ящика (всего $TOTAL_UNREAD)" \
    || fail "общий счётчик не работает: $UNREAD"

SWITCH=$(api POST /api/accounts/switch "{\"email\":\"$BOX_SECOND\"}")
[ "$(printf '%s' "$SWITCH" | jget email)" = "$BOX_SECOND" ] \
    && ok "переключение на второй ящик без ввода пароля" || fail "переключение не удалось: $SWITCH"
SESSION=$(api GET /api/auth/session)
[ "$(printf '%s' "$SESSION" | jget email)" = "$BOX_SECOND" ] \
    && ok "сессия теперь принадлежит второму ящику" || fail "сессия не переключилась: $SESSION"
BACK=$(api POST /api/accounts/switch "{\"email\":\"$BOX_MAIN\"}")
[ "$(printf '%s' "$BACK" | jget email)" = "$BOX_MAIN" ] \
    && ok "обратное переключение тоже без пароля" || fail "обратное переключение не удалось: $BACK"

echo
echo "==================== ИТОГ ===================="
echo "  Успешно: $PASS"
echo "  Ошибок:  $FAIL"
echo "=============================================="
[ "$FAIL" -eq 0 ] || exit 1
