#!/usr/bin/env bash
# ------------------------------------------------------------------
# Отказ части системы должен быть ВИДЕН.
#   bash infra/test-failure-visible.sh
#
# Что закрепляется (три беды одного рода — «сломалось, а сигнала нет»):
#
#   1. Проба /healthz отвечала {ok:true} безусловно. При остановленном
#      Redis каждый запрос вошедшего пользователя падал с 500, вход не
#      работал вовсе — а контейнер оставался healthy, и обратный прокси
#      продолжал слать туда трафик. Теперь проба краснеет (503) на отказ
#      того, без чего продукт НЕ РАБОТАЕТ, и остаётся зелёной при отказе
#      того, без чего он работает хуже: иначе перезапуски пошли бы по
#      кругу, а лечили бы не ту болезнь.
#
#   2. В сводке админки не было ни антиспама, ни Redis, ни своего
#      резольвера. Лежащий rspamd означает не только спам во «Входящих»,
#      но и исходящие БЕЗ подписи DKIM — тихую потерю репутации домена,
#      о которой узнать было неоткуда.
#
#   3. При лежащем сервере приложения nginx отдавал свою страницу
#      «502 Bad Gateway» в HTML. Интерфейс ждёт {error, message} и
#      показывал человеку английское «Bad Gateway» в тот момент, когда
#      объяснение нужнее всего.
#
# ВНИМАНИЕ: проверка НАМЕРЕННО останавливает службы и поднимает обратно.
# Запускать на стенде, а не на боевом сервере.
# ------------------------------------------------------------------
set -u

# Путь оставляем относительным (как в test-queue-survives.sh): абсолютный
# путь Windows Git Bash переписывает по дороге в docker, и файл не находится.
HERE="$(dirname "$0")"
COMPOSE="docker compose -f $HERE/docker-compose.yml"
BASE="${MAIL_URL:-http://127.0.0.1:8080}"
ADMIN_HOST="${ADMIN_HOST:-admin.mail.local}"
ADMIN_LOGIN="${ADMIN_LOGIN:-rukovodstvo}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-manual12345}"

OK=0; FAIL=0
ok()   { printf '  [OK] %s\n' "$1"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '       . %s\n' "$1"; }
dc()   { MSYS_NO_PATHCONV=1 $COMPOSE "$@"; }

# Проба спрашивается ИЗНУТРИ контейнера: наружу порт api не публикуется,
# и именно так её дёргает healthcheck образа.
probe() { # probe <путь> -> "<код> <тело>"
    dc exec -T api sh -c \
        "wget -qO- --server-response 'http://127.0.0.1:3000$1' 2>&1 | tr -d '\r'"
}
probe_code() {
    probe "$1" | grep -oE 'HTTP/1\.1 [0-9]+' | head -1 | grep -oE '[0-9]+$'
}
probe_body() {
    dc exec -T api sh -c "wget -qO- 'http://127.0.0.1:3000$1' 2>/dev/null"
}

wait_healthy() { # wait_healthy <служба>
    for _ in $(seq 1 60); do
        dc ps "$1" 2>/dev/null | grep -q healthy && return 0
        sleep 2
    done
    return 1
}

restore_all() {
    echo "=== Возврат стенда в рабочее состояние ==="
    dc start redis rspamd unbound dovecot api >/dev/null 2>&1
    for svc in redis rspamd unbound dovecot api; do
        wait_healthy "$svc" && printf '       . %s поднят\n' "$svc" \
                            || printf '       . %s НЕ поднялся — проверьте руками\n' "$svc"
    done
}
trap restore_all EXIT

echo "=== 0. Исходное состояние: всё поднято ==="
if [ "$(probe_code /healthz)" = "200" ]; then
    ok "проба /healthz зелёная на здоровом стенде"
else
    fail "проба /healthz не зелёная на здоровом стенде — дальше мерить нечего"
    exit 1
fi
HEALTH="$(probe_body /health)"
MISSING=""
for part in '"id":"redis"' '"id":"imap"' '"id":"postgres"'; do
    printf '%s' "$HEALTH" | grep -q "$part" || MISSING="$MISSING $part"
done
[ -z "$MISSING" ] && ok "человекочитаемое /health перечисляет части (redis, imap, postgres)" \
                  || fail "в /health не хватает частей:$MISSING"

echo
echo "=== 1. Останов Redis: без него не работает НИЧЕГО для вошедшего ==="
dc stop redis >/dev/null 2>&1
sleep 4
CODE="$(probe_code /healthz)"
if [ "$CODE" = "503" ]; then
    ok "проба покраснела: 503 (не 500 — сервер цел, недоступна часть)"
else
    fail "проба ответила $CODE вместо 503 — отказ Redis снова невидим"
