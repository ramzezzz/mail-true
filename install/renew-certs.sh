#!/usr/bin/env bash
# ------------------------------------------------------------------
# Продление TLS-сертификата Let's Encrypt и раскладка его по стеку.
#
#   sudo bash install/renew-certs.sh              # обычное продление (по таймеру)
#   sudo bash install/renew-certs.sh --force      # выпустить заново, не глядя на срок
#   sudo bash install/renew-certs.sh --deploy-only  # только скопировать текущий
#
# Почему не штатный хук certbot: сертификат нужен внутри контейнеров, а они
# видят только каталог infra/data/certs. Поэтому после выпуска файлы
# копируются туда и сервисы перечитывают их (postfix/dovecot/nginx).
#
# Certbot работает в режиме standalone и слушает 80-й порт сам, поэтому
# nginx на время проверки останавливается. Почта в это время ходит:
# останавливается только веб-вход автонастройки, на минуту.
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MODE=renew
case "${1:-}" in
    --force)         MODE=force ;;
    --deploy-only)   MODE=deploy ;;
    --install-timer) MODE=timer ;;
    '')              MODE=renew ;;
    *) die "неизвестный ключ: ${1:-}" ;;
esac

# Включить автопродление и выйти. Нужно после установки из браузера:
# веб-установщик работает в контейнере, а systemd живёт на хосте —
# таймер оттуда завести нечем, и он честно просит выполнить это здесь.
if [ "$MODE" = "timer" ]; then
    step "Автопродление сертификата"
    if install_cert_timer "$SCRIPT_DIR"; then
        ok "таймер mailtrue-certs.timer включён (проверка дважды в сутки)"
        info "посмотреть: systemctl status mailtrue-certs.timer"
        exit 0
    fi
    if have systemctl; then
        die "не удалось включить таймер: systemctl enable mailtrue-certs.timer вернул ошибку"
    fi
    die "systemd на этой машине нет. Добавьте в cron:
       17 3 * * * /bin/bash $SCRIPT_DIR/renew-certs.sh"
fi

load_env
CERT_NAME=mailtrue
LE_DIR="/etc/letsencrypt/live/$CERT_NAME"

deploy() {
    [ -f "$LE_DIR/fullchain.pem" ] || die "нет сертификата $LE_DIR/fullchain.pem"
    mkdir -p "$CERT_DIR"
    # Именно копия, а не ссылка: контейнеры видят только каталог certs,
    # символическая ссылка наружу внутри контейнера никуда не ведёт.
    install -m 644 "$LE_DIR/fullchain.pem" "$CERT_DIR/mail.crt"
    install -m 600 "$LE_DIR/privkey.pem"   "$CERT_DIR/mail.key"
    # Отметка «откуда сертификат» — её читают панель и сам этот скрипт.
    printf 'letsencrypt\n' > "$CERT_DIR/source"
    chmod 644 "$CERT_DIR/source" 2>/dev/null || true
    ok "сертификат разложен в $CERT_DIR"
    # Postfix и Dovecot читают файл при старте процесса, nginx — по сигналу.
    dc restart postfix dovecot >/dev/null 2>&1 || warn "не удалось перезапустить postfix/dovecot"
    dc exec -T nginx nginx -s reload >/dev/null 2>&1 || dc restart nginx >/dev/null 2>&1 || true
    ok "сервисы перечитали сертификат"
}

if [ "$MODE" = "deploy" ]; then
    deploy
    exit 0
fi

# ------------------------------------------------------------------
# Свой сертификат продлением Let's Encrypt не перезаписывается.
#
# Этот скрипт запускает таймер systemd дважды в сутки. Если на сервере
# поставили свой сертификат (раздел «Сертификат» в панели или руками), то
# без этой проверки очередное продление тихо положило бы на его место
# сертификат Let's Encrypt — а узналось бы это по звонку «Outlook опять
# ругается на узел», через неделю и без единой записи о причине.
#
# Отметку ставит тот, кто ставил сертификат: файл source рядом с ним.
# Снимается она осознанно — переменной в командной строке, а не молча.
# ------------------------------------------------------------------
CERT_SOURCE="$(cat "$CERT_DIR/source" 2>/dev/null | tr -d '[:space:]')"
if [ "$CERT_SOURCE" = "custom" ] && [ "${MT_REPLACE_CUSTOM_CERT:-0}" != "1" ]; then
    CURRENT_CN="$(openssl x509 -in "$CERT_DIR/mail.crt" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p')"
    die "на этом сервере стоит СВОЙ сертификат (CN=${CURRENT_CN:-?}), а не Let's Encrypt.
       Продление заменило бы его — этого не делается молча.

       Если сертификат действительно пора менять, поставьте новый в панели:
         раздел «Сертификат» → «Поставить свой».

       Если вы хотите вернуться к Let's Encrypt и перезаписать свой сертификат:
         MT_REPLACE_CUSTOM_CERT=1 sudo bash $0 ${1:-}"
fi

have certbot || die "certbot не установлен: apt-get install -y certbot"

cert_enddate() {
    if [ -f "$LE_DIR/cert.pem" ]; then
        openssl x509 -in "$LE_DIR/cert.pem" -noout -enddate 2>/dev/null || true
    fi
}
BEFORE="$(cert_enddate)"

step "Продление сертификата"
info "останавливаем nginx на время проверки Let's Encrypt"
dc stop nginx >/dev/null 2>&1 || true

RC=0
if [ "$MODE" = "force" ]; then
    certbot renew --cert-name "$CERT_NAME" --standalone --force-renewal --non-interactive || RC=$?
else
    certbot renew --cert-name "$CERT_NAME" --standalone --non-interactive || RC=$?
fi

dc start nginx >/dev/null 2>&1 || true

if [ "$RC" -ne 0 ]; then
    fail "certbot вернул код $RC"
    hint "подробности: /var/log/letsencrypt/letsencrypt.log"
    exit "$RC"
fi

AFTER="$(cert_enddate)"

if [ "$BEFORE" = "$AFTER" ] && [ "$MODE" != "force" ]; then
    ok "сертификат ещё свежий, продление не требовалось ($AFTER)"
    # Всё равно раскладываем: файлы в стеке могли отстать от /etc/letsencrypt
    deploy
else
    ok "сертификат продлён ($AFTER)"
    deploy
fi
