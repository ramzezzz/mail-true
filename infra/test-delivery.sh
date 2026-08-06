#!/usr/bin/env bash
# Сквозной тест почтового стека Mail.True. Повторяемый; запускать из любого места:
#   bash infra/test-delivery.sh
# Проверяет:
#   1. Здоровье всех сервисов
#   2. Создание тестового ящика (test@mail.local)
#   3. Приём на порт 25 -> LMTP-доставка в Maildir
#   4. Чтение письма по IMAP (тема и тело)
#   5. Отправку через submission:587 (STARTTLS + SASL), DKIM-подпись
#   6. Отказ в аутентификации с неверным паролем
set -uo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")
set -a; . <(tr -d '\r' < "$INFRA_DIR/.env"); set +a

TEST_USER="test@${MAIL_DOMAIN}"
TEST_PASS="${TEST_MAILBOX_PASSWORD:-test12345}"

PASS=0; FAIL=0
ok()   { echo "  [OK] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "=== 1. Статус сервисов ==="
"${COMPOSE[@]}" ps
for svc in postgres redis dovecot rspamd postfix; do
    state=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}} {{.State}}' "$svc" | awk '{print $2" "$3}')
    case "$state" in
        *unhealthy*|*exited*|*dead*) fail "$svc: $state" ;;
        *running*)                   ok   "$svc: $state" ;;
        *)                           fail "$svc: $state" ;;
    esac
done

echo "=== 2. Тестовый ящик $TEST_USER ==="
if bash "$INFRA_DIR/scripts/create-mailbox.sh" "$TEST_USER" "$TEST_PASS" >/dev/null; then
    ok "ящик создан/обновлён"
else
    fail "не удалось создать ящик"
fi

TOKEN="t$(date +%s)$RANDOM"
BODY_TOKEN="body-$TOKEN"

echo "=== 3. Приём по SMTP:25 (внешний отправитель) ==="
# Подключаемся к postfix:25 по IP docker-сети (не 127.0.0.1) — как внешний хост
if "${COMPOSE[@]}" exec -T postfix swaks \
        --server postfix:25 --helo client.example.com \
        --from sender@example.com --to "$TEST_USER" \
        --header "Subject: inbound $TOKEN" --body "$BODY_TOKEN inbound" >/tmp/swaks-in.log 2>&1; then
    ok "swaks: письмо принято на порт 25"
else
    fail "swaks: порт 25 отверг письмо"
    "${COMPOSE[@]}" exec -T postfix cat /tmp/swaks-in.log 2>/dev/null || cat /tmp/swaks-in.log || true
fi

echo "--- ждём LMTP-доставку в Maildir ---"
FOUND=""
for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T dovecot doveadm search -u "$TEST_USER" \
            mailbox INBOX HEADER Subject "$TOKEN" 2>/dev/null | grep -q .; then
        FOUND=1; break
    fi
    sleep 1
done
if [ -n "$FOUND" ]; then
    ok "письмо появилось в Maildir (doveadm search, ~${i}s)"
else
    fail "письмо не дошло за 30 секунд"
fi

echo "=== 4. Чтение по IMAP:143 ==="
# Ищем письмо и читаем его настоящим IMAP-протоколом (curl из контейнера postfix)
SEQ=$("${COMPOSE[@]}" exec -T postfix curl -s --url "imap://dovecot:143/INBOX" \
        --user "$TEST_USER:$TEST_PASS" -X "SEARCH SUBJECT \"$TOKEN\"" | tr -d '\r' | sed 's/^\* SEARCH //' | awk '{print $NF}')
if [ -n "$SEQ" ]; then
    MSG=$("${COMPOSE[@]}" exec -T postfix curl -s --url "imap://dovecot:143/INBOX;MAILINDEX=$SEQ" \
            --user "$TEST_USER:$TEST_PASS")
    echo "$MSG" | grep -q "Subject: inbound $TOKEN" && ok "IMAP: тема совпадает (Subject: inbound $TOKEN)" || fail "IMAP: тема не найдена"
    echo "$MSG" | grep -q "$BODY_TOKEN inbound"      && ok "IMAP: тело совпадает ($BODY_TOKEN inbound)" || fail "IMAP: тело не найдено"
else
    fail "IMAP: SEARCH не нашёл письмо"
fi

echo "=== 5. Submission:587 (STARTTLS + SASL) ==="
if "${COMPOSE[@]}" exec -T postfix swaks \
        --server postfix:587 --tls \
        --auth PLAIN --auth-user "$TEST_USER" --auth-password "$TEST_PASS" \
        --from "$TEST_USER" --to "$TEST_USER" \
        --header "Subject: outbound $TOKEN" --body "$BODY_TOKEN outbound" >/tmp/swaks-out.log 2>&1; then
    ok "swaks: аутентификация и отправка через 587"
