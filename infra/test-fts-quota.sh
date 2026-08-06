#!/usr/bin/env bash
# Повторяемая проверка полнотекстового поиска (Dovecot FTS Xapian) и квот.
#   bash infra/test-fts-quota.sh
#
# Что проверяется:
#   1. Плагины fts_xapian и quota подняты, службы разбора вложений живы
#   2. Поиск по теме, телу, адресу, словоформе, регистру, букве ё
#   3. Поиск ПО СОДЕРЖИМОМУ ВЛОЖЕНИЙ: PDF и DOCX
#   4. Скорость поиска на ящике из 120+ писем
#   5. Переиндексация с нуля (infra/scripts/fts-reindex.sh --purge)
#   6. Индекс переживает пересоздание контейнера
#   7. Квоты: лимит из Postgres, IMAP GETQUOTAROOT, предупреждение,
#      отказ LMTP при переполнении и отказ Postfix ещё на RCPT TO
#
# Тестовые ящики: fts@<домен>, ftsquota@<домен>, ftsperf@<домен>.
# Скрипт идемпотентен: ящики очищаются перед прогоном.
set -uo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$INFRA_DIR/docker-compose.yml")
set -a; . <(tr -d '\r' < "$INFRA_DIR/.env"); set +a

# Выполнить команду в контейнере СЕРВИСА (первый аргумент — имя сервиса
# из docker-compose.yml: dovecot, postfix, postgres).
#
# Раньше здесь стоял `docker exec mail-dovecot …`, то есть обращение по
# жёсткому имени контейнера. Жёсткие имена из docker-compose.yml убраны:
# они глобальны на весь демон Docker и не давали поднять два стенда на
# одной машине. Теперь контейнер называется <имя проекта>-<сервис>-<номер>,
# и обращаться к нему нужно через compose — тогда скрипт работает при любом
# COMPOSE_PROJECT_NAME.
#
# -T обязателен: без него compose пытается выделить псевдотерминал, а
# скрипт запускают из конвейеров и без tty.
# MSYS_NO_PATHCONV: под Git Bash MSYS иначе ломает /tmp/... в C:\...
dex() { local svc="$1"; shift; MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T "$svc" "$@"; }

# Идентификатор контейнера сервиса — нужен там, где compose не подходит
# (у `docker cp` аналога в compose нет).
cid() { "${COMPOSE[@]}" ps -q "$1" 2>/dev/null | head -1; }

FTS_USER="fts@${MAIL_DOMAIN}";     FTS_PASS="fts12345"
QUO_USER="ftsquota@${MAIL_DOMAIN}"; QUO_PASS="quota12345"
PRF_USER="ftsperf@${MAIL_DOMAIN}"; PRF_PASS="perf12345"

