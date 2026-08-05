#!/usr/bin/env bash
# Показательный ящик для снимков в инструкции.
#
# Снимать инструкцию с тестового ящика нельзя: он забит служебными письмами
# вида «outbound t178592812012296», и на картинках в руководстве это выглядит
# так, будто продукт им и занимается. Здесь заводится отдельный ящик с
# осмысленной перепиской — рабочие письма, рассылка, письмо с вложением.
#
# Ящик одноразовый: `--clean` убирает его целиком. В боевой установке этот
# скрипт не нужен и в поставку не входит.
#
# Запуск:  bash docs/manual/seed-demo.sh
#          bash docs/manual/seed-demo.sh --clean
set -u

HERE="$(dirname "$0")"
ROOT="$HERE/../.."
COMPOSE="docker compose -f $ROOT/infra/docker-compose.yml"

DEMO_MAIL="${DEMO_EMAIL:-demo@mail.local}"
DEMO_PASS="${DEMO_PASSWORD:-demo12345}"
DEMO_USER="${DEMO_MAIL%%@*}"

dov() { MSYS_NO_PATHCONV=1 $COMPOSE exec -T dovecot sh -c "$1" 2>&1; }

sql() { MSYS_NO_PATHCONV=1 $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-mailserver}" \
        -d "${POSTGRES_DB:-mailserver}" -qtA -c "$1" 2>&1; }

# Уборка снимает и почту, и НАСТРОЙКИ ящика. Иначе повторный запуск
# накладывается на прежний: правила задваиваются, а сборщик от прошлого раза
# продолжает таскать письма — и снимки показывают не то, что делает скрипт.
# Первая же пересборка это и показала: сборщик, оставшийся от предыдущего
# запуска, перелил в показательный ящик триста служебных писем.
# Колонка с адресом в каждой таблице называется по-своему. Первая версия
# этой уборки везде писала `email` — запросы падали, вывод был заглушен, и
# уборка молча ничего не делала. Правила накапливались от запуска к запуску,
# а разбирался я с этим как с дефектом продукта. Поэтому ошибки psql здесь
# больше НЕ подавляются: молчаливая уборка хуже её отсутствия.
clean_mailbox() { # clean_mailbox <адрес>
    mail="$1"; user="${1%%@*}"
    dov "doveadm expunge -u '$mail' mailbox '*' all" >/dev/null 2>&1
    dov "rm -rf /var/mail/vhosts/mail.local/$user" >/dev/null 2>&1
    for pair in mail_filters:account_email mail_signatures:account_email \
                mail_user_settings:account_email external_accounts:owner_email \
                linked_accounts:owner_email; do
        t="${pair%%:*}"; col="${pair##*:}"
        out="$(sql "DELETE FROM $t WHERE $col='$mail';")"
        case "$out" in *ERROR*) echo "  уборка $t: $out" ;; esac
    done
    out="$(sql "DELETE FROM virtual_users WHERE email='$mail';")"
    case "$out" in *ERROR*) echo "  уборка virtual_users: $out" ;; esac
}

if [ "${1:-}" = "--clean" ]; then
    clean_mailbox "$DEMO_MAIL"
    clean_mailbox "staryi@mail.local"
    echo "показательный ящик $DEMO_MAIL и его источник удалены"
    exit 0
fi

# Повторный запуск начинает с чистого листа: скрипт должен давать один и тот
# же ящик независимо от того, сколько раз его звали.
clean_mailbox "$DEMO_MAIL"
clean_mailbox "staryi@mail.local"

echo "=== Создаём $DEMO_MAIL ==="
bash "$ROOT/infra/scripts/create-mailbox.sh" "$DEMO_MAIL" "$DEMO_PASS" >/dev/null 2>&1
dov "doveadm mailbox status -u '$DEMO_MAIL' messages INBOX" | grep -q INBOX \
    || { echo "ящик не создан"; exit 1; }

