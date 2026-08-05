#!/bin/sh
# 1) Генерируем DKIM-ключ домена (если ещё нет) в /var/lib/rspamd/dkim
#    (named volume; рядом кладётся .dns.txt с TXT-записью для DNS).
# 2) Пишем конфиги с секретами в override.d (не попадают в репозиторий).
# 3) Запускаем rspamd в foreground от пользователя _rspamd.
set -e

: "${MAIL_DOMAIN:=mail.local}"
: "${DKIM_SELECTOR:=mail}"

DKIM_DIR=/var/lib/rspamd/dkim
KEY="$DKIM_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.key"

mkdir -p "$DKIM_DIR"
if [ ! -f "$KEY" ]; then
    rspamadm dkim_keygen -d "$MAIL_DOMAIN" -s "$DKIM_SELECTOR" -b 2048 -k "$KEY" \
        > "$DKIM_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.dns.txt"
    echo "DKIM: сгенерирован ключ $KEY (DNS-запись: $DKIM_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.dns.txt)"
fi
chown -R _rspamd:_rspamd /var/lib/rspamd
chmod 600 "$KEY"
# Готовые DNS-записи (*.dns.txt) — публичные данные: их читает сервис
# autoconfig из этого же тома (смонтирован read-only). Приватный ключ — 600.
chmod 711 /var/lib/rspamd
chmod 755 "$DKIM_DIR"
chmod 644 "$DKIM_DIR"/*.dns.txt 2>/dev/null || true

# Redis (статистика, bayes, greylisting и т.п.)
cat > /etc/rspamd/override.d/redis.conf <<EOF
servers = "redis:6379";
password = "${REDIS_PASSWORD}";
EOF

# Пароль веб-интерфейса/API контроллера
cat > /etc/rspamd/override.d/worker-controller.inc <<EOF
password = "${RSPAMD_PASSWORD}";
enable_password = "${RSPAMD_PASSWORD}";
EOF

# DKIM: селектор и путь к ключам из окружения
cat > /etc/rspamd/override.d/dkim_signing.conf <<EOF
enabled = true;
selector = "${DKIM_SELECTOR}";
path = "/var/lib/rspamd/dkim/\$domain.\$selector.key";
allow_username_mismatch = true;
use_domain = "header";
sign_authenticated = true;
sign_local = true;
try_fallback = true;
EOF

# ------------------------------------------------------------------
# Свой рекурсивный DNS-резольвер
# ------------------------------------------------------------------
# Встроенный DNS-клиент rspamd по умолчанию читает /etc/resolv.conf, где
# стоит внутренний резольвер Docker, а тот пересылает запросы наружу. Списки
# Spamhaus/URIBL такие запросы отклоняют (127.255.255.254, «open resolver»),
# и проверки молча перестают работать. Поэтому адрес резольвера задаём явно.
# Имена контейнеров (redis, clamav) unbound отдаёт через stub-зоны — см.
# infra/unbound/unbound.conf.
if [ -n "${RESOLVER_IP}" ]; then
    cat > /etc/rspamd/override.d/options.inc <<EOF
dns {
    nameserver = ["${RESOLVER_IP}"];
}
EOF
    echo "DNS: rspamd резолвит через ${RESOLVER_IP} (unbound)"
fi

# ------------------------------------------------------------------
# Антивирус: включается только явно (CLAMAV_ENABLED=true)
# ------------------------------------------------------------------
# Правило целиком описано в local.d/antivirus.conf; значение enabled туда
# подставляется из переменной окружения CLAMAV_ENABLED. Здесь — только
# сообщение в лог, чтобы состояние было видно при старте.
# Через override.d это делать нельзя: override.d заменяет секцию целиком,
# и правило теряет адрес сервера.
if [ "${CLAMAV_ENABLED}" = "true" ]; then
    echo "Антивирус: ClamAV ВКЛЮЧЁН (нужен профиль docker compose --profile clamav)"
else
    echo "Антивирус: выключен (CLAMAV_ENABLED=${CLAMAV_ENABLED:-false})"
fi
# Подчищаем возможный остаток от прежних версий образа
rm -f /etc/rspamd/override.d/antivirus.conf

# ------------------------------------------------------------------
# Карты (белые/чёрные списки) — каталог примонтирован на запись
# ------------------------------------------------------------------
MAPS_DIR=/etc/rspamd/maps.d
if [ -d "$MAPS_DIR" ]; then
    # Основной домен должен быть в списке своих
    if [ -f "$MAPS_DIR/local_domains.map" ] \
       && ! grep -qx "$MAIL_DOMAIN" "$MAPS_DIR/local_domains.map" 2>/dev/null; then
        echo "$MAIL_DOMAIN" >> "$MAPS_DIR/local_domains.map"
        echo "Карты: в local_domains.map добавлен $MAIL_DOMAIN"
    fi
    # Карты читает процесс rspamd, писать в них будет админка
    chmod 644 "$MAPS_DIR"/*.map 2>/dev/null || true
fi

exec /usr/bin/rspamd -f -u _rspamd -g _rspamd