else
    fail "swaks: submission не сработал"
    "${COMPOSE[@]}" exec -T postfix cat /tmp/swaks-out.log 2>/dev/null || cat /tmp/swaks-out.log || true
fi

FOUND2=""
for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T dovecot doveadm search -u "$TEST_USER" \
            mailbox INBOX HEADER Subject "outbound $TOKEN" 2>/dev/null | grep -q .; then
        FOUND2=1; break
    fi
    sleep 1
done
if [ -n "$FOUND2" ]; then
    ok "исходящее письмо доставлено обратно в ящик (~${i}s)"
    HDRS=$("${COMPOSE[@]}" exec -T dovecot doveadm fetch -u "$TEST_USER" hdr \
            mailbox INBOX HEADER Subject "outbound $TOKEN" 2>/dev/null)
    echo "$HDRS" | grep -qi "^DKIM-Signature:" && ok "DKIM-подпись присутствует (rspamd)" || fail "нет DKIM-подписи"
else
    fail "письмо с 587 не доставлено за 30 секунд"
fi

echo "=== 6. Неверный пароль на 587 должен отклоняться ==="
if "${COMPOSE[@]}" exec -T postfix swaks \
        --server postfix:587 --tls \
        --auth PLAIN --auth-user "$TEST_USER" --auth-password "wrong-password" \
        --from "$TEST_USER" --to "$TEST_USER" --quit-after AUTH >/dev/null 2>&1; then
    fail "аутентификация с неверным паролем ПРОШЛА (не должна!)"
else
    ok "неверный пароль отклонён"
fi

echo "=== 7. Юникод в заголовках: обещание сервера должно совпадать с тем, что он умеет ==="
# Postfix по умолчанию анонсирует SMTPUTF8, а Dovecot 2.3 в LMTP его не умеет.
# Получалась ложь с последствиями: сервер соглашался принять письмо, а на
# доставке отбивал его НАВСЕГДА (5.6.7 «SMTPUTF8 is required, but was not
# offered»). Проверяем обе стороны разом — согласованность, а не настройку.
LMTP_CAPS=$("${COMPOSE[@]}" exec -T postfix sh -c     'printf "LHLO proba\r\nQUIT\r\n" | timeout 5 nc 172.28.0.54 24' 2>/dev/null || true)
SMTP_CAPS=$("${COMPOSE[@]}" exec -T postfix sh -c     'printf "EHLO proba\r\nQUIT\r\n" | timeout 5 nc 127.0.0.1 25' 2>/dev/null || true)
if echo "$LMTP_CAPS" | grep -qi SMTPUTF8; then
    # Dovecot научился — тогда и Postfix обязан анонсировать.
    echo "$SMTP_CAPS" | grep -qi SMTPUTF8         && ok "SMTPUTF8 умеют оба (можно убрать smtputf8_enable = no)"         || fail "Dovecot умеет SMTPUTF8, а Postfix его не анонсирует — возможности теряются"
else
    echo "$SMTP_CAPS" | grep -qi SMTPUTF8         && fail "Postfix обещает SMTPUTF8, которого Dovecot не умеет: письма будут отбиваться навсегда"         || ok "SMTPUTF8 не обещается, раз доставить такое письмо нечем"
fi

# И само письмо: тема кириллицей БЕЗ MIME-кодирования — ровно тот случай,
# который отбивался с 5.6.7.
UTOKEN="utf8-$(date +%s)"
"${COMPOSE[@]}" exec -T postfix sh -c     "printf 'Subject: \320\237\321\200\320\276\320\262\320\265\321\200\320\272\320\260 $UTOKEN\r\nFrom: $TEST_USER\r\nTo: $TEST_USER\r\n\r\ntelo\r\n' | sendmail -f $TEST_USER $TEST_USER" >/dev/null 2>&1
UFOUND=""
for i in $(seq 1 20); do
    if "${COMPOSE[@]}" exec -T dovecot doveadm search -u "$TEST_USER" mailbox INBOX text "$UTOKEN" 2>/dev/null | grep -q .; then
        UFOUND=yes; break
    fi
    sleep 1
done
[ -n "$UFOUND" ]     && ok "письмо с восьмибитным заголовком доставлено (~${i}s)"     || fail "письмо с восьмибитным заголовком не дошло — проверьте smtputf8_enable"

echo
echo "=== ИТОГ: OK=$PASS, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
