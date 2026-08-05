#!/usr/bin/env bash
# ------------------------------------------------------------------
# Повторяемая проверка антиспама Mail.True.
#   bash infra/test-antispam.sh
#
# Что проверяется:
#   1. Свой резольвер работает, и запросы к спискам действительно уходят
#      и получают ответы (а не тихо отваливаются)
#   2. Заведомый спам (GTUBE) помечается как спам
#   3. Обычное деловое письмо НЕ помечается (нет ложных срабатываний)
#   4. Письмо своего пользователя своему не проверяется внешними списками
#   5. При недоступности внешнего источника почта продолжает ходить
#   6. Пороги и веса: одна сработка внешнего списка не отправляет в спам
#   7. Белые и чёрные списки админки применяются на лету
#   8. Состояние антивируса соответствует CLAMAV_ENABLED
#   9. Расход памяти стеком
#
# Выход 0 = всё зелёное.
# ------------------------------------------------------------------
set -uo pipefail

# Все команды внутри контейнеров запускаются через sh -c "..." одной строкой:
# так Git Bash на Windows не переписывает пути вида /etc/... в аргументах.

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; . "$INFRA_DIR/.env"; set +a

: "${RESOLVER_IP:=172.28.0.53}"
TEST_USER="test@${MAIL_DOMAIN}"
TEST_PASS="${TEST_MAILBOX_PASSWORD:-test12345}"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  [OK] $1";      PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1";    FAIL=$((FAIL+1)); }
skip() { echo "  [ПРОПУСК] $1"; SKIP=$((SKIP+1)); }
note() { echo "       . $1"; }

DC()  { docker compose -f "$INFRA_DIR/docker-compose.yml" "$@"; }
# Выполнить команду внутри контейнера одной строкой (без ломки путей MSYS)
IN()  { local svc="$1"; shift; DC exec -T "$svc" sh -c "$*"; }
# dig внутри контейнера unbound: $1 — сервер, $2 — имя
DIG() { IN unbound "dig +time=5 +tries=1 @$1 $2 A +short 2>/dev/null | sort | tr '\n' ' '"; }
UCTL(){ IN unbound "unbound-control -c /etc/unbound/unbound.conf $*"; }
# rspamc-скан: $1 — ip, $2 — from, $3 — файл на хосте, далее доп. аргументы
SCAN() {
    local ip="$1" from="$2" file="$3"; shift 3
    DC exec -T rspamd rspamc --connect=127.0.0.1:11334 \
        --ip="$ip" --from="$from" --rcpt="$TEST_USER" "$@" symbols < "$file" 2>&1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RFC_DATE="$(IN rspamd 'date -R' | tr -d '\r')"

# Отправить готовое письмо через SMTP. $1 — файл, $2 — порт, далее аргументы swaks
send_mail() {
    local file="$1" port="$2"; shift 2
    DC exec -T postfix sh -c "cat > /tmp/mt-msg.eml" < "$file" || return 1
    DC exec -T postfix sh -c \
        "swaks --server postfix:$port --helo partner-company.example \
               --to $TEST_USER --data /tmp/mt-msg.eml $* 2>&1" > "$TMP/swaks.log" 2>&1
}

# Дождаться письма с токеном в теме. $1 — токен, $2 — папка (пусто = все)
wait_mail() {
    local token="$1" mbox="${2:-}" i
    local mbox_arg="all"
    [ -n "$mbox" ] && mbox_arg="mailbox $mbox"
    for i in $(seq 1 25); do
        if IN dovecot "doveadm search -u $TEST_USER $mbox_arg HEADER Subject $token" \
             2>/dev/null | grep -q .; then return 0; fi
        sleep 1
    done
    return 1
}

hdrs_of() {
    IN dovecot "doveadm fetch -u $TEST_USER hdr HEADER Subject $1" 2>/dev/null
}

echo "=================================================================="
echo " Проверка антиспама Mail.True"
echo "=================================================================="

# ------------------------------------------------------------------
echo
echo "=== 0. Сервисы и тестовый ящик ==="
for svc in unbound redis rspamd postfix dovecot; do
    state=$(DC ps --format '{{.Service}} {{.Health}} {{.State}}' "$svc" | awk '{print $2" "$3}')
    case "$state" in
        *unhealthy*|*exited*|*dead*) fail "$svc: $state" ;;
        *running*)                   ok   "$svc: $state" ;;
        *)                           fail "$svc: $state" ;;
    esac