PASS=0; FAIL=0
ok()   { echo "  [OK] $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# Отправка письма снаружи через postfix:25
#
# Тема и тело кодируются по правилам почты (MIME): кириллица в заголовке —
# base64 в виде =?UTF-8?B?…?=, тело — с явным charset и 8-битным переносом.
# Без этого Rspamd справедливо начисляет письму несколько баллов за
# «сломанные» заголовки (R_BAD_CTE_7BIT, SUBJECT_NEEDS_ENCODING,
# R_MISSING_CHARSET), суммарно перешагивает порог, и Sieve уносит письмо
# в папку «Спам» — а проверки ищут его во «Входящих» и не находят.
# Так что дело не в антиспаме, а в том, что тест слал некорректные письма.
send() { # send <кому> <тема> <тело-файл-или-текст> [доп. аргументы swaks]
    local to="$1" subj="$2" body="$3"; shift 3
    local subj_enc
    subj_enc="=?UTF-8?B?$(printf '%s' "$subj" | base64 -w0)?="
    dex postfix swaks --server postfix:25 --helo client.example.com \
        --from sender@example.com --to "$to" --header "Subject: $subj_enc" \
        --header 'Content-Type: text/plain; charset=UTF-8' \
        --header 'Content-Transfer-Encoding: 8bit' \
        --body "$body" "$@" 2>&1
}

# IMAP-сессия: печатает ответ сервера
imap() { # imap <логин> <пароль> <команды одной строкой с \r\n>
    dex dovecot sh -c \
        "printf 'a login $1 $2\r\n$3z logout\r\n' | nc -q 3 127.0.0.1 143"
}

# Число писем, найденных поиском (doveadm)
found() { dex dovecot doveadm search -u "$1" mailbox INBOX "${@:2}" 2>/dev/null | grep -c .; }

echo "=== 0. Подготовка ==="
for u in "$FTS_USER:$FTS_PASS" "$QUO_USER:$QUO_PASS" "$PRF_USER:$PRF_PASS"; do
    bash "$INFRA_DIR/scripts/create-mailbox.sh" "${u%%:*}" "${u##*:}" >/dev/null 2>&1 \
        && ok "ящик ${u%%:*}" || fail "не создан ящик ${u%%:*}"
    dex dovecot doveadm expunge -u "${u%%:*}" mailbox INBOX all >/dev/null 2>&1
done
dex postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "UPDATE virtual_users SET quota_bytes=1073741824 WHERE email IN ('$FTS_USER','$PRF_USER');" >/dev/null 2>&1
dex postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "UPDATE virtual_users SET quota_bytes=102400 WHERE email='$QUO_USER';" >/dev/null 2>&1
dex dovecot doveadm quota recalc -u "$QUO_USER" >/dev/null 2>&1

echo "=== 1. Плагины и службы ==="
CONF=$(dex dovecot doveadm config 2>/dev/null)
grep -q "fts = xapian"           <<<"$CONF" && ok "плагин fts = xapian включён"          || fail "fts не настроен"
grep -q "fts_decoder = decode2text" <<<"$CONF" && ok "разбор вложений (fts_decoder)"     || fail "fts_decoder не настроен"
grep -q "quota = maildir"        <<<"$CONF" && ok "плагин quota (бэкенд maildir)"        || fail "quota не настроен"
grep -q "imap_quota"             <<<"$CONF" && ok "IMAP-расширение QUOTA"                || fail "imap_quota не подключён"
dex dovecot sh -c '/usr/lib/dovecot/decode2text.sh | grep -q "application/pdf"' \
    && ok "decode2text отвечает списком форматов" || fail "decode2text не работает"
for bin in pdftotext catdoc xls2csv unzip unrtf; do
    dex dovecot sh -c "command -v $bin >/dev/null" \
        && ok "разборщик $bin в образе" || fail "нет разборщика $bin"
done

echo "=== 2. Письма для поиска ==="
TOKEN="fts$(date +%s)"
send "$FTS_USER" "Договор аренды $TOKEN" "В теле письма упомянуты документами и счета" >/dev/null
send "$FTS_USER" "Новогодняя ёлка" "Ёлка стоит в приёмной, ещё есть подарки" >/dev/null

# Вложения с заведомо уникальными словами внутри (генерируются заново)
#
# Генератор — обычный node-скрипт без зависимостей, и раньше он звался
# просто «node». На машине разработчика node есть, а на Ubuntu Server 22.04,
# под которую делается продукт, его НЕТ: весь стек живёт в контейнерах, и
# ставить node на хост незачем. Ошибка гасилась в 2>/dev/null, и проверка
# отвечала «не удалось создать вложения», не называя причину, — то есть на
# сервере эта строка падала всегда.
#
# Если node на хосте нет, гоним тот же скрипт в контейнере autoconfig: это
# node-служба нашего же стека, и лишних образов тянуть не нужно. Файлы
# возвращаем на хост, потому что дальше они всё равно едут в postfix через
# docker cp, а копировать из контейнера в контейнер напрямую нечем.
ATT_DIR="$INFRA_DIR/data/fts-test"
mkdir -p "$ATT_DIR"
make_attachments() {
    if command -v node >/dev/null 2>&1; then
        node "$INFRA_DIR/scripts/make-test-attachments.mjs" "$ATT_DIR" >/dev/null 2>&1
        return $?
    fi
    local ac; ac="$(cid autoconfig)"
    [ -n "$ac" ] || return 1
    docker cp "$INFRA_DIR/scripts/make-test-attachments.mjs" "$ac:/tmp/mk-att.mjs" >/dev/null 2>&1 || return 1
    dex autoconfig node /tmp/mk-att.mjs /tmp/fts-att >/dev/null 2>&1 || return 1
    docker cp "$ac:/tmp/fts-att/fts-test.pdf"  "$ATT_DIR/fts-test.pdf"  >/dev/null 2>&1 || return 1
    docker cp "$ac:/tmp/fts-att/fts-test.docx" "$ATT_DIR/fts-test.docx" >/dev/null 2>&1 || return 1
    return 0
}
if make_attachments && [ -s "$ATT_DIR/fts-test.pdf" ] && [ -s "$ATT_DIR/fts-test.docx" ]; then
    ok "тестовые вложения созданы"
else
    fail "не удалось создать вложения (нужен node на хосте или живой контейнер autoconfig)"
fi
POSTFIX_CID="$(cid postfix)"
docker cp "$ATT_DIR/fts-test.pdf"  "$POSTFIX_CID:/tmp/fts-test.pdf"  >/dev/null 2>&1
docker cp "$ATT_DIR/fts-test.docx" "$POSTFIX_CID:/tmp/fts-test.docx" >/dev/null 2>&1
send "$FTS_USER" "Счёт во вложении PDF" "Файл приложен" \
    --attach-type application/pdf --attach-name fts-test.pdf --attach @/tmp/fts-test.pdf >/dev/null
send "$FTS_USER" "Отчёт во вложении DOCX" "Файл приложен" \
    --attach-type application/vnd.openxmlformats-officedocument.wordprocessingml.document \
    --attach-name fts-test.docx --attach @/tmp/fts-test.docx >/dev/null

# Индекс строится в фоне сразу при доставке — ждём его появления, не запуская поиск-переборку
for _ in $(seq 1 30); do
    [ "$(found "$FTS_USER" text kryptonorbis)" -ge 1 ] && break
    sleep 1
done

echo "=== 3. Поиск ==="
[ "$(found "$FTS_USER" subject "$TOKEN")" -ge 1 ]        && ok "по слову из темы"                  || fail "по слову из темы"
[ "$(found "$FTS_USER" text счета)" -ge 1 ]              && ok "по слову из тела"                  || fail "по слову из тела"
[ "$(found "$FTS_USER" from sender@example.com)" -ge 4 ] && ok "по адресу отправителя"             || fail "по адресу отправителя"
[ "$(found "$FTS_USER" text документ)" -ge 1 ]           && ok "по словоформе (документ ~ документами)" || fail "словоформа не найдена"
[ "$(found "$FTS_USER" text ДОКУМЕНТАМИ)" -ge 1 ]        && ok "регистр не важен"                  || fail "поиск чувствителен к регистру"
[ "$(found "$FTS_USER" text елка)" -ge 1 ]               && ok "буква ё: «елка» находит «ёлка»"    || fail "ё/е не приравниваются"
[ "$(found "$FTS_USER" text приемной)" -ge 1 ]           && ok "буква ё: «приемной» находит «приёмной»" || fail "ё/е не приравниваются (2)"
[ "$(found "$FTS_USER" text kryptonorbis)" -ge 1 ]       && ok "СЛОВО ВНУТРИ PDF-вложения"         || fail "слово внутри PDF не найдено"
[ "$(found "$FTS_USER" text квазисенокос)" -ge 1 ]       && ok "СЛОВО ВНУТРИ DOCX-вложения"        || fail "слово внутри DOCX не найдено"
[ "$(found "$FTS_USER" text заведомонесуществующее)" -eq 0 ] && ok "ложных срабатываний нет"       || fail "поиск нашёл несуществующее слово"

echo "=== 4. Поиск по IMAP (как это увидит клиент) ==="
IMAP_OUT=$(imap "$FTS_USER" "$FTS_PASS" 'b select INBOX\r\nc search TEXT "kryptonorbis"\r\n')
grep -qa "^\* SEARCH [0-9]" <<<"$IMAP_OUT" && ok "IMAP SEARCH TEXT находит слово из PDF" \
    || fail "IMAP SEARCH не нашёл слово из PDF"

echo "=== 5. Скорость на ящике из 120 писем ==="
BULK=$(dex dovecot doveadm search -u "$PRF_USER" mailbox INBOX all 2>/dev/null | grep -c .)
if [ "$BULK" -lt 120 ]; then
    dex dovecot sh -c "i=1; while [ \$i -le 120 ]; do printf 'From: bulk%d@example.com\nTo: $PRF_USER\nSubject: Массовое письмо %d\n\nТекст номер %d, слово наполнитель, ещё немного букв\n' \$i \$i \$i | doveadm save -u $PRF_USER -m INBOX; i=\$((i+1)); done" >/dev/null 2>&1
    sleep 5
fi
BULK=$(dex dovecot doveadm search -u "$PRF_USER" mailbox INBOX all 2>/dev/null | grep -c .)
[ "$BULK" -ge 120 ] && ok "в ящике $BULK писем" || fail "не удалось наполнить ящик ($BULK)"
SEARCH_OUT=$(imap "$PRF_USER" "$PRF_PASS" 'b select INBOX\r\nc search TEXT "наполнитель"\r\n')
# Dovecot сам сообщает время выполнения в теге ответа: «c OK Search completed (… secs)»
SPEED=$(grep -a "^c OK" <<<"$SEARCH_OUT" | sed 's/.*(\(.*\) secs).*/\1/')
HITS=$(grep -a "^\* SEARCH" <<<"$SEARCH_OUT" | tr -d '\r' | wc -w)
HITS=$((HITS > 2 ? HITS - 2 : 0))   # минус слова «*» и «SEARCH»
if [ -n "$SPEED" ]; then
    ok "IMAP SEARCH по $BULK письмам: $SPEED сек (совпадений: $HITS)"
else
    fail "не удалось замерить время поиска"
fi

echo "=== 6. Переиндексация с нуля ==="
if bash "$INFRA_DIR/scripts/fts-reindex.sh" --purge "$FTS_USER" >/dev/null 2>&1; then
    [ "$(found "$FTS_USER" text kryptonorbis)" -ge 1 ] \
        && ok "после полной переиндексации слово из PDF снова находится" \
        || fail "после переиндексации слово из PDF потеряно"
else
    fail "скрипт переиндексации завершился с ошибкой"
fi

echo "=== 7. Индекс переживает пересоздание контейнера ==="
"${COMPOSE[@]}" up -d --force-recreate dovecot >/dev/null 2>&1
for _ in $(seq 1 30); do
    state=$("${COMPOSE[@]}" ps --format '{{.Health}}' dovecot 2>/dev/null)
    [ "$state" = "healthy" ] && break
    sleep 1
done
dex dovecot sh -c "ls /var/mail/index/${MAIL_DOMAIN}/fts/xapian-indexes >/dev/null 2>&1" \
    && ok "каталог xapian-indexes на месте (том mailindex)" || fail "индекс не сохранился"
[ "$(found "$FTS_USER" text kryptonorbis)" -ge 1 ] \
    && ok "поиск работает сразу после перезапуска, без переиндексации" \
    || fail "после перезапуска поиск не работает"

echo "=== 8. Квоты: лимит из Postgres и IMAP GETQUOTAROOT ==="
# doveadm quota get: «User quota STORAGE <занято> <лимит> <процент>» (в КБ)
Q=$(dex dovecot doveadm quota get -u "$QUO_USER" 2>/dev/null | awk '/STORAGE/{print $5}')
[ "$Q" = "100" ] && ok "лимит из virtual_users.quota_bytes: 100 КБ" || fail "лимит не подхватился (получено «$Q»)"
QOUT=$(imap "$QUO_USER" "$QUO_PASS" 'b select INBOX\r\nc getquotaroot INBOX\r\n')
grep -qa '^\* QUOTA "User quota" (STORAGE 0 100)' <<<"$QOUT" \
    && ok "IMAP GETQUOTAROOT отдаёт (STORAGE 0 100)" \
    || fail "IMAP GETQUOTAROOT вернул не то: $(grep -a '^\* QUOTA' <<<"$QOUT")"
grep -qa "QUOTA" <<<"$QOUT" && ok "расширение QUOTA объявлено в CAPABILITY" || fail "нет QUOTA в CAPABILITY"

echo "=== 9. Заполняем ящик до лимита ==="
dex postfix sh -c 'head -c 12000 /dev/urandom | base64 | head -c 12000 > /tmp/fts-fill.txt'
for i in $(seq 1 8); do send "$QUO_USER" "Наполнение $i" @/tmp/fts-fill.txt >/dev/null; done
sleep 3
USED=$(dex dovecot doveadm quota get -u "$QUO_USER" 2>/dev/null | awk '/STORAGE/{print $6}')
[ "${USED:-0}" -ge 90 ] && ok "ящик заполнен на ${USED}%" || fail "не удалось заполнить ящик (${USED}%)"
dex dovecot doveadm search -u "$QUO_USER" mailbox INBOX subject заполнен 2>/dev/null | grep -q . \
    && ok "владелец получил предупреждение «Ящик заполнен на 90%»" \
    || fail "предупреждение о заполнении не пришло"

echo "=== 10. Отказ при превышении ==="
# Письмо, которое заведомо не влезает: LMTP обязан ответить 5.2.2, а не проглотить
OVER=$(send "$QUO_USER" "Не влезет" @/tmp/fts-fill.txt)
if grep -qa "552 5.2.2" <<<"$OVER"; then
    ok "отказ ещё на SMTP: $(grep -oa '55[0-9] 5\.2\.2[^<]*' <<<"$OVER" | head -1)"
else
    sleep 3
    if "${COMPOSE[@]}" logs --tail=40 postfix 2>&1 | grep -q "dsn=5.2.2, status=bounced"; then
        ok "LMTP отклонил письмо 552 5.2.2, Postfix вернул его отправителю (bounce)"
    else
        fail "переполненный ящик не отклонил письмо"
    fi
fi
# Policy-сервис Dovecot, который спрашивает Postfix на RCPT TO
POL=$(dex dovecot sh -c "printf 'request=smtpd_access_policy\nrecipient=$QUO_USER\nsize=60000\n\n' | nc -q 2 127.0.0.1 12340")
grep -qa "action=552 5.2.2" <<<"$POL" \
    && ok "quota-status отвечает Postfix отказом: $(tr -d '\r' <<<"$POL" | head -1)" \
    || fail "quota-status не отказал переполненному ящику: $POL"
POL_OK=$(dex dovecot sh -c "printf 'request=smtpd_access_policy\nrecipient=$FTS_USER\nsize=60000\n\n' | nc -q 2 127.0.0.1 12340")
grep -qa "action=DUNNO" <<<"$POL_OK" && ok "обычному ящику quota-status не мешает" || fail "quota-status мешает обычному ящику"
grep -q "check_policy_service inet:dovecot:12340" "$INFRA_DIR/postfix/conf/main.cf.template" \
    && ok "Postfix спрашивает квоту на RCPT TO (check_policy_service)" \
    || fail "в main.cf нет check_policy_service для квот"

echo
echo "=== ИТОГ: OK=$PASS, FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
