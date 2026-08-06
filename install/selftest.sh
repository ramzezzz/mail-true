#!/usr/bin/env bash
# ------------------------------------------------------------------
# Юнит-тесты установщика.
#
#   bash install/selftest.sh
#
# Проверяются те места, где ошибка не видна глазами и уже приводила к
# тихим потерям: разбор ответов, пароли-заглушки, список томов для
# резервной копии, развязка infra/.env и тома базы при восстановлении.
# Docker и живой стек не нужны — это разбор данных, а не работа со стеком.
#
# Код возврата: 0 — все проверки прошли, 1 — есть провалившиеся.
# ------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

T_PASS=0
T_FAIL=0

t_eq() { # t_eq <что> <получено> <ожидалось>
    if [ "$2" = "$3" ]; then
        T_PASS=$((T_PASS + 1))
        printf '  [ ОК ]   %s\n' "$1"
    else
        T_FAIL=$((T_FAIL + 1))
        printf '  [ НЕТ ]  %s\n           получено: «%s»\n           ожидалось: «%s»\n' "$1" "$2" "$3"
    fi
}

t_ok() { # t_ok <что> <команда...> — команда должна вернуть 0
    local what="$1"; shift
    if "$@" >/dev/null 2>&1; then
        T_PASS=$((T_PASS + 1)); printf '  [ ОК ]   %s\n' "$what"
    else
        T_FAIL=$((T_FAIL + 1)); printf '  [ НЕТ ]  %s (ожидался успех)\n' "$what"
    fi
}

t_no() { # t_no <что> <команда...> — команда должна вернуть не 0
    local what="$1"; shift
    if "$@" >/dev/null 2>&1; then
        T_FAIL=$((T_FAIL + 1)); printf '  [ НЕТ ]  %s (ожидался отказ)\n' "$what"
    else
        T_PASS=$((T_PASS + 1)); printf '  [ ОК ]   %s\n' "$what"
    fi
}

# ==================================================================
step "1. Разбор yes/no: опечатка не должна становиться значением по умолчанию"
# ==================================================================
t_eq "yes → yes"      "$(normalize_yes_no yes)"  "yes"
t_eq "Да → yes"       "$(normalize_yes_no 'Да')" "yes"
t_eq "true → yes"     "$(normalize_yes_no true)" "yes"
t_eq "no → no"        "$(normalize_yes_no no)"   "no"
t_eq "нет → no"       "$(normalize_yes_no 'нет')" "no"
# Ровно тот случай из отчёта: опечатка молча трактовалась как «no»
t_no "опечатка «yse» отвергается"   normalize_yes_no yse
t_no "опечатка «yess» отвергается"  normalize_yes_no yess
t_no "мусор отвергается"            normalize_yes_no maybe
t_no "пустое значение отвергается"  normalize_yes_no ''

# ==================================================================
step "2. Выбор из списка: MAILTRUE_TLS"
# ==================================================================
t_eq "letsencrypt принимается"  "$(normalize_choice letsencrypt 'letsencrypt selfsigned')" "letsencrypt"
t_eq "SelfSigned приводится к нижнему регистру" \
     "$(normalize_choice SelfSigned 'letsencrypt selfsigned')" "selfsigned"
# До исправления такие значения молча становились letsencrypt
t_no "опечатка «letsencript» отвергается" normalize_choice letsencript 'letsencrypt selfsigned'
t_no "«self-signed» отвергается"          normalize_choice self-signed 'letsencrypt selfsigned'