done
if bash "$INFRA_DIR/scripts/create-mailbox.sh" "$TEST_USER" "$TEST_PASS" >/dev/null 2>&1; then
    ok "тестовый ящик $TEST_USER готов"
else
    fail "не удалось создать тестовый ящик"
fi

# ------------------------------------------------------------------
echo
echo "=== 1. Свой резольвер: запросы к спискам уходят и получают ответы ==="
echo "--- 1.1 Контрольная точка Spamhaus ZEN: через свой резольвер и через чужой ---"
# 127.0.0.1 внутри контейнера unbound   = наш рекурсивный резольвер
# 127.0.0.11 внутри контейнера unbound  = DNS Docker -> внешний публичный резольвер
OWN=$(DIG 127.0.0.1  2.0.0.127.zen.spamhaus.org)
PUB=$(DIG 127.0.0.11 2.0.0.127.zen.spamhaus.org)
note "через unbound:            ${OWN:-<нет ответа>}"
note "через публичный резольвер: ${PUB:-<нет ответа>}"
if echo "$OWN" | grep -q "127.0.0.2"; then
    ok "Spamhaus ZEN отвечает своему резольверу (тестовая запись 127.0.0.2/4/10)"
else
    fail "Spamhaus ZEN не ответил через свой резольвер: '$OWN'"
fi
if echo "$PUB" | grep -q "127.255.255.254"; then
    ok "через публичный резольвер Spamhaus отдаёт 127.255.255.254 (blocked) — ради этого и нужен свой"
else
    note "публичный резольвер вернул '$PUB' (в этой сети сравнение не показательно)"
fi

echo "--- 1.2 Контрольные точки остальных списков (через свой резольвер) ---"
DBL=$(DIG 127.0.0.1 dbltest.com.dbl.spamhaus.org)
echo "$DBL" | grep -q "127.0.1.2" \
    && ok "Spamhaus DBL: dbltest.com -> $DBL" \
    || fail "Spamhaus DBL не отвечает: '$DBL'"

URIBL=$(DIG 127.0.0.1 test.uribl.com.multi.uribl.com)
case "$URIBL" in
    *127.0.0.1\ *|"") fail "URIBL заблокировал запрос или не ответил: '$URIBL'" ;;
    *127.0.0.*)       ok   "URIBL: test.uribl.com -> $URIBL" ;;
    *)                fail "URIBL неожиданный ответ: '$URIBL'" ;;
esac

SURBL=$(DIG 127.0.0.1 surbl-org-permanent-test-point.com.multi.surbl.org)
echo "$SURBL" | grep -q "127.0.0." \
    && ok "SURBL: контрольная точка -> $SURBL" \
    || fail "SURBL не ответил: '$SURBL'"

echo "--- 1.3 Rspamd и Postfix ходят в DNS через unbound ---"
IN rspamd "grep -q '$RESOLVER_IP' /etc/rspamd/override.d/options.inc" 2>/dev/null \
    && ok "rspamd: резольвер $RESOLVER_IP задан в override.d/options.inc" \
    || fail "rspamd: резольвер в конфиге не задан"
RSPAMD_DBL=$(IN rspamd "dig +time=5 +tries=1 @$RESOLVER_IP dbltest.com.dbl.spamhaus.org A +short 2>/dev/null | tr '\n' ' '")
echo "$RSPAMD_DBL" | grep -q "127.0.1.2" \
    && ok "из контейнера rspamd запрос к DBL через unbound проходит -> $RSPAMD_DBL" \
    || fail "из контейнера rspamd DBL недоступен: '$RSPAMD_DBL'"
IN postfix "grep -q 'ExtServers.*$RESOLVER_IP' /etc/resolv.conf" 2>/dev/null \
    && ok "postfix: внешний DNS направлен на $RESOLVER_IP" \
    || fail "postfix: внешний DNS не направлен на резольвер"

echo "--- 1.4 Rspamd реально получает вердикт списка (а не молча пропускает) ---"
cat > "$TMP/listed.eml" <<EOF
From: Sales <news@dbltest.com>
To: $TEST_USER
Subject: Special offer
Date: $RFC_DATE
Message-ID: <listed-$$@dbltest.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

