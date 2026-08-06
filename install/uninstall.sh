#!/usr/bin/env bash
# ------------------------------------------------------------------
# Снятие Mail.True.
#
#   sudo bash install/uninstall.sh            # остановить, данные сохранить
#   sudo bash install/uninstall.sh --purge    # удалить ВСЁ, включая письма
#   sudo bash install/uninstall.sh --purge --yes   # без вопросов
#
# По умолчанию скрипт только останавливает и удаляет контейнеры.
# Письма, база, ключи DKIM и настройки остаются на месте: повторный
# install.sh поднимет сервер ровно в том состоянии, в каком он был.
#
# --purge удаляет тома с письмами и базой безвозвратно. Перед этим
# скрипт предлагает сделать резервную копию и требует подтверждения
# фразой, чтобы это нельзя было сделать случайно.
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

PURGE=0
KEEP_IMAGES=0
while [ $# -gt 0 ]; do
    case "$1" in
        --purge)       PURGE=1; shift ;;
        --keep-images) KEEP_IMAGES=1; shift ;;
        --yes|-y)      MT_ASSUME_YES=1; shift ;;
        --help|-h)     sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "неизвестный ключ: $1" ;;
    esac
done
export MT_ASSUME_YES="${MT_ASSUME_YES:-0}"

if [ -f "$ENV_FILE" ]; then
    load_env
fi
PROJECT="${COMPOSE_PROJECT_NAME:-mailtrue}"

if [ "$PURGE" = "0" ]; then
    step "Снятие Mail.True (данные сохраняются)"
    info "будут удалены только контейнеры; письма, база и настройки останутся"
    if ! confirm "Продолжить?"; then die "отменено"; fi

    dc down --remove-orphans || warn "docker compose down завершился с ошибкой"
    ok "контейнеры остановлены и удалены"

    if have systemctl && [ -f /etc/systemd/system/mailtrue-certs.timer ]; then
        systemctl disable --now mailtrue-certs.timer >/dev/null 2>&1 || true
        ok "таймер продления сертификата выключен"
    fi

    cat <<EOF

  Данные на месте:
    тома docker    ${PROJECT}_vmail (письма), ${PROJECT}_pgdata (база),
                   ${PROJECT}_rspamd-data (ключи DKIM), ${PROJECT}_mailindex
    настройки      $ENV_FILE
    сертификаты    $CERT_DIR

  Поднять обратно:
    sudo bash install/install.sh

  Удалить всё безвозвратно:
    sudo bash install/uninstall.sh --purge

EOF
    exit 0
fi

# ------------------------------------------------------------------
# Полное удаление
# ------------------------------------------------------------------
step "ПОЛНОЕ удаление Mail.True"
printf '\n'
warn "будут БЕЗВОЗВРАТНО удалены:"
info "  • все письма всех пользователей (том ${PROJECT}_vmail)"
info "  • база: домены, ящики, алиасы, администраторы, журналы"
info "  • ключи DKIM — после переустановки подпись будет другой"
info "  • настройки $ENV_FILE и TLS-сертификаты"
printf '\n'

if [ "${MT_ASSUME_YES:-0}" != "1" ]; then
    info "Сначала имеет смысл сделать копию: sudo bash install/backup.sh"
    printf '\n'
    read -r -p "  Введите слово УДАЛИТЬ, чтобы подтвердить: " answer
    if [ "$answer" != "УДАЛИТЬ" ] && [ "$answer" != "DELETE" ]; then
        die "не подтверждено — ничего не удалено"
    fi
fi

dc down --volumes --remove-orphans || warn "docker compose down завершился с ошибкой"
ok "контейнеры и тома удалены"

# Тома, которые могли остаться от прошлых запусков без переопределения.
#
# Список берём ИЗ docker-compose.yml, а не из перечня здесь. Перечень тут
# уже отстал от стека: в нём не было ни очереди Postfix (postfix-spool), ни
# логотипа страниц входа (api-branding), ни журналов (maillogs) — то есть
# «полное удаление» оставляло на машине данные, о которых человеку сказали,
# что их больше нет. Ровно на этом же расхождении списков однажды потеряли
# очередь в резервной копии.
COMPOSE_VOLUMES="$(sed -n '/^volumes:/,$p' "$COMPOSE_FILE" |
                   sed -n 's/^  \([a-z0-9-]*\):[[:space:]]*$/\1/p')"
for vol in $COMPOSE_VOLUMES; do
    if docker volume inspect "${PROJECT}_${vol}" >/dev/null 2>&1; then
        if docker volume rm "${PROJECT}_${vol}" >/dev/null 2>&1; then
            ok "том ${PROJECT}_${vol} удалён"
        else
            warn "том ${PROJECT}_${vol} удалить не вышло (кто-то его использует?)"
        fi
    fi
done

if [ "$KEEP_IMAGES" = "0" ]; then
    for img in mailtrue-postfix mailtrue-dovecot mailtrue-rspamd mailtrue-unbound mailtrue-autoconfig; do
        docker image rm "$img" >/dev/null 2>&1 || true
    done
    ok "собранные образы удалены (--keep-images оставляет их)"
fi

# Настройки и состояние
for f in "$ENV_FILE" "$STATE_FILE"; do
    if [ -f "$f" ]; then rm -f "$f"; ok "удалён $f"; fi
done
rm -f "$ENV_FILE".bak "$ENV_FILE".bak.* "$ENV_FILE".before-restore 2>/dev/null || true
if [ -d "$CERT_DIR" ]; then
    rm -rf "${CERT_DIR:?}"/mail.crt "${CERT_DIR:?}"/mail.key
    ok "TLS-сертификаты стека удалены"
fi
if [ -d "$STATE_DIR" ]; then
    rm -rf "${STATE_DIR:?}"
    ok "каталог состояния удалён"
fi

if have systemctl; then
    systemctl disable --now mailtrue-certs.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/mailtrue-certs.service /etc/systemd/system/mailtrue-certs.timer
    systemctl daemon-reload >/dev/null 2>&1 || true
    ok "таймер продления сертификата удалён"
fi

cat <<EOF

  Mail.True удалён.

  Что осталось нетронутым (убирайте вручную, если не нужно):
    • Docker и его образы базовых систем     apt-get purge docker-ce ...
    • сертификаты Let's Encrypt              /etc/letsencrypt
    • резервные копии                        /var/backups/mailtrue
    • сам каталог проекта                    $REPO_DIR

EOF