fi
probe_body /health | grep -q '"status":"fail"' \
    && ok "/health говорит status=fail и называет виновника" \
    || fail "/health не показывает отказ"
# Проверка контейнера обязана дойти до unhealthy, иначе оркестратор
# и обратный прокси продолжат считать узел исправным.
UNHEALTHY=0
for _ in $(seq 1 30); do
    dc ps api 2>/dev/null | grep -q unhealthy && { UNHEALTHY=1; break; }
    sleep 2
done
[ "$UNHEALTHY" = 1 ] && ok "контейнер api помечен unhealthy" \
                     || fail "контейнер api остался healthy при мёртвом Redis"

dc start redis >/dev/null 2>&1
wait_healthy redis
for _ in $(seq 1 30); do
    [ "$(probe_code /healthz)" = "200" ] && break
    sleep 2
done
[ "$(probe_code /healthz)" = "200" ] && ok "после возвращения Redis проба зеленеет сама" \
                                     || fail "проба не позеленела после возвращения Redis"

echo
echo "=== 2. Останов антиспама: продукт работает хуже, но РАБОТАЕТ ==="
dc stop rspamd unbound >/dev/null 2>&1
sleep 3
CODE="$(probe_code /healthz)"
if [ "$CODE" = "200" ]; then
    ok "проба контейнера осталась зелёной — перезапуск api ничего бы не вылечил"
else
    fail "проба покраснела из-за антиспама ($CODE): так перезапуски пойдут по кругу"
fi

JAR="$(mktemp)"
LOGIN_ANSWER="$(curl -s -c "$JAR" -H "Host: $ADMIN_HOST" -H 'Content-Type: application/json' \
     -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
     "$BASE/api/admin/auth/login" 2>/dev/null)"
OVERVIEW="$(curl -s -b "$JAR" -H "Host: $ADMIN_HOST" "$BASE/api/admin/overview")"

# Разбор сводки. python3 — потому что на Ubuntu Server 22.04 (той самой ОС,
# под которую делается продукт) команды `python` НЕТ вовсе: пакет
# python-is-python3 в неё не входит. Здесь стояло `python`, ошибка
# «command not found» гасилась в 2>/dev/null, состояние всегда выходило
# пустым — и три проверки ниже проваливались ВСЕГДА, на любом стенде,
# обвиняя при этом сводку админки. Запасной `python` оставлен для машин,
# где наоборот.
PY="$(command -v python3 || command -v python || true)"

# Состояние службы из сводки. Объявлена ДО развилки ниже: ею пользуется и
# проверка «после возвращения rspamd подпись снова зелёная» за развилкой.
python_state() { # python_state <id> -> состояние службы из сводки
    [ -n "$PY" ] || return 0
    printf '%s' "$OVERVIEW" | "$PY" -c "
import json,sys
d=json.load(sys.stdin)
print(next((s['state'] for s in d['services'] if s['id']==sys.argv[1]),'НЕТ'))
" "$1" 2>/dev/null
}

# Вход в админку раньше не проверялся вовсе. При чужом логине или пароле
# (логин по умолчанию — «rukovodstvo», и на конкретном стенде его может
# не быть) сводка приходит как {"error":"UNAUTHORIZED"}, а тест выдавал
# семь отказов подряд: «в сводке нет строки rspamd», «антиспам показан
# исправным, хотя он остановлен» и так далее. Все семь — неправда: сводку
# просто не показали. Причину теперь называем один раз и прямо.
if printf '%s' "$OVERVIEW" | grep -q '"error":"UNAUTHORIZED"'; then
    if printf '%s' "$LOGIN_ANSWER" | grep -q '"ok":true'; then
        # Вход приняли, а сводку не отдали — значит до неё не доехала cookie
        # сессии. На боевой установке она помечена Secure (COOKIE_SECURE=true),
        # и по обычному http curl её не отправляет: разница между стендом
        # разработки и боевым сервером, а не поломка продукта.
        fail "вход принят, но сводка пришла без него — cookie сессии не доехала"
        note "на боевой установке cookie помечена Secure, а $BASE — обычный HTTP"
        note "запускайте по HTTPS (MAIL_URL=https://…) либо на стенде с COOKIE_SECURE=false"
    else
        fail "не удалось войти в админку как «$ADMIN_LOGIN» — сводку проверить нечем"
        note "ответ входа: $(printf '%s' "$LOGIN_ANSWER" | head -c 120)"
        note "свои задаются переменными ADMIN_LOGIN и ADMIN_PASSWORD"
    fi
elif [ -z "$PY" ]; then
    fail "нет ни python3, ни python — сводку админки нечем разобрать"