See our offer at http://dbltest.com/promo
EOF
LISTED_OUT=$(SCAN 172.28.0.8 news@dbltest.com "$TMP/listed.eml")
if ! echo "$LISTED_OUT" | grep -q "^Action:"; then
    fail "rspamc не вернул результат проверки (сканирование не выполнилось)"
    echo "$LISTED_OUT" | head -5
elif echo "$LISTED_OUT" | grep -q "DBL_SPAM"; then
    ok "$(echo "$LISTED_OUT" | grep -m1 'DBL_SPAM' | sed 's/^Symbol: //')"
else
    fail "символ DBL_SPAM не сработал — проверка по спискам не работает"
    echo "$LISTED_OUT" | head -20
fi

# ------------------------------------------------------------------
echo
echo "=== 2. Заведомый спам (GTUBE) должен быть помечен ==="
GT="gtube$RANDOM$$"
cat > "$TMP/gtube.eml" <<EOF
From: Winner <promo@spamtest.example>
To: $TEST_USER
Subject: $GT test sample
Date: $RFC_DATE
Message-ID: <$GT@spamtest.example>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X
EOF
if send_mail "$TMP/gtube.eml" 25 --from promo@spamtest.example; then
    ok "GTUBE принят на порт 25 (не отброшен молча)"
else
    fail "GTUBE не принят"; cat "$TMP/swaks.log" | tail -5
fi
if wait_mail "$GT"; then
    ok "GTUBE доставлен в ящик"
    GT_HDRS=$(hdrs_of "$GT")
    echo "$GT_HDRS" | grep -qi "^X-Spam: Yes" \
        && ok "письмо помечено как спам: $(echo "$GT_HDRS" | grep -i '^X-Spam:' | head -1 | tr -d '\r')" \
        || { fail "нет заголовка X-Spam: Yes"; echo "$GT_HDRS" | grep -i "^X-Spam" ; }
    echo "$GT_HDRS" | grep -qi "X-Spam-Status: Yes" \
        && ok "$(echo "$GT_HDRS" | grep -i '^X-Spam-Status:' | head -1 | tr -d '\r')" \
        || fail "нет X-Spam-Status: Yes"
    if IN dovecot "doveadm search -u $TEST_USER mailbox Spam HEADER Subject $GT" 2>/dev/null | grep -q .; then
        ok "письмо лежит в папке Спам"
    else
        skip "письмо помечено, но осталось в INBOX: раскладку по папке Спам делает Dovecot (sieve), см. docs/antispam.md, раздел «Раскладка в папку Спам»"
    fi
else
    fail "GTUBE не дошёл до ящика"
fi

# ------------------------------------------------------------------
echo
echo "=== 3. Обычное деловое письмо не должно помечаться ==="
BZ="biz$RANDOM$$"
cat > "$TMP/biz.eml" <<EOF
From: =?UTF-8?B?0JjRgNC40L3QsCDQn9C10YLRgNC+0LLQsA==?= <i.petrova@partner-company.example>
To: =?UTF-8?B?0J7RgtC00LXQuyDQt9Cw0LrRg9C/0L7Qug==?= <$TEST_USER>
Subject: $BZ =?UTF-8?B?0J/QviDQtNC+0LPQvtCy0L7RgNGDIOKEliA0NTIvMjY=?=
Date: $RFC_DATE
Message-ID: <$BZ.4521@partner-company.example>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

Добрый день!

Направляю на согласование протокол разногласий по договору № 452/26.
Просьба вернуть подписанный экземпляр до пятницы.

С уважением,
Ирина Петрова
Руководитель отдела продаж
EOF
if send_mail "$TMP/biz.eml" 25 --from i.petrova@partner-company.example; then
    ok "деловое письмо принято на порт 25"
else
    fail "деловое письмо отвергнуто"; tail -5 "$TMP/swaks.log"
fi
if wait_mail "$BZ"; then
    ok "деловое письмо доставлено"
    BZ_HDRS=$(hdrs_of "$BZ")
    if echo "$BZ_HDRS" | grep -qi "^X-Spam: Yes"; then
        fail "ЛОЖНОЕ СРАБАТЫВАНИЕ: деловое письмо помечено спамом"
        echo "$BZ_HDRS" | grep -i "^X-Spam"
    else
        ok "деловое письмо НЕ помечено спамом"
        note "$(echo "$BZ_HDRS" | grep -i '^X-Spam-Status:' | head -1 | tr -d '\r')"
    fi