# Письма отправляются с заметным разбросом по времени, чтобы в списке были
# видны разделители «Сегодня» / «Вчера» — это часть интерфейса, и на снимке
# она должна быть настоящей, а не подрисованной.
send() { # send <от кого> <имя> <тема> <текст>
    MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix swaks \
        --server postfix:25 --helo client.example.com \
        --from "$1" --to "$DEMO_MAIL" \
        --header "From: $2 <$1>" \
        --header "Subject: $3" \
        --header 'Content-Type: text/plain; charset=UTF-8' \
        --body "$4" >/dev/null 2>&1
}

echo "=== Наполняем перепиской ==="

send "i.petrova@example.com" "Ирина Петрова" \
    "Протокол разногласий по договору № 452/26" \
    "Добрый день!

Направляю на согласование протокол разногласий по договору № 452/26.
Основные правки — в пунктах 4.2 и 7.1: сроки поставки и порядок приёмки.

Прошу посмотреть до пятницы, дальше отдаём юристам.

С уважением,
Ирина Петрова
отдел закупок"

send "a.sokolov@example.com" "Алексей Соколов" \
    "Re: Смета на второй этап" \
    "Смету посмотрел, в целом согласен.

Один вопрос: в позиции 12 указано 40 часов на интеграцию, но у нас
похожая задача заняла 25. Уточните, пожалуйста, откуда разница.

Алексей"

send "no-reply@vestnik.example.com" "Вестник отрасли" \
    "Дайджест недели: что изменилось в регулировании" \
    "Здравствуйте!

В выпуске: новые требования к отчётности с 1 сентября, разбор
трёх судебных решений и календарь конференций на осень.

Читать выпуск: https://vestnik.example.com/weekly/2026-31

Отписаться: https://vestnik.example.com/unsubscribe"

send "m.orlova@example.com" "Мария Орлова" \
    "Планёрка перенесена на четверг" \
    "Коллеги, планёрка переезжает с вторника на четверг, 11:00.
Переговорная та же.

Мария"

send "d.kuznetsov@example.com" "Дмитрий Кузнецов" \
    "Доступы к тестовому контуру" \
    "Привет!

Доступы к тестовому контуру выданы, логин прежний.
Пароль отправил отдельным письмом, как договаривались.

Если что-то не открывается — пиши, разберёмся.

Дмитрий"

send "hr@example.com" "Отдел кадров" \
    "График отпусков на IV квартал" \
    "Уважаемые коллеги!

Напоминаем, что график отпусков на IV квартал нужно согласовать
с руководителем до 20 августа.

Форма — во вложении к предыдущей рассылке.

Отдел кадров"

send "e.volkova@example.com" "Елена Волкова" \
    "Итоги встречи с подрядчиком" \
    "Добрый день!

Коротко по встрече:
— сроки подтвердили, сдвиг на неделю согласован;
— по бюджету вернёмся после уточнения объёмов;
— следующий созвон 12 августа.

Подробности в протоколе.

Елена"

echo "  отправлено 7 писем, ждём раскладки…"
sleep 8

COUNT=$(dov "doveadm search -u '$DEMO_MAIL' mailbox INBOX all" | grep -c . || true)
echo "=== Во «Входящих»: $COUNT ==="

# Часть писем читаем: список, где всё непрочитано, выглядит неестественно,
# а разница между прочитанным и непрочитанным — заметная часть интерфейса.
dov "doveadm flags add -u '$DEMO_MAIL' '\\\\Seen' mailbox INBOX 1:3" >/dev/null 2>&1
dov "doveadm flags add -u '$DEMO_MAIL' '\\\\Flagged' mailbox INBOX 1" >/dev/null 2>&1
echo "  три письма помечены прочитанными, одно — флажком"

[ "$COUNT" -ge 6 ]

# --- Настройки ящика: правила и сбор почты ------------------------------
#
# Без этого снимки страниц «Фильтры» и «Почта с других ящиков» показывают
# пустые страницы — в руководстве это выглядит так, будто возможности нет.
# Правила и сборщик заводятся ЧЕРЕЗ НАСТОЯЩИЙ API, а не записью в базу:
# картинка должна показывать то, что человек действительно увидит.

