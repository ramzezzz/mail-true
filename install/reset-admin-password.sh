#!/usr/bin/env bash
# ------------------------------------------------------------------
# Сброс пароля администратора панели — с сервера, без панели.
#
#   sudo bash install/reset-admin-password.sh                 # спросит логин и пароль
#   sudo bash install/reset-admin-password.sh admin           # спросит только пароль
#   sudo bash install/reset-admin-password.sh admin 'Пароль'  # без вопросов
#   sudo bash install/reset-admin-password.sh --list          # кто вообще заведён
#
# ЗАЧЕМ. Пароль от панели теряется — это обычное дело, а войти, чтобы его
# сменить, в этот момент нельзя по определению. Другого пути, кроме как
# зайти на сервер, не существует: почтой такое не восстанавливают (сброс
# по письму означал бы, что доступ к панели равен доступу к ящику), а
# заводить второго администратора «про запас» люди забывают.
#
# ЧТО ДЕЛАЕТ. Ровно то же, что и панель: считает от пароля тот же хеш
# (scrypt, см. apps/api/src/admin/passwords.ts) и кладёт его в
# admin_users. Заодно снимает блокировку и обнуляет счётчик неудачных
# попыток — иначе после десятка попыток вспомнить пароль человек сменил
# бы его и всё равно не вошёл ещё пятнадцать минут.
#
# ПОЧЕМУ ЧЕРЕЗ КОНТЕЙНЕР api. Хеш обязан считаться ровно так же, как его
# считает сервер приложения. Повторять эту арифметику в shell — верный
# способ однажды разойтись с ней и получить «пароль не подходит» при
# верном пароле. Поэтому работу делает та же программа, что и всегда:
# node dist/admin/cli.js set-password.
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MIN_LENGTH=8

usage() {
    cat <<'EOF'
Сброс пароля администратора панели управления

  sudo bash install/reset-admin-password.sh [логин] [пароль]
  sudo bash install/reset-admin-password.sh --list

Без аргументов спросит логин и пароль. Пароль вводится не отображаясь,
с повтором. Минимальная длина — 8 знаков.
EOF
    exit 0
}

LOGIN=''
PASSWORD=''
LIST_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --help|-h) usage ;;
        --list) LIST_ONLY=1 ;;
        *)
            if [ -z "$LOGIN" ]; then LOGIN="$arg"
            elif [ -z "$PASSWORD" ]; then PASSWORD="$arg"
            fi
            ;;
    esac
done

printf '%s\n' "$C_BOLD"
cat <<'EOF'
  Mail.True — сброс пароля администратора панели
EOF
printf '%s' "$C_OFF"

if [ "$(id -u)" -ne 0 ]; then
    die "запускать нужно от root: sudo bash install/reset-admin-password.sh"
fi

have docker || die "Docker не установлен — сбрасывать пароль нечем"

# Контейнер api должен работать: в нём и живёт программа, считающая хеш.
if ! dc ps --status running --services 2>/dev/null | grep -qx 'api'; then
    die "служба api не запущена, а пароль меняется именно ею.
       Поднимите стек и повторите:
         cd $REPO_DIR && docker compose -f infra/docker-compose.yml -f install/compose.prod.yml up -d"
fi

# cli.js работает в том же контейнере и с теми же переменными окружения,
# поэтому подключение к базе брать неоткуда — оно уже есть.
admin_cli() {
    # Путь абсолютный: рабочий каталог контейнера — /srv, а программа
    # лежит в /srv/apps/api/dist. Относительный путь молча ломался бы
    # «MODULE_NOT_FOUND» — сообщение, из которого не следует ничего.
    dc exec -T api node /srv/apps/api/dist/admin/cli.js "$@"
}

if [ "$LIST_ONLY" = "1" ]; then
    step "Администраторы панели"
    admin_cli list-admins
    exit 0
fi

# ------------------------------------------------------------------
step "1. Кому меняем пароль"
# ------------------------------------------------------------------
KNOWN="$(admin_cli list-admins 2>/dev/null || true)"
if [ -n "$KNOWN" ]; then
    printf '%s\n' "$KNOWN" | sed 's/^/     /'
fi

if [ -z "$LOGIN" ]; then
    read -r -p "  Логин администратора [admin]: " LOGIN
    LOGIN="${LOGIN:-admin}"
fi
info "выбран логин: $LOGIN"

# ------------------------------------------------------------------
step "2. Новый пароль"
# ------------------------------------------------------------------
if [ -z "$PASSWORD" ]; then
    # Ввод скрытый и с повтором: опечатку в пароле, который вводят вслепую,
    # иначе обнаружат только на странице входа.
    while true; do
        read -r -s -p "  Новый пароль (минимум $MIN_LENGTH знаков): " PASSWORD
        printf '\n'
        if [ "${#PASSWORD}" -lt "$MIN_LENGTH" ]; then
            warn "коротко: $((MIN_LENGTH - ${#PASSWORD})) знаков не хватает"
            continue
        fi
        read -r -s -p "  Повторите пароль: " REPEAT
        printf '\n'
        if [ "$PASSWORD" != "$REPEAT" ]; then
            warn "пароли не совпали — попробуйте ещё раз"
            continue
        fi
        break
    done
elif [ "${#PASSWORD}" -lt "$MIN_LENGTH" ]; then
    die "пароль короче $MIN_LENGTH знаков"
fi

# ------------------------------------------------------------------
step "3. Смена"
# ------------------------------------------------------------------
# Пароль уходит АРГУМЕНТОМ команды внутри контейнера, а не через оболочку
# хоста: в истории команд хоста он не остаётся, если скрипт запущен без
# пароля в строке запуска.
if admin_cli set-password "$LOGIN" "$PASSWORD" >/dev/null 2>&1; then
    ok "пароль администратора $LOGIN изменён"
    ok "счётчик неудачных попыток обнулён, блокировка снята"
else
    die "сменить пароль не удалось. Проверьте, что такой логин есть:
         sudo bash install/reset-admin-password.sh --list"
fi

DOMAIN="$(env_get MAIL_DOMAIN)"
cat <<EOF

  Вход в панель: https://admin.${DOMAIN:-<домен>}/
  Логин:         $LOGIN

  Если имя ещё не разошлось по DNS, панель открывается и по адресу
  сервера — резервным входом (ADMIN_LOCAL_PORT в infra/.env).

EOF