else
# Три службы обязаны быть в сводке — до этого их там не было вовсе.
for id in rspamd redis unbound dkim; do
    printf '%s' "$OVERVIEW" | grep -q "\"id\":\"$id\"" \
        && ok "в сводке админки есть строка «$id»" \
        || fail "в сводке админки нет строки «$id»"
done
# И обязаны быть красными: молчащий антиспам — это почта без проверки.
[ "$(python_state rspamd)" = "fail" ] && ok "антиспам показан отказавшим" \
                                      || fail "антиспам показан исправным, хотя он остановлен"
[ "$(python_state dkim)" = "fail" ] \
    && ok "подпись исходящих показана отказавшей (письма уходят без DKIM)" \
    || fail "подпись исходящих показана исправной, хотя rspamd остановлен"
[ "$(python_state unbound)" = "fail" ] && ok "свой резольвер показан отказавшим" \
                                       || fail "свой резольвер показан исправным"
fi

dc start rspamd unbound >/dev/null 2>&1
wait_healthy rspamd
OVERVIEW="$(curl -s -b "$JAR" -H "Host: $ADMIN_HOST" "$BASE/api/admin/overview")"
[ "$(python_state dkim)" = "ok" ] \
    && ok "после возвращения rspamd подпись исходящих снова зелёная" \
    || note "подпись исходящих ещё не позеленела — rspamd мог не успеть прогреться"

echo
echo "=== 3. Лежащий сервер приложения: ответ по договору, а не страница nginx ==="
dc stop api >/dev/null 2>&1
sleep 2
check_json_error() { # check_json_error <заголовок Host> <путь> <что это>
    local host="$1" path="$2" what="$3"
    local body code
    body="$(curl -s -H "Host: $host" "$BASE$path")"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" "$BASE$path")"
    if printf '%s' "$body" | grep -q '"error":"UPSTREAM_UNAVAILABLE"'; then
        ok "$what: тело по договору {error, message}, статус $code"
    else
        fail "$what: пришло не по договору (статус $code): $(printf '%s' "$body" | head -c 120)"
    fi
    # Кириллицу ищем ПО БАЙТАМ, а не диапазоном [А-Яа-я].
    #
    # Диапазон из многобайтных букв — это выражение по правилам сортировки
    # текущей локали. На сервере локаль обычно C/POSIX (ни LANG, ни LC_ALL
    # в systemd-юните и в docker exec не заданы), и GNU grep отвечает на
    # такой диапазон «Invalid collation character», выходя с ошибкой. То
    # есть проверка «в ответе есть русский текст» на боевой машине падала
    # ВСЕГДА — независимо от того, что там на самом деле пришло.
    #
    # В UTF-8 кириллица U+0400…U+04FF — это два байта, первый из D0..D3.
    # Такой поиск не зависит от локали вовсе, поэтому LC_ALL=C здесь не
    # обход, а условие: он выключает разбор байтов как символов.
    printf '%s' "$body" | LC_ALL=C grep -qE $'[\xd0-\xd3][\x80-\xbf]' \
        && ok "$what: текст по-русски" \
        || fail "$what: в сообщении нет русского текста"
    printf '%s' "$body" | grep -qi '<html' \
        && fail "$what: в ответе всё ещё HTML" \
        || ok "$what: HTML-страницы прокси больше нет"
}
check_json_error "127.0.0.1" "/api/folders" "почта /api/folders"
check_json_error "$ADMIN_HOST" "/api/admin/overview" "админка /api/admin/overview"

dc start api >/dev/null 2>&1
wait_healthy api

echo
echo "=== 4. Свои 503 приложения прокси НЕ подменяет ==="
# Тонкость, из-за которой proxy_intercept_errors намеренно не включён:
# 503 UPSTREAM_UNAVAILABLE от самого приложения (оборвался IMAP) — часть
# договора, и подменять его текстом про «сервер приложения» нельзя.
dc stop dovecot >/dev/null 2>&1
sleep 2
LOGIN="$(curl -s -H 'Content-Type: application/json' \
    -d '{"email":"demo@mail.local","password":"demo12345"}' "$BASE/api/auth/login")"
if printf '%s' "$LOGIN" | grep -q '"error":"UPSTREAM_UNAVAILABLE"'; then
    if printf '%s' "$LOGIN" | grep -q 'Сервер приложения'; then
        fail "ответ приложения подменён заглушкой прокси"
    else
        ok "ответ приложения дошёл до клиента своим текстом: $(printf '%s' "$LOGIN" | head -c 80)"
    fi
else
    note "вход ответил иначе — проверить нечего: $(printf '%s' "$LOGIN" | head -c 120)"
fi
dc start dovecot >/dev/null 2>&1
wait_healthy dovecot
rm -f "$JAR"

echo
echo "=== ИТОГ: OK=$OK, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
