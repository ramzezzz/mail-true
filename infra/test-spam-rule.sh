#!/usr/bin/env bash
# Проверка раскладки спама при наличии личных правил фильтрации.
#
# Правила создаются ЧЕРЕЗ НАСТОЯЩИЙ API, а не пишутся руками в файл.
# Прежняя версия этой проверки писала скрипт Sieve сама — «как его формирует
# генератор» — и тем самым проверяла предположение о генераторе, а не сам
# генератор. Из-за этого она осталась зелёной, когда генератор перестал
# дописывать блок раскладки спама: любое обычное правило молча отключало
# антиспам целиком, и поймал это только отдельный проход недоверия.
#
# Вывод общий: проверка, воспроизводящая поведение продукта своими руками,
# проверяет саму себя.
set -u

HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/docker-compose.yml"
API="${API_URL:-http://127.0.0.1:8080}"

USER_MAIL="spamrule@mail.local"
USER_PASS="spamrule12345"
TRAP_FOLDER="ЛовушкаСпама"
MARK="SPAMRULE-$(date +%s)"
JAR="$(mktemp)"

OK=0; FAIL=0
ok()   { printf '  [OK] %s\n' "$1"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
dov()  { MSYS_NO_PATHCONV=1 $COMPOSE exec -T dovecot sh -c "$1" 2>&1; }

GTUBE='XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X'

send_gtube() { # send_gtube <тема>
    MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix swaks --server postfix:25 \
        --helo client.example.com --from spamtest@example.com --to "$USER_MAIL" \
        --header "Subject: $1" --header 'Content-Type: text/plain; charset=UTF-8' \
        --body "$GTUBE" >/dev/null 2>&1
}

count_in() { dov "doveadm search -u '$USER_MAIL' mailbox '$1' all" | grep -c . || true; }

echo "=== 1. Ящик ==="
bash "$HERE/scripts/create-mailbox.sh" "$USER_MAIL" "$USER_PASS" >/dev/null 2>&1
dov "doveadm mailbox status -u '$USER_MAIL' messages INBOX" | grep -q INBOX \
    && ok "ящик готов" || fail "ящик не создан"

echo "=== 2. Пока правил нет: спам должен уходить в «Спам» ==="
send_gtube "$MARK-A" && sleep 5
if [ "$(count_in Spam)" -ge 1 ] && [ "$(count_in INBOX)" -eq 0 ]; then
    ok "без правил спам разложен верно"
else
    fail "без правил спам не разложен (Спам: $(count_in Spam), Входящие: $(count_in INBOX))"
fi

echo "=== 3. Заводим ОБЫЧНОЕ правило через API (про другое письмо) ==="
curl -s -c "$JAR" -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$USER_MAIL\",\"password\":\"$USER_PASS\"}" -o /dev/null
RULE=$(curl -s -b "$JAR" -X POST "$API/api/settings/filters" -H 'Content-Type: application/json' \
    -d '{"id":"","enabled":true,"auto":false,
         "conditions":[{"field":"subject","operator":"contains","value":"NOTHING-TO-DO-WITH-SPAM"}],
         "actions":{"moveToFolderId":"trash","markRead":false,"markFlagged":false,
                    "applyToExistingFolderIds":[],"forwardTo":null,"autoReply":null,
                    "continueOtherFilters":false,"applyToSpam":false}}')
echo "$RULE" | grep -q '"id"' && ok "обычное правило создано" || fail "правило не создано: $RULE"

echo "=== 4. ГЛАВНОЕ: обычное правило не должно отключать антиспам ==="
# Именно здесь пряталась беда: личный скрипт заменяет запасной глобальный,
# и без блока раскладки спам оставался во «Входящих» — без единого признака.
dov "rm -f /var/mail/vhosts/mail.local/spamrule/Maildir/cur/* 2>/dev/null" >/dev/null 2>&1
BEFORE_SPAM=$(count_in Spam)
BEFORE_INBOX=$(count_in INBOX)
send_gtube "$MARK-B" && sleep 6
AFTER_SPAM=$(count_in Spam)
AFTER_INBOX=$(count_in INBOX)
if [ "$AFTER_SPAM" -gt "$BEFORE_SPAM" ] && [ "$AFTER_INBOX" -eq "$BEFORE_INBOX" ]; then
    ok "с обычным правилом спам по-прежнему уходит в «Спам»"
else
    fail "антиспам отключился обычным правилом (Спам $BEFORE_SPAM→$AFTER_SPAM, Входящие $BEFORE_INBOX→$AFTER_INBOX)"
    dov "cat /var/mail/vhosts/mail.local/spamrule/.dovecot.sieve" | head -20
fi

echo "=== 5. Правило «применять к спаму» должно перехватывать спам раньше ==="
dov "doveadm mailbox create -u '$USER_MAIL' '$TRAP_FOLDER'" >/dev/null 2>&1
TRAP_RULE=$(curl -s -b "$JAR" -X POST "$API/api/settings/filters" -H 'Content-Type: application/json' \
    -d "{\"id\":\"\",\"enabled\":true,\"auto\":false,
         \"conditions\":[{\"field\":\"subject\",\"operator\":\"contains\",\"value\":\"$MARK-C\"}],
         \"actions\":{\"moveToFolderId\":\"f-$(printf '%s' "$TRAP_FOLDER" | base64 | tr -d '=' | tr '+/' '-_')\",
                     \"markRead\":false,\"markFlagged\":false,\"applyToExistingFolderIds\":[],
                     \"forwardTo\":null,\"autoReply\":null,\"continueOtherFilters\":false,
                     \"applyToSpam\":true}}")
if echo "$TRAP_RULE" | grep -q '"id"'; then
    send_gtube "$MARK-C" && sleep 6
    if [ "$(count_in "$TRAP_FOLDER")" -ge 1 ]; then
        ok "правило «применять к спаму» сработало раньше общей раскладки"
    else
        fail "правило «применять к спаму» не сработало"
    fi
else
    fail "правило со спамом не создано: $TRAP_RULE"
fi

echo "=== 6. Уборка ==="
rm -f "$JAR"
dov "doveadm mailbox delete -u '$USER_MAIL' -r '$TRAP_FOLDER'" >/dev/null 2>&1
MSYS_NO_PATHCONV=1 $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" \
    -d "${POSTGRES_DB:-mailserver}" -c "DELETE FROM virtual_users WHERE email='$USER_MAIL';" >/dev/null 2>&1
dov "rm -rf /var/mail/vhosts/mail.local/spamrule" >/dev/null 2>&1
echo "  временный ящик удалён"

echo
echo "=== ИТОГ: OK=$OK, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
