#!/usr/bin/env bash
# Подмена отправителя: сотрудник не должен отправлять письма от чужого имени.
#
# Что закрепляется. Порты отправки (587 и 465) требуют входа по логину, но
# НЕ проверяли, что адрес в письме принадлежит вошедшему. Проверено на стенде:
# обычный ящик вошёл, отправил письмо от адреса директора — сервер принял без
# возражений и поставил свою подпись DKIM. У получателя SPF, DKIM и DMARC
# сошлись бы полностью: отличить такое письмо от настоящего нечем.
#
# Лечится картой соответствия «адрес → чей он» (smtpd_sender_login_maps) и
# проверкой reject_sender_login_mismatch на портах отправки. На порту 25
# проверки быть не должно: туда приходит почта со всего мира.
#
# Запуск: bash infra/test-sender-spoofing.sh
set -u

HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/docker-compose.yml"

USER_A="spoofa@mail.local"; PASS_A="spoofa12345"
USER_B="spoofb@mail.local"; PASS_B="spoofb12345"
ALIAS="priyomnaya@mail.local"

OK=0; FAIL=0
ok()   { printf '  [OK] %s\n' "$1"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
dc()   { MSYS_NO_PATHCONV=1 $COMPOSE "$@"; }
sql()  { dc exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" -d "${POSTGRES_DB:-mailserver}" -qtA -c "$1" 2>&1; }

# send <порт> <доп.флаги> <логин> <пароль> <от кого> <кому>
send() {
    port="$1"; extra="$2"; login="$3"; pw="$4"; from="$5"; to="$6"
    # shellcheck disable=SC2086
    dc exec -T postfix swaks --server "127.0.0.1:$port" $extra \
        --auth-user "$login" --auth-password "$pw" \
        --from "$from" --to "$to" \
        --header "Subject: SPOOF-CHECK" \
        --header 'Content-Type: text/plain; charset=UTF-8' \
        --body "проверка подмены отправителя" 2>&1
}

echo "=== 0. Ящики для проверки ==="
bash "$HERE/scripts/create-mailbox.sh" "$USER_A" "$PASS_A" >/dev/null 2>&1
bash "$HERE/scripts/create-mailbox.sh" "$USER_B" "$PASS_B" >/dev/null 2>&1
# domain_id обязателен: алиас принадлежит домену, а не висит сам по себе.
# Первая версия проверки этого не знала, вставка падала, и проверка алиасов
# показывала «дефект», которого нет. Ошибку скрыло перенаправление вывода —
# поэтому здесь оно снято.
DOMAIN_ID="$(sql "SELECT id FROM virtual_domains WHERE name='mail.local' LIMIT 1;" | tr -d '' | head -1)"
if [ -z "$DOMAIN_ID" ]; then
    fail "не найден домен mail.local — алиасы проверить не на чем"
else
    OUT="$(sql "INSERT INTO virtual_aliases (domain_id, source, destination, active)
                VALUES ($DOMAIN_ID, '$ALIAS', '$USER_A', true)
                ON CONFLICT DO NOTHING;")"
    case "$OUT" in *ERROR*) fail "алиас не создан: $OUT" ;; esac
fi
sql "SELECT email FROM virtual_users WHERE email IN ('$USER_A','$USER_B');" | grep -q "$USER_A" \
    && ok "ящики готовы" || fail "ящики не созданы"

echo "=== 1. От своего адреса — должно проходить ==="
OUT="$(send 587 --tls "$USER_A" "$PASS_A" "$USER_A" "$USER_B")"
echo "$OUT" | grep -q "250 2.0.0 Ok: queued" \
    && ok "письмо от своего адреса принято" \
    || fail "письмо от своего адреса отвергнуто: $(echo "$OUT" | grep -E '^<~ *[45]' | tail -2)"

echo "=== 2. ГЛАВНОЕ: от чужого адреса — должно отвергаться ==="
OUT="$(send 587 --tls "$USER_A" "$PASS_A" "$USER_B" "$USER_B")"
if echo "$OUT" | grep -qE "Sender address rejected|not owned by user|553|550"; then
    ok "подмена отправителя отвергнута: $(echo "$OUT" | grep -oE '5[0-9][0-9] [^<]*' | head -1)"
else
    fail "ПОДМЕНА ПРОШЛА: сотрудник отправил письмо от чужого имени"
    echo "$OUT" | grep -E "^<~ *[0-9]" | tail -4
fi

echo "=== 3. Несуществующий адрес отправителя — тоже отвергается ==="
OUT="$(send 587 --tls "$USER_A" "$PASS_A" "direktor@mail.local" "$USER_B")"
echo "$OUT" | grep -qE "Sender address rejected|553|550" \
    && ok "письмо от выдуманного адреса отвергнуто" \
    || fail "письмо от выдуманного адреса принято"

echo "=== 4. То же на порту 465 ==="
OUT="$(send 465 --tlsc "$USER_A" "$PASS_A" "$USER_B" "$USER_B")"
echo "$OUT" | grep -qE "Sender address rejected|553|550" \
    && ok "порт 465 тоже проверяет отправителя" \
    || fail "на порту 465 подмена проходит"

echo "=== 5. Свой алиас отправлять разрешено ==="
# У кого адрес приёмной ведёт на его ящик, тот вправе писать и от приёмной.
OUT="$(send 587 --tls "$USER_A" "$PASS_A" "$ALIAS" "$USER_B")"
echo "$OUT" | grep -q "250 2.0.0 Ok: queued" \
    && ok "письмо от своего алиаса принято" \
    || fail "письмо от своего алиаса отвергнуто — люди не смогут писать от общих адресов"

echo "=== 6. Чужой алиас отправлять нельзя ==="
OUT="$(send 587 --tls "$USER_B" "$PASS_B" "$ALIAS" "$USER_A")"
echo "$OUT" | grep -qE "Sender address rejected|553|550" \
    && ok "чужой алиас отвергнут" \
    || fail "любой может писать от имени приёмной"

echo "=== 7. Порт 25 проверку отправителя НЕ применяет ==="
# Туда приходит почта со всего мира: отправитель там чужой по определению.
OUT="$(dc exec -T postfix swaks --server postfix:25 --helo client.example.com \
       --from "kto-to@example.com" --to "$USER_A" \
       --header "Subject: SPOOF-CHECK-25" --body "внешнее письмо" 2>&1)"
echo "$OUT" | grep -q "250 2.0.0 Ok: queued" \
    && ok "внешняя почта по-прежнему принимается" \
    || fail "проверка отправителя заехала на порт 25 и ломает приём почты"

echo "=== 8. Уборка ==="
sql "DELETE FROM virtual_aliases WHERE source='$ALIAS';" >/dev/null 2>&1
for m in "$USER_A" "$USER_B"; do
    u="${m%%@*}"
    dc exec -T dovecot sh -c "rm -rf /var/mail/vhosts/mail.local/$u" >/dev/null 2>&1
    sql "DELETE FROM virtual_users WHERE email='$m';" >/dev/null 2>&1
done
echo "  временные ящики удалены"

echo
echo "=== ИТОГ: OK=$OK, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
