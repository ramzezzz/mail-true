#!/usr/bin/env bash
# Проверка: правило «переслать копию» и автоответчик не должны ломать доставку.
#
# Было очень плохо. Оба действия Pigeonhole выполняет через программу отправки
# почты, а её в образе Dovecot нет. Для «переслать» это фатально: скрипт
# прерывается целиком, LMTP отвечает временным отказом, и письмо НЕ попадает
# в ящик вовсе — висит в очереди до истечения срока, потом уходит отбойником
# отправителю. То есть одно правило пересылки останавливало доставку ВСЕЙ
# почты в ящик. Автоответчик при этом молча никогда не отвечал.
#
# Лечится настройкой submission_host в dovecot.conf.template.
set -u

# Относительный путь, а не абсолютный: на Windows абсолютный путь из
# оболочки MSYS искажается при передаче в docker.
HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/docker-compose.yml"
USER_MAIL="fwdtest@mail.local"
USER_PASS="fwdtest12345"
FWD_TO="fwdrecv@mail.local"
FWD_PASS="fwdrecv12345"
MARK="FWD-$(date +%s)"

OK=0; FAIL=0
ok()   { printf '  [OK] %s\n' "$1"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
dov()  { MSYS_NO_PATHCONV=1 $COMPOSE exec -T dovecot sh -c "$1" 2>&1; }

echo "=== 1. Два ящика: у кого правило и кому пересылать ==="
bash "$HERE/scripts/create-mailbox.sh" "$USER_MAIL" "$USER_PASS" >/dev/null 2>&1
bash "$HERE/scripts/create-mailbox.sh" "$FWD_TO"   "$FWD_PASS"  >/dev/null 2>&1
dov "doveadm mailbox status -u '$USER_MAIL' messages INBOX" | grep -q INBOX \
    && ok "ящики готовы" || fail "ящики не созданы"

echo "=== 2. Личное правило с пересылкой ==="
# Ровно то, что генерирует apps/api/src/settings/sieve.ts для действия «переслать копию»
dov "mkdir -p /var/mail/vhosts/mail.local/fwdtest && cat > /var/mail/vhosts/mail.local/fwdtest/.dovecot.sieve <<'EOF'
require [\"copy\", \"fileinto\", \"mailbox\"];

if header :contains \"subject\" \"$MARK\" {
	redirect :copy \"$FWD_TO\";
}

# === Спам ===
if header :is \"X-Spam\" \"Yes\" {
	fileinto :create \"Spam\";
	stop;
}
EOF
chown vmail:vmail /var/mail/vhosts/mail.local/fwdtest/.dovecot.sieve && sievec /var/mail/vhosts/mail.local/fwdtest/.dovecot.sieve" >/dev/null 2>&1
dov "test -f /var/mail/vhosts/mail.local/fwdtest/.dovecot.svbin && echo да" | grep -q "да" \
    && ok "правило скомпилировано" || fail "правило не скомпилировалось"

echo "=== 3. Письмо подходящее под правило ==="
MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix swaks --server postfix:25 --helo client.example.com \
    --from outside@example.com --to "$USER_MAIL" \
    --header "Subject: $MARK" \
    --header 'Content-Type: text/plain; charset=UTF-8' \
    --body "Проверка пересылки" >/dev/null 2>&1 \
    && ok "письмо принято на порт 25" || fail "письмо не принято"

sleep 6

echo "=== 4. Главное: письмо ДОЛЖНО лежать в ящике владельца ==="
IN_OWN=$(dov "doveadm search -u '$USER_MAIL' mailbox INBOX all" | grep -c . || true)
if [ "$IN_OWN" -ge 1 ]; then
    ok "письмо доставлено владельцу ($IN_OWN шт.) — правило не сломало доставку"
else
    fail "письма в ящике владельца НЕТ — доставка сломана правилом"
fi

echo "=== 5. Очередь не должна копить отложенное ==="
DEFERRED=$(MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix sh -c "postqueue -p 2>/dev/null | grep -c '^[A-F0-9]' || true" | tr -d '\r')
if [ "${DEFERRED:-0}" -le 1 ]; then
    ok "очередь чистая (отложенных: ${DEFERRED:-0})"
else
    fail "в очереди зависло писем: $DEFERRED"
    MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix sh -c "postqueue -p | head -6"
fi

echo "=== 6. Копия должна дойти до адресата пересылки ==="
sleep 4
IN_FWD=$(dov "doveadm search -u '$FWD_TO' mailbox INBOX all" | grep -c . || true)
if [ "$IN_FWD" -ge 1 ]; then
    ok "копия доставлена адресату пересылки"
else
    fail "копия до адресата пересылки не дошла"
    dov "cat /var/mail/vhosts/mail.local/fwdtest/.dovecot.sieve.log 2>/dev/null | tail -5"
fi

echo "=== 7. Уборка ==="
for m in "$USER_MAIL" "$FWD_TO"; do
    MSYS_NO_PATHCONV=1 $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" \
        -d "${POSTGRES_DB:-mailserver}" -c "DELETE FROM virtual_users WHERE email='$m';" >/dev/null 2>&1
done
dov "rm -rf /var/mail/vhosts/mail.local/fwdtest /var/mail/vhosts/mail.local/fwdrecv" >/dev/null 2>&1
echo "  временные ящики удалены"

echo
echo "=== ИТОГ: OK=$OK, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