API="${API_URL:-http://127.0.0.1:8080}"
JAR="$(mktemp)"

curl -s -c "$JAR" -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$DEMO_MAIL\",\"password\":\"$DEMO_PASS\"}" -o /dev/null

# Тело запроса передаётся ФАЙЛОМ, а не аргументом `-d`.
#
# В оболочке Windows аргумент с кириллицей доезжает до curl уже в однобайтовой
# кодировке: «договор» превращается в семь байт вместо четырнадцати. Сервер
# такое тело не принимает — и первые версии этого скрипта молча заводили
# только правила с латиницей, а снимок показывал три одинаковых правила
# вместо трёх разных. Через файл байты не трогает никто.
post_json() { # post_json <путь> <тело>
    body="$(mktemp)"
    printf '%s' "$2" > "$body"
    curl -s -b "$JAR" -X POST "$API$1" -H 'Content-Type: application/json' \
        --data-binary "@$body"
    rm -f "$body"
}

mk_folder() { # mk_folder <имя>
    post_json /api/folders "{\"name\":\"$1\",\"parentId\":null}" \
        | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4
}

F_DOGOVORY="$(mk_folder 'Договоры')"
F_RASSYLKI="$(mk_folder 'Рассылки')"

mk_rule() { # mk_rule <поле> <значение> <папка> <пометить прочитанным>
    out="$(post_json /api/settings/filters \
        "{\"id\":\"\",\"enabled\":true,\"auto\":false,
          \"conditions\":[{\"field\":\"$1\",\"operator\":\"contains\",\"value\":\"$2\"}],
          \"actions\":{\"moveToFolderId\":\"$3\",\"markRead\":$4,\"markFlagged\":false,
                       \"applyToExistingFolderIds\":[],\"forwardTo\":null,\"autoReply\":null,
                       \"continueOtherFilters\":false,\"applyToSpam\":false}}")"
    # Отказ должен быть виден. Молчаливый пропуск правила даёт снимок, на
    # котором меньше правил, чем задумано, — и это замечаешь уже в готовом PDF.
    case "$out" in
        *'"id"'*) ;;
        *) echo "  ПРАВИЛО НЕ СОЗДАНО ($1 содержит $2): $out" ;;
    esac
}

mk_rule subject 'договор' "$F_DOGOVORY" false
mk_rule from 'vestnik.example.com' "$F_RASSYLKI" true
mk_rule subject 'планёрка' 'inbox' false
echo "  заведены 3 правила фильтрации и 2 папки"

# Сборщик указывает на отдельный ЛЁГКИЙ ящик того же стенда: соединение
# настоящее, и состояние на снимке настоящее. На тестовый ящик указывать
# нельзя — в нём триста служебных писем, и сборщик перелил бы их в
# показательный, то есть ровно тот мусор, ради избавления от которого этот
# ящик и заведён.
SRC_MAIL="staryi@mail.local"
SRC_PASS="staryi12345"
bash "$ROOT/infra/scripts/create-mailbox.sh" "$SRC_MAIL" "$SRC_PASS" >/dev/null 2>&1
MSYS_NO_PATHCONV=1 $COMPOSE exec -T postfix swaks --server postfix:25 \
    --helo client.example.com --from "arhiv@example.com" --to "$SRC_MAIL" \
    --header "From: Архив писем <arhiv@example.com>" \
    --header "Subject: Письмо со старого адреса" \
    --header 'Content-Type: text/plain; charset=UTF-8' \
    --body "Это письмо лежит на старом сервере и будет забрано сборщиком." >/dev/null 2>&1
sleep 3

curl -s -b "$JAR" -X POST "$API/api/settings/collectors" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SRC_MAIL\",\"password\":\"$SRC_PASS\",\"host\":\"dovecot\",\"port\":143,
         \"protocol\":\"imap\",\"secure\":false,\"allowInsecureTls\":true,
         \"targetFolderId\":\"inbox\",\"leaveOnServer\":true,\"applyFilters\":true}" >/dev/null
echo "  подключён внешний ящик $SRC_MAIL"

rm -f "$JAR"
