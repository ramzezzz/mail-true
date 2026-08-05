#!/usr/bin/env bash
# Письмо, уже принятое сервером, не должно пропадать, пока лежит Dovecot.
#
# Что закрепляется. Доставка в Dovecot идёт по LMTP, и адресат был задан
# ИМЕНЕМ контейнера. Пока контейнер существует, служба имён Docker отвечает,
# и сбой получается временный: письмо ждёт в очереди. Но стоит контейнеру
# исчезнуть — не подняться после обновления, остаться на время обслуживания —
# и Postfix получает «Host not found». Это ПОСТОЯННАЯ ошибка: письмо
# отбивается отправителю и стирается.
#
# Цена: владелец ящика теряет письмо совсем, а отправителю приходит «адрес не
# существует», хотя ящик жив. Чинить нечего — письма уже нет.
#
# Лечится адресом вместо имени: постоянный адрес Dovecot закреплён в
# docker-compose.yml (DOVECOT_IP) как раз ради таких случаев.
#
# ВНИМАНИЕ: проверка НАМЕРЕННО останавливает Dovecot и поднимает обратно.
# Запускать на стенде, а не на боевом сервере.
#
# Запуск: bash infra/test-queue-survives.sh
set -u

HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/docker-compose.yml"

USER_M="queue@mail.local"
PASS_M="queue12345"
MARK="QUEUE-$(date +%s)"

OK=0; FAIL=0
ok()   { printf '  [OK] %s\n' "$1"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
dc()   { MSYS_NO_PATHCONV=1 $COMPOSE "$@"; }

restore_dovecot() {
    dc up -d dovecot >/dev/null 2>&1
    for _ in $(seq 1 60); do
        dc ps dovecot 2>/dev/null | grep -q healthy && break
        sleep 2
    done
}
trap restore_dovecot EXIT

echo "=== 0. Ящик ==="
bash "$HERE/scripts/create-mailbox.sh" "$USER_M" "$PASS_M" >/dev/null 2>&1
dc exec -T dovecot sh -c "doveadm mailbox status -u '$USER_M' messages INBOX" 2>&1 | grep -q INBOX \
    && ok "ящик готов" || { fail "ящик не создан"; exit 1; }

echo "=== 1. Убираем Dovecot ДО отправки ==="
# Порядок важен. Первая версия проверки сначала отправляла письмо, а потом
# пыталась придержать его в очереди — и не успевала: доставка занимает доли
# секунды, письмо уходило раньше, чем до него доходила рука. Проверка при этом
# бодро сообщала «письмо пропало», хотя оно было доставлено.
#
# Убираем именно контейнер, а не останавливаем службу: перезапуск безопасен и
# дефекта не показывает. Опасен долго лежащий Dovecot, когда имя перестаёт
# разрешаться вовсе.
dc stop dovecot >/dev/null 2>&1
dc rm -f dovecot >/dev/null 2>&1
ok "контейнер Dovecot удалён — имя больше не разрешается"

echo "=== 2. Отправляем письмо: оно принимается сервером и попадает в очередь ==="
# Через sendmail, а не по SMTP: проверки приёма спрашивают у Dovecot квоту,
# а его сейчас нет. Нам важна судьба письма, УЖЕ принятого сервером.
dc exec -T postfix sh -c "printf 'Subject: $MARK
From: ochered@example.com
To: $USER_M

письмо в очереди
'     | sendmail -f ochered@example.com '$USER_M'" >/dev/null 2>&1
sleep 3
dc exec -T postfix postqueue -f >/dev/null 2>&1
sleep 8

echo "=== 3. ГЛАВНОЕ: письмо должно ДОЖДАТЬСЯ в очереди, а не пропасть ==="
QUEUE="$(dc exec -T postfix postqueue -p 2>/dev/null || true)"
if printf '%s' "$QUEUE" | grep -q "$USER_M"; then
    ok "письмо дождалось в очереди"
    if dc logs --tail 60 postfix 2>&1 | grep -q "Host or domain name not found"; then
        fail "отказ по-прежнему постоянный — письмо уцелело случайно"
    else
        ok "отказ временный: адресат задан адресом, а не именем"
    fi
else
    fail "ПИСЬМО ПРОПАЛО: принятое сервером письмо уничтожено, пока лежал Dovecot"
    dc logs --tail 40 postfix 2>&1 | grep -iE "bounced|Host or domain name not found" | tail -4
fi

echo "=== 4. Поднимаем Dovecot — письмо должно доставиться ==="
restore_dovecot
# Первое соединение после подъёма Dovecot ещё упирается в «connection refused»:
# контейнер уже здоров, а служба LMTP внутри принимает не сразу. Postfix после
# этого ждёт до следующей попытки по своему расписанию, поэтому подталкиваем
# очередь на каждом обороте, а не один раз в начале.
DELIVERED=0
for _ in $(seq 1 20); do
    dc exec -T postfix postqueue -f >/dev/null 2>&1
    sleep 3
    FOUND="$(dc exec -T dovecot sh -c "doveadm search -u '$USER_M' mailbox INBOX header subject '$MARK'" 2>&1)"
    case "$FOUND" in
        *" "*) DELIVERED=1; break ;;
    esac
    LAST_SEARCH="$FOUND"
done
[ "$DELIVERED" = 1 ] && ok "письмо доставлено после возвращения Dovecot" \
                     || fail "письмо не доставилось за минуту после подъёма Dovecot"

echo "=== 5. Уборка ==="
dc exec -T dovecot sh -c "rm -rf /var/mail/vhosts/mail.local/queue" >/dev/null 2>&1
dc exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" -d "${POSTGRES_DB:-mailserver}" \
    -qtA -c "DELETE FROM virtual_users WHERE email='$USER_M';" >/dev/null 2>&1
echo "  временный ящик удалён"

echo
echo "=== ИТОГ: OK=$OK, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