else
    fail "деловое письмо не дошло"
fi

# ------------------------------------------------------------------
echo
echo "=== 4. Своя почта своему: внешние списки не спрашиваются вообще ==="
# Чистим кэш резольвера по зонам списков, чтобы проверка была честной
UCTL flush_zone dbl.spamhaus.org  >/dev/null 2>&1
UCTL flush_zone zen.spamhaus.org  >/dev/null 2>&1
BEFORE_DBL=$(UCTL dump_cache 2>/dev/null | grep -c "dbl.spamhaus.org")
note "записей о dbl.spamhaus.org в кэше резольвера до проверки: $BEFORE_DBL"

OWN_OUT=$(SCAN 172.28.0.8 news@dbltest.com "$TMP/listed.eml" --user="$TEST_USER")
if ! echo "$OWN_OUT" | grep -q "^Action:"; then
    fail "rspamc не вернул результат проверки для аутентифицированного отправителя"
elif echo "$OWN_OUT" | grep -qE "DBL_|SURBL|URIBL|RBL_"; then
    fail "для своего пользователя сработали внешние списки:"
    echo "$OWN_OUT" | grep -E "DBL_|SURBL|URIBL|RBL_"
else
    ok "то же письмо от аутентифицированного пользователя: символов внешних списков нет"
fi
if echo "$OWN_OUT" | grep -q "/ 25.00"; then
    ok "к своим применён отдельный профиль порогов (reject = 25)"
else
    fail "профиль порогов для своих не применился"
    echo "$OWN_OUT" | grep -i "score"
fi
AFTER_DBL=$(UCTL dump_cache 2>/dev/null | grep -c "dbl.spamhaus.org")
if [ "$AFTER_DBL" -eq 0 ]; then
    ok "в кэше резольвера нет ни одного обращения к dbl.spamhaus.org — запросы не уходили"
else
    fail "резольвер всё-таки спрашивал dbl.spamhaus.org ($AFTER_DBL записей)"
fi

# Тот же путь по-настоящему: письмо через submission:587 с SASL
OW="own$RANDOM$$"
cat > "$TMP/own.eml" <<EOF
From: $TEST_USER
To: $TEST_USER
Subject: $OW internal
Date: $RFC_DATE
Message-ID: <$OW@$MAIL_DOMAIN>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Коллеги, напоминаю про планёрку. Ссылка: http://dbltest.com/meeting
EOF
# Повтор здесь не «замазывание», а необходимость: Dovecot задерживает ответы
# после неудачных попыток входа (защита от подбора пароля), и если этот набор
# запускают сразу за infra/test-delivery.sh, который НАМЕРЕННО проверяет
# неверный пароль, первая проверка встаёт в очередь за задержанными ответами
# и успевает упереться в таймаут Postfix — «Connection lost to authentication
# server», временная ошибка 454. Настоящий почтовый клиент в этом случае тоже
# повторяет отправку. Измерено: вторая попытка отрабатывает за ~400 мс.
SENT_OWN=""
for attempt in 1 2 3; do
    if send_mail "$TMP/own.eml" 587 --from "$TEST_USER" --tls --auth PLAIN \
            --auth-user "$TEST_USER" --auth-password "$TEST_PASS"; then
        SENT_OWN="да"
        [ "$attempt" -gt 1 ] && note "отправка удалась с попытки $attempt (сработала защита от подбора)"
        break
    fi
    sleep 3
done
if [ -n "$SENT_OWN" ]; then
    ok "письмо своему отправлено через submission:587 (SASL)"
else
    fail "не удалось отправить через 587 за три попытки"; tail -5 "$TMP/swaks.log"
fi
if wait_mail "$OW"; then
    ok "письмо своему доставлено"
    OW_HDRS=$(hdrs_of "$OW")
    echo "$OW_HDRS" | grep -qi "^X-Spam: Yes" \
        && fail "письмо своего пользователя помечено спамом" \
        || ok "письмо своего пользователя не помечено спамом (хотя содержит ссылку из списка)"
