#!/usr/bin/env bash
# ------------------------------------------------------------------
# Личный файл правил обязан СОБИРАТЬСЯ. Иначе молча ломается всё сразу.
#   bash infra/test-sieve-compiles.sh
#
# Что закрепляется. Глобальная раскладка спама подключена как
# `sieve_default` — Dovecot применяет её ТОЛЬКО к ящикам без личного
# скрипта. У ящика с личным скриптом за спам отвечает сам личный скрипт:
# генератор дописывает в его конец блок `fileinto :create "Spam"`.
#
# Расширения в строке require при этом собирались по правилам ящика. Ящик,
# у которого включён ОДИН автоответчик и нет ни одного правила, получал:
#
#     require ["vacation", "date", "relational"];
#     ...
#     if header :is "X-Spam" "Yes" { fileinto :create "Spam"; stop; }
#
# Pigeonhole отвечает «unknown command 'fileinto'» и отказывается от
# скрипта ЦЕЛИКОМ. Дальше молчит всё: спам с оценкой 9.40 при пороге 6
# ложится во «Входящие», автоответчик не отвечает, правила не работают.
# Единственный след — .dovecot.sieve.log внутри ящика, куда не смотрит
# никто. Проверено на живом стенде: ящик test@mail.local.
#
# Проверка идёт ЧЕРЕЗ НАСТОЯЩИЙ API: скрипт пишет генератор продукта,
# а не эта проверка своими руками (см. пояснение в test-spam-rule.sh).
# ------------------------------------------------------------------
set -u

HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/docker-compose.yml"
API="${API_URL:-http://127.0.0.1:8080}"

USER_MAIL="sievecheck@mail.local"
USER_PASS="sievecheck12345"
MARK="SIEVECHK-$(date +%s)"
JAR="$(mktemp)"

OK=0; FAIL=0
ok()   { printf '  [OK] %s\n' "$1"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '       . %s\n' "$1"; }
dov()  { MSYS_NO_PATHCONV=1 $COMPOSE exec -T dovecot sh -c "$1" 2>&1; }

GTUBE='XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X'

cleanup() {
    rm -f "$JAR"
    MSYS_NO_PATHCONV=1 $COMPOSE exec -T dovecot sh -c \
        "rm -rf /var/mail/vhosts/mail.local/sievecheck" >/dev/null 2>&1
    MSYS_NO_PATHCONV=1 $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" \
        -d "${POSTGRES_DB:-mailserver}" -qtA \
        -c "DELETE FROM virtual_users WHERE email='$USER_MAIL';" >/dev/null 2>&1
}
trap cleanup EXIT

echo "=== 1. Ящик ==="
bash "$HERE/scripts/create-mailbox.sh" "$USER_MAIL" "$USER_PASS" >/dev/null 2>&1
dov "doveadm mailbox status -u '$USER_MAIL' messages INBOX" | grep -q INBOX \
    && ok "ящик готов" || { fail "ящик не создан"; exit 1; }

echo "=== 2. Вход и включение автоответчика (правил НЕ создаём) ==="
curl -s -c "$JAR" -H 'Content-Type: application/json' \
     -d "{\"email\":\"$USER_MAIL\",\"password\":\"$USER_PASS\"}" \
     "$API/api/auth/login" | grep -q '"ok":true' \
    && ok "вход в ящик выполнен" || { fail "не удалось войти в ящик"; exit 1; }

# Ровно один автоответчик и ни одного правила — тот самый случай.
# Тело кладём в файл: в нём кириллица, и при передаче аргументом длина
# в байтах разошлась бы с длиной строки, а сервер такое тело отвергает.
BODY="$(mktemp)"
cat > "$BODY" <<'JSON'
{"senderName":"Проверка","signatures":[],"defaultSignatureId":null,
 "autoReply":{"enabled":true,"text":"В отпуске до конца месяца","from":null,"to":null},
 "notifications":{"browser":false,"tabCounter":true},
 "quoteOriginalOnReply":true,"afterDelete":"list","autoCollectContacts":true}
JSON
SAVED="$(curl -s -b "$JAR" -c "$JAR" -X PUT -H 'Content-Type: application/json' \
    --data-binary "@$BODY" "$API/api/settings/general")"