# ==================================================================
step "3. Пароли-заглушки"
# ==================================================================
# Значение из install/answers.example.env: 19 символов, проверку длины
# проходило, и боевые серверы уезжали с общеизвестным паролем.
EXAMPLE_PW="$(sed -n "s/^MAILTRUE_ADMIN_PASSWORD=//p" "$INSTALL_DIR/answers.example.env" | tail -1 | tr -d "'\"")"
t_eq "пароль из примера длиннее 10 символов (проверку длины проходил)" \
     "$([ "${#EXAMPLE_PW}" -ge 10 ] && echo yes || echo no)" "yes"
t_ok "пароль из примера распознаётся как заглушка" is_placeholder_password "$EXAMPLE_PW"
t_ok "change-me-... распознаётся"     is_placeholder_password 'change-me-postgres'
t_ok "«password» распознаётся"        is_placeholder_password 'password'
t_no "нормальный пароль не заглушка"  is_placeholder_password 'Xy7#kq2Lm9pR'

# ==================================================================
step "4. Тома для резервной копии"
# ==================================================================
# Список томов ОДИН на backup.sh и restore.sh: раздельные перечни уже
# привели к тому, что очередь Postfix не попала в копию.
VOL_NAMES=''
for spec in "${MT_BACKUP_VOLUMES[@]}"; do VOL_NAMES="$VOL_NAMES ${spec%%:*}"; done
# api-branding — свой логотип страниц входа (OEM). Восстановить его
# неоткуда: исходник лежит у заказчика. Без него после восстановления
# обе страницы входа молча возвращаются к чужому фирменному стилю.
for want_vol in vmail rspamd-data postfix-spool redisdata api-uploads api-branding; do
    t_ok "том $want_vol входит в резервную копию" \
        bash -c "printf '%s' '$VOL_NAMES' | grep -qw '$want_vol'"
done

# Обучение антиспама живёт в Redis, а не в rspamd-data.
#
# Эта проверка сторожит не список томов, а УБЕЖДЕНИЕ, из-за которого том
# Redis считали «просто кэшем» и держали в списке исключений. Убеждение было
# ошибочным: классификатор настроен на Redis, и восстановление из копии молча
# обнуляло обучение — каждую пометку «это спам», сделанную людьми за месяцы.
# Ничто при этом не ломалось: сервер просто снова начинал ошибаться, и понять
# почему было уже невозможно.
#
# Если однажды классификатор переведут обратно в файлы, эта проверка
# покраснеет и заставит пересмотреть список томов, а не молча разъехаться.
t_ok "байесовский классификатор хранится в Redis (иначе список томов устарел)" \
    bash -c "grep -q 'backend *= *\"redis\"' '$INFRA_DIR/rspamd/local.d/classifier-bayes.conf'"

# Тома из compose, объявленные постоянными, должны быть либо в копии,
# либо осознанно исключены. Каждое исключение — решение с причиной:
#   pgdata    — в копию идёт логический дамп (pg_dump): он переносим между
#               версиями Postgres, а том — нет;
#   mailindex — индексы выводятся из самих писем, а места занимают столько же;
#   clamav-db — базы антивируса скачиваются заново за несколько минут;
#   maillogs  — журналы доставки. Это история работы, а не данные людей:
#               письма от их потери не пропадают, а объём растёт без предела.
#               Они проворачиваются на диске и доступны в разделе «Журналы»
#               админки; класть их в каждую копию значит раздувать её тем,
#               что и так есть на сервере.
SKIP_VOLUMES='pgdata mailindex clamav-db maillogs'
MISSING=''
while read -r vol; do
    [ -n "$vol" ] || continue
    printf '%s' "$SKIP_VOLUMES" | grep -qw "$vol" && continue
    printf '%s' "$VOL_NAMES" | grep -qw "$vol" && continue
    MISSING="$MISSING $vol"
done < <(sed -n '/^volumes:/,$p' "$INFRA_DIR/docker-compose.yml" |
         sed -n 's/^  \([a-z0-9-]*\):[[:space:]]*$/\1/p')
t_eq "все тома данных из docker-compose.yml попадают в копию" "${MISSING# }" ""

# Полное удаление тоже держало СВОЙ перечень томов, и он отстал: в нём не
# было ни очереди Postfix, ни логотипа страниц входа, ни журналов. То есть
# «удалено полностью» оставляло на машине данные, про которые человеку
# сказали, что их больше нет.
t_no "uninstall.sh не держит свой перечень томов в коде" \
    bash -c "grep -qE 'for vol in +[a-z]' '$INSTALL_DIR/uninstall.sh'"
t_ok "uninstall.sh берёт список томов из docker-compose.yml" \
    bash -c "grep -q 'COMPOSE_VOLUMES' '$INSTALL_DIR/uninstall.sh'"

# ==================================================================
step "5. Развязка infra/.env и тома базы при восстановлении"
# ==================================================================
# Postgres принимает POSTGRES_PASSWORD только при создании пустого тома.
# Восстановление .env из копии поверх уже созданного тома ломало доступ.
BOUND_KEYS=" ${MT_VOLUME_BOUND_ENV_KEYS[*]} "
for key in POSTGRES_PASSWORD POSTGRES_USER POSTGRES_DB; do
    t_eq "$key объявлен привязанным к тому" \
         "$(case "$BOUND_KEYS" in *" $key "*) echo yes ;; *) echo no ;; esac)" "yes"
done
t_eq "ключи шифрования НЕ считаются привязанными к тому (их берём из копии)" \
     "$(case "$BOUND_KEYS" in *' AI_ENCRYPTION_KEY '*) echo yes ;; *) echo no ;; esac)" "no"

# Проверяем сам механизм подмены на временном файле .env
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
cat > "$TMPD/current.env" <<'EOF'
POSTGRES_USER=mailserver
POSTGRES_PASSWORD=new-volume-password
POSTGRES_DB=mailserver
AI_ENCRYPTION_KEY=new-key-must-be-replaced
EOF
cat > "$TMPD/backup.env" <<'EOF'
POSTGRES_USER=mailserver
POSTGRES_PASSWORD=old-backup-password
POSTGRES_DB=mailserver
AI_ENCRYPTION_KEY=key-from-backup
EOF
ENV_FILE="$TMPD/current.env"
PRESERVED=()
for key in "${MT_VOLUME_BOUND_ENV_KEYS[@]}"; do
    v="$(env_get "$key")"
    [ -n "$v" ] && PRESERVED+=("$key=$v")
done
cp "$TMPD/backup.env" "$ENV_FILE"
for pair in "${PRESERVED[@]}"; do env_set "${pair%%=*}" "${pair#*=}"; done
t_eq "пароль базы остался от действующей установки" \
     "$(env_get POSTGRES_PASSWORD)" "new-volume-password"
t_eq "ключ шифрования восстановлен из копии" \
     "$(env_get AI_ENCRYPTION_KEY)" "key-from-backup"

# ==================================================================
step "6. Скрипты остаются синтаксически корректными"
# ==================================================================
for f in install.sh backup.sh restore.sh selfcheck.sh renew-certs.sh uninstall.sh lib/common.sh; do
    t_ok "bash -n install/$f" bash -n "$INSTALL_DIR/$f"
done
# Проверка занятости портов обязана СПРАШИВАТЬ, а не просто предупреждать
t_ok "занятые порты требуют подтверждения" \
    bash -c "grep -q 'освободите занятые порты' '$INSTALL_DIR/install.sh'"
# Восстановление обязано проверять доступ к базе по паролю (по TCP)
t_ok "восстановление проверяет доступ к базе по паролю" \
    bash -c "grep -q 'psql -h postgres' '$INSTALL_DIR/restore.sh'"
t_ok "восстановление завершается ошибкой при непройденных пунктах" \
    bash -c "grep -q 'ЗАВЕРШЕНО С ОШИБКАМИ' '$INSTALL_DIR/restore.sh'"
t_ok "восстановление применяет миграции поверх дампа" \
    bash -c "grep -q 'postgres/migrations' '$INSTALL_DIR/restore.sh'"
t_ok "самопроверка ловит пароль-заглушку администратора" \
    bash -c "grep -q 'заглушка из примера' '$INSTALL_DIR/selfcheck.sh'"

# ==================================================================
step "7. Согласованность infra/.env.example, compose и установщика"
# ==================================================================
# Тут ломается тише всего: ключ есть в примере, человек его правит, а он
# никуда не подставляется — или наоборот, установщик пишет ключ, которого
# в примере нет, и о нём неоткуда узнать. Ни одна живая проверка этого не
# ловит: стек поднимается, почта ходит, настройка просто не действует.

# --- Концы строк ----------------------------------------------------
# infra/.env.example один раз уже уехал с CRLF. Установщик копирует его в
# infra/.env, docker compose «\r» отбрасывает (контейнеры работают), а bash
# сохраняет: POSTGRES_USER в скриптах становится «mailserver» с невидимым
# хвостом, и psql отвечает «role does not exist» на КАЖДУЮ миграцию при
# исправной базе. Установка с нуля разваливалась целиком, не сказав ни слова.
t_no "в infra/.env.example нет концов строк Windows (CRLF)" \
    grep -q $'\r' "$ENV_EXAMPLE"

# И то же самое функционально: load_env обязан пережить CRLF-файл.
CRLF_ENV="$(mktemp)"
printf 'POSTGRES_USER=mailserver\r\nMAIL_DOMAIN=example.test\r\n' > "$CRLF_ENV"
( ENV_FILE="$CRLF_ENV"; load_env
  [ "${#POSTGRES_USER}" = "10" ] ) >/dev/null 2>&1
t_eq "load_env вычищает \\r из значений (иначе psql не найдёт роль)" \
     "$( ENV_FILE="$CRLF_ENV"; load_env >/dev/null 2>&1; printf '%s' "${#POSTGRES_USER}" )" "10"
rm -f "$CRLF_ENV"

# --- Пустые значения в примере --------------------------------------
# Пустое значение в примере — это «работает по умолчанию» ТОЛЬКО если
# установщик его заполняет. Иначе установка с нуля молча выключает целый
# раздел: так было с QUEUE_AGENT_TOKEN — посредник к очереди Postfix не
# запускался вовсе, и раздел «Очередь» в панели отсутствовал на КАЖДОЙ
# новой установке, а узнать об этом было неоткуда.
#
# Ищем не любое упоминание ключа, а именно ЗАПИСЬ значения: env_set,
# env_ensure или строку вида "КЛЮЧ:<длина>" из списка генерируемых секретов.
# Первая версия проверки искала имя ключа где угодно в install.sh — и
# зеленела от собственного комментария, объясняющего, почему ключ важен.
EMPTY_UNSET=''
while read -r key; do
    [ -n "$key" ] || continue
    grep -qE "(env_set|env_ensure)[[:space:]]+${key}\b|\"${key}:[0-9]+\"" \
        "$INSTALL_DIR/install.sh" || EMPTY_UNSET="$EMPTY_UNSET $key"
done < <(sed -n 's/^\([A-Z_0-9]\{1,\}\)=[[:space:]]*$/\1/p' "$ENV_EXAMPLE")
t_eq "пустые ключи из .env.example заполняет установщик" "${EMPTY_UNSET# }" ""

# --- Ключи примера доходят до контейнеров ---------------------------
# Ключ, который не подставляется ни в один compose-файл, не настраивает
# ничего. Так молчали MAIL_FLOW_RETENTION_DAYS и MAIL_FLOW_MAX_ROWS: код их
# читает, в примере они есть, правка в .env не делала ровно ничего, а
# таблица истории доставки продолжала расти по прежним срокам.
DEAD_KEYS=''
while read -r key; do
    [ -n "$key" ] || continue
    grep -qE "\\\$\{${key}[:}]" "$COMPOSE_FILE" "$COMPOSE_PROD" || DEAD_KEYS="$DEAD_KEYS $key"
done < <(grep -oE '^[A-Z_0-9]+=' "$ENV_EXAMPLE" | tr -d '=')
t_eq "каждый ключ .env.example подставляется хотя бы в один compose-файл" "${DEAD_KEYS# }" ""

# --- Всё, что пишет установщик, описано в примере --------------------
# Иначе ключ существует, но найти его можно только чтением install.sh.
UNDOCUMENTED=''
while read -r key; do
    [ -n "$key" ] || continue
    grep -q "^${key}=" "$ENV_EXAMPLE" || UNDOCUMENTED="$UNDOCUMENTED $key"
done < <(grep -oE '(env_set|env_ensure) +[A-Z_0-9]+' "$INSTALL_DIR/install.sh" | awk '{print $2}' | sort -u)
t_eq "ключи, которые пишет install.sh, описаны в .env.example" "${UNDOCUMENTED# }" ""

# ==================================================================
step "8. Порядок и громкость установки/обновления"
# ==================================================================
# Схема базы должна лечь ДО того, как поднимется новый код. Иначе при
# обновлении новый сервер приложения до четверти часа работает против
# старой схемы, и его планировщики (отложенная отправка, отложенные письма,
# контакты, показатели) теряют каждый тик, обращаясь к несуществующим
# таблицам.
MIG_LINE="$(grep -n 'postgres/migrations/\*\.sql' "$INSTALL_DIR/install.sh" | head -1 | cut -d: -f1)"
BUILD_LINE="$(grep -n 'dc up -d --build' "$INSTALL_DIR/install.sh" | head -1 | cut -d: -f1)"
t_eq "миграции применяются раньше сборки образов" \
     "$([ -n "$MIG_LINE" ] && [ -n "$BUILD_LINE" ] && [ "$MIG_LINE" -lt "$BUILD_LINE" ] && echo yes || echo no)" "yes"

# Непринятая миграция — это отсутствующая таблица. Раньше установщик
# печатал предупреждение и заканчивался словами «Установка завершена»
# с кодом 0, то есть сообщал об успехе установки с неполной схемой.
t_ok "install.sh отказывается продолжать при непринятой миграции" \
    bash -c "grep -q 'база не соответствует версии продукта' '$INSTALL_DIR/install.sh'"
# Причина отказа psql раньше уходила в /dev/null — оставалось гадать.
t_no "install.sh не выбрасывает вывод ошибки миграции в /dev/null" \
    bash -c "grep -A2 'postgres/migrations/\*\.sql' '$INSTALL_DIR/install.sh' | grep -q '2>&1'"

# --- Подсеть стека и адреса внутри неё --------------------------------
# Подсеть меняют, когда 172.28.0.0/16 занята на машине чем-то ещё. Но
# фиксированных адресов в ней два (свой резольвер и Dovecot, которому Postfix
# отдаёт почту по адресу), и задаются они отдельными ключами. Поменяв одну
# подсеть, человек получал отказ docker «no configured subnet contains IP
# address 172.28.0.54» — без имени файла и без имени настройки, и стек не
# поднимался вовсе. Проверено живьём: именно так стек и падал.
t_ok "адрес из своей подсети принимается"     subnet_contains 172.28.0.0/16 172.28.0.54
t_ok "другой адрес той же подсети принимается" subnet_contains 172.29.0.0/16 172.29.0.53
t_no "адрес из чужой подсети отвергается"      subnet_contains 172.29.0.0/16 172.28.0.54
t_no "пустая подсеть отвергается"              subnet_contains '' 172.28.0.54
t_ok "установщик отказывается при несогласованных подсети и адресах" \
    bash -c "grep -q 'меняются только вместе' '$INSTALL_DIR/install.sh'"
# DOVECOT_IP молчал в примере: два ключа из трёх были описаны, третий — нет.
t_ok "DOVECOT_IP описан в infra/.env.example" \
    bash -c "grep -q '^DOVECOT_IP=' '$ENV_EXAMPLE'"

# --- Сборка не должна зависеть от файлов, которых нет в репозитории ---
# install.sh поднимает стек через `docker compose up -d --build`, то есть
# собирает образы из того, что лежит рядом. У РАЗРАБОТЧИКА рядом лежит всё,
# включая файлы, скрытые от git, — и сборка идёт. У покупателя, который
# сделал git clone, такого файла нет, и сборка падает на COPY ещё до того,
# как что-либо поднимется. Именно так и было: apps/web/Dockerfile и
# apps/admin/Dockerfile копируют research/mailru/design-tokens-raw.json, а
# .gitignore прятал research/mailru/*.json целиком. Установка из чистой
# копии кода была невозможна в принципе, и ни одна проверка этого не видела,
# потому что все они запускались там, где файл есть.
#
# git тут только СПРАШИВАЮТ (check-ignore) — состояние репозитория не
# меняется. Нет git — проверку честно пропускаем, а не делаем вид.
if have git && git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    HIDDEN_INPUTS=''
    while read -r src; do
        [ -n "$src" ] || continue
        [ -e "$REPO_DIR/$src" ] || continue
        if git -C "$REPO_DIR" check-ignore -q "$src" 2>/dev/null; then
            HIDDEN_INPUTS="$HIDDEN_INPUTS $src"
        fi
    done < <(grep -h '^COPY ' "$REPO_DIR"/apps/*/Dockerfile 2>/dev/null |
             grep -v -- '--from=' |
             awk '{ for (i = 2; i < NF; i++) print $i }' | sort -u)
    t_eq "сборка образов не зависит от файлов, скрытых от репозитория" \
         "${HIDDEN_INPUTS# }" ""
else
    info "git недоступен — проверка входов сборки пропущена"
fi

# ==================================================================
step "9. Самопроверка знает про новое"
# ==================================================================
# Место на диске: письма и база лежат в томах docker, а не рядом с
# репозиторием. На сервере это сплошь и рядом РАЗНЫЕ разделы, и кончается
# первым тот, что с письмами. Проверка смотрела не туда и показывала
# «свободно 200 ГБ», пока почта уже переставала приниматься.
t_ok "selfcheck проверяет место там, где docker держит тома" \
    bash -c "grep -q 'DockerRootDir' '$INSTALL_DIR/selfcheck.sh'"
# Непринятая миграция ничего не ломает громко: стек поднимается, почта
# идёт, молча отваливается только новое. Сверяем схему с каталогом миграций.
t_ok "selfcheck сверяет схему базы с каталогом миграций" \
    bash -c "grep -q 'CREATE TABLE IF NOT EXISTS' '$INSTALL_DIR/selfcheck.sh'"
t_ok "selfcheck проверяет посредника к очереди Postfix" \
    bash -c "grep -q 'X-Agent-Token' '$INSTALL_DIR/selfcheck.sh'"
# Служебный пользователь Dovecot появился позже установки: на серверах,
# обновлённых с ранних версий, его в infra/.env нет, файл служебных
# пользователей остаётся пустым, и панель отвечает «неверный пароль» на
# верный пароль администратора. Проверяем настоящим входом, а не наличием
# ключа: файл может существовать и быть пустым.
t_ok "selfcheck проверяет служебный вход Dovecot настоящей аутентификацией" \
    bash -c "grep -q 'doveadm auth test' '$INSTALL_DIR/selfcheck.sh'"
t_ok "selfcheck предупреждает про CRLF в infra/.env" \
    bash -c "grep -q 'CRLF' '$INSTALL_DIR/selfcheck.sh'"
# Восстановление тоже должно называть причину, а не только файл
t_ok "restore.sh печатает ошибку psql при непринятой миграции" \
    bash -c "grep -q 'mig.err' '$INSTALL_DIR/restore.sh'"

# ==================================================================
step "Итог"
# ==================================================================
printf '  пройдено: %d   не пройдено: %d\n\n' "$T_PASS" "$T_FAIL"
[ "$T_FAIL" -eq 0 ] || exit 1
exit 0