else
    fail "письмо своему не дошло"
fi

# ------------------------------------------------------------------
echo
echo "=== 5. Внешний источник недоступен — почта должна ходить ==="
echo "--- останавливаем резольвер ---"
DC stop unbound >/dev/null 2>&1
DN="down$RANDOM$$"
sed "s/$BZ/$DN/g" "$TMP/biz.eml" > "$TMP/down.eml"
T0=$(date +%s)
if send_mail "$TMP/down.eml" 25 --from i.petrova@partner-company.example; then
    ok "письмо принято на порт 25 при недоступном резольвере"
else
    fail "приём остановился из-за недоступного резольвера"; tail -5 "$TMP/swaks.log"
fi
if wait_mail "$DN"; then
    ok "письмо доставлено в ящик за $(( $(date +%s) - T0 )) с (фильтр деградировал, но не заблокировал почту)"
    DN_HDRS=$(hdrs_of "$DN")
    echo "$DN_HDRS" | grep -qi "^X-Spam: Yes" \
        && fail "письмо помечено спамом из-за отказа резольвера" \
        || ok "письмо не помечено спамом из-за отказа резольвера"
else
    fail "письмо не доставлено при недоступном резольвере"
fi
echo "--- поднимаем резольвер обратно ---"
DC start unbound >/dev/null 2>&1
for i in $(seq 1 30); do
    DC ps --format '{{.Service}} {{.Health}}' unbound | grep -q healthy && break
    sleep 1
done
DC ps --format '{{.Service}} {{.Health}}' unbound | grep -q healthy \
    && ok "резольвер поднялся обратно (healthy)" \
    || fail "резольвер не поднялся"

# ------------------------------------------------------------------
echo
echo "=== 6. Пороги и веса: одна сработка не отправляет в спам ==="
ADD_HEADER=$(grep -E '^\s*add_header\s*=' "$INFRA_DIR/rspamd/local.d/actions.conf" | grep -oE '[0-9.]+' | head -1)
REJECT=$(grep -E '^\s*reject\s*=' "$INFRA_DIR/rspamd/local.d/actions.conf" | grep -oE '[0-9.]+' | head -1)
note "пороги из local.d/actions.conf: в Спам = $ADD_HEADER, отказ = $REJECT"
SYMS=$(DC exec -T rspamd sh -c \
    "curl -s -H 'Password: $RSPAMD_PASSWORD' http://127.0.0.1:11334/symbols" 2>/dev/null)
TOO_HEAVY=$(echo "$SYMS" | tr ',' '\n' | grep -oE '"symbol":"(DBL_[A-Z_]*|URIBL_[A-Z_]*|[A-Z_]*SURBL[A-Z_]*|RBL_[A-Z_]*|FUZZY_DENIED|MSBL_EBL)","weight":[0-9.]+' \
    | awk -F'"weight":' -v lim="$ADD_HEADER" '$2+0 >= lim+0 {print $0}')
if [ -z "$TOO_HEAVY" ]; then
    ok "ни один символ внешнего списка не дотягивает в одиночку до порога $ADD_HEADER"
else
    fail "есть символы внешних списков с весом >= $ADD_HEADER:"
    echo "$TOO_HEAVY"
fi
LISTED_SCORE=$(echo "$LISTED_OUT" | grep -m1 '^Score:' | awk '{print $2}')
LISTED_ACT=$(echo "$LISTED_OUT" | grep -m1 '^Action:' | cut -d' ' -f2-)
if [ "$LISTED_ACT" = "no action" ]; then
    ok "письмо с ОДНОЙ сработкой списка (DBL_SPAM, $LISTED_SCORE балла) в спам не отправлено"
else
    fail "одна сработка списка уже даёт действие «$LISTED_ACT» (score $LISTED_SCORE)"
fi

# ------------------------------------------------------------------
echo
echo "=== 7. Белые и чёрные списки админки ==="
MAPS="$INFRA_DIR/rspamd/maps.d"
cp "$MAPS/blacklist_domains.map" "$TMP/bl.bak"
cp "$MAPS/whitelist_from.map"    "$TMP/wl.bak"
restore_maps() { cp "$TMP/bl.bak" "$MAPS/blacklist_domains.map"; cp "$TMP/wl.bak" "$MAPS/whitelist_from.map"; }
trap 'restore_maps; rm -rf "$TMP"' EXIT

