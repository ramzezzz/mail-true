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
step "Итог"
# ==================================================================
printf '  пройдено: %d   не пройдено: %d\n\n' "$T_PASS" "$T_FAIL"
[ "$T_FAIL" -eq 0 ] || exit 1
exit 0