rm -f "$BODY"
printf '%s' "$SAVED" | grep -q '"enabled":true' \
    && ok "автоответчик сохранён" || { fail "настройки не сохранились: $(printf '%s' "$SAVED" | head -c 200)"; }

SYNC="$(curl -s -b "$JAR" "$API/api/settings/sieve" )"
printf '%s' "$SYNC" | grep -q 'fileinto' \
    && ok "личный файл правил записан в ящик" \
    || note "прочитать личный файл через API не вышло: $(printf '%s' "$SYNC" | head -c 160)"

echo "=== 3. ГЛАВНОЕ: скрипт должен СОБИРАТЬСЯ ==="
SCRIPT_PATH=/var/mail/vhosts/mail.local/sievecheck/.dovecot.sieve
if dov "test -f $SCRIPT_PATH" >/dev/null 2>&1; then
    ok "действующий скрипт на месте"
else
    fail "личного скрипта нет — проверять нечего"
    exit 1
fi
# Компилятор Pigeonhole — та же программа, которой пользуется Dovecot
# при доставке. Её приговор и есть ответ «соберётся или нет».
COMPILE="$(dov "cp $SCRIPT_PATH /tmp/mt-check.sieve && sievec /tmp/mt-check.sieve && echo COMPILED; rm -f /tmp/mt-check.sieve /tmp/mt-check.svbin")"
if printf '%s' "$COMPILE" | grep -q COMPILED; then
    ok "скрипт собирается компилятором Pigeonhole"
else
    fail "скрипт НЕ собирается: $(printf '%s' "$COMPILE" | head -c 300)"
fi
# Причина прошлой поломки была именно в строке require.
REQUIRE="$(dov "grep '^require' $SCRIPT_PATH")"
printf '%s' "$REQUIRE" | grep -q '"fileinto"' \
    && ok "require объявляет fileinto (его требует блок раскладки спама)" \
    || fail "в require нет fileinto, хотя блок раскладки спама его использует: $REQUIRE"
printf '%s' "$REQUIRE" | grep -q '"mailbox"' \
    && ok "require объявляет mailbox (его требует :create)" \
    || fail "в require нет mailbox, хотя используется fileinto :create: $REQUIRE"

echo "=== 4. Спам обязан лечь в «Спам», а не во «Входящие» ==="
MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix swaks --server postfix:25 \
    --helo client.example.com --from spamtest@example.com --to "$USER_MAIL" \
    --header "Subject: $MARK" --header 'Content-Type: text/plain; charset=UTF-8' \
    --body "$GTUBE" >/dev/null 2>&1
sleep 6
# Считаем ТОЛЬКО строки вида «<guid> <uid>»: doveadm пишет в тот же поток
# сообщения об инициализации индекса поиска, и они завышали счётчик.
count_in() { # count_in <папка>
    dov "doveadm search -u '$USER_MAIL' mailbox '$1' header subject '$MARK' 2>/dev/null" \
        | grep -cE '^[0-9a-f]+ [0-9]+$'
}
IN_SPAM="$(count_in Spam)"
IN_INBOX="$(count_in INBOX)"
if [ "$IN_SPAM" -ge 1 ] && [ "$IN_INBOX" -eq 0 ]; then
    ok "помеченное письмо разложено в «Спам»"
else
    fail "письмо во «Входящих» ($IN_INBOX) вместо «Спама» ($IN_SPAM) — раскладка не работает"
    dov "tail -5 /var/mail/vhosts/mail.local/sievecheck/.dovecot.sieve.log" | sed 's/^/       /'
fi

echo "=== 5. Журнал Sieve ящика должен быть чист ==="
# Единственное место, где раньше была видна поломка. Пусто — значит
# скрипт отработал, а не был отброшен целиком.
LOG="$(dov "cat /var/mail/vhosts/mail.local/sievecheck/.dovecot.sieve.log 2>/dev/null")"
if printf '%s' "$LOG" | grep -qiE 'error|validation failed'; then
    fail "в журнале Sieve ящика есть ошибки:"
    printf '%s' "$LOG" | grep -iE 'error|validation failed' | head -3 | sed 's/^/       /'
else
    ok "ошибок в журнале Sieve ящика нет"
fi

echo
echo "=== ИТОГ: OK=$OK, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