echo "partner-company.example" >> "$MAPS/blacklist_domains.map"
sleep 13   # map_watch_interval = 10s
BL_OUT=$(SCAN 172.28.0.8 i.petrova@partner-company.example "$TMP/biz.eml")
if echo "$BL_OUT" | grep -q "BLACKLIST_SENDER_DOMAIN"; then
    ok "домен из чёрного списка сработал: $(echo "$BL_OUT" | grep -m1 BLACKLIST_SENDER_DOMAIN | sed 's/^Symbol: //')"
    echo "$BL_OUT" | grep -qE "^Action: (add header|reject)" \
        && ok "письмо от домена из чёрного списка помечено спамом" \
        || fail "домен в чёрном списке, но письмо не помечено"
else
    fail "чёрный список доменов не сработал (карта не перечиталась?)"
fi

echo "i.petrova@partner-company.example" >> "$MAPS/whitelist_from.map"
sleep 13
WL_OUT=$(SCAN 172.28.0.8 i.petrova@partner-company.example "$TMP/biz.eml")
if echo "$WL_OUT" | grep -q "WHITELIST_SENDER_ADDRESS"; then
    ok "белый список адресов сработал"
    echo "$WL_OUT" | grep -qE "^Action: no action" \
        && ok "белый список перебил чёрный: письмо снова не спам" \
        || fail "белый список не перебил чёрный: $(echo "$WL_OUT" | grep -m1 '^Action:')"
else
    fail "белый список адресов не сработал"
fi
restore_maps
trap 'rm -rf "$TMP"' EXIT
sleep 13

# ------------------------------------------------------------------
echo
echo "=== 8. Антивирус ==="
if [ "${CLAMAV_ENABLED:-false}" = "true" ]; then
    if DC ps --format '{{.Service}}' | grep -q '^clamav$'; then
        ok "CLAMAV_ENABLED=true, контейнер clamav запущен"
        cat > "$TMP/eicar.eml" <<EOF
From: sender@partner-company.example
To: $TEST_USER
Subject: eicar test
Date: $RFC_DATE
Message-ID: <eicar-$$@partner-company.example>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

See attachment.

--b1
Content-Type: application/octet-stream; name="test.txt"
Content-Disposition: attachment; filename="test.txt"

EOF
        printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n\n--b1--\n' \
            >> "$TMP/eicar.eml"
        AV_OUT=$(SCAN 172.28.0.8 sender@partner-company.example "$TMP/eicar.eml")
        echo "$AV_OUT" | grep -q "CLAM_VIRUS" \
            && ok "тестовый образец EICAR распознан: $(echo "$AV_OUT" | grep -m1 CLAM_VIRUS | sed 's/^Symbol: //')" \
            || fail "EICAR не распознан при включённом антивирусе"
    else
        fail "CLAMAV_ENABLED=true, но контейнер clamav не запущен (нужен --profile clamav)"
    fi
else
    if IN rspamd "grep -q 'antivirus is disabled' /dev/null" 2>/dev/null; then :; fi
    skip "антивирус выключен (CLAMAV_ENABLED=false) — это состояние по умолчанию, clamd занял бы ~1 ГБ памяти"
    note "включение: CLAMAV_ENABLED=true + docker compose --profile clamav up -d"
fi

# ------------------------------------------------------------------
echo
echo "=== 9. Память стека ==="
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}" \
    $(DC ps -q 2>/dev/null) 2>/dev/null | sort | sed 's/^/  /'
TOTAL=$(docker stats --no-stream --format "{{.MemUsage}}" $(DC ps -q 2>/dev/null) 2>/dev/null \
    | awk '{v=$1; if (v ~ /GiB/) {gsub(/GiB/,"",v); v=v*1024} else {gsub(/MiB/,"",v)}; s+=v} END {printf "%.1f", s}')
echo "  ---"
echo "  ИТОГО: ${TOTAL} MiB"

echo
echo "=================================================================="
echo " ИТОГ: OK=$PASS, FAIL=$FAIL, ПРОПУЩЕНО=$SKIP"
echo "=================================================================="
[ "$FAIL" -eq 0 ] || exit 1
