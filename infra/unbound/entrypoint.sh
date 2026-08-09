#!/bin/sh
# Запуск unbound в контейнере.
#  1) Готовим корневой якорь DNSSEC (по возможности — свежий, с фолбэком
#     на тот, что лежит в пакете).
# 2) Генерируем кусок конфига, зависящий от окружения (логирование запросов).
#  3) Стартуем unbound в foreground, права роняются до пользователя unbound.
set -e

ANCHOR=/var/lib/unbound/root.key
PACKAGED=/usr/share/dnssec-root/trusted-key.key

: "${UNBOUND_DNSSEC:=yes}"
: "${UNBOUND_LOG_QUERIES:=no}"
: "${UNBOUND_VERBOSITY:=1}"

# ------------------------------------------------------------------
# Приведение «да/нет» к тому виду, который понимает unbound
# ------------------------------------------------------------------
# Настройки сервера в панели хранят логические значения строками
# «true»/«false» и записывают их в infra/.env как есть. Здесь это стоило
# двух разных бед, и обе тихие:
#
#   * UNBOUND_DNSSEC=true не равно "yes" — ветка ниже уходила в else, и
#     проверка подписей МОЛЧА выключалась. Контейнер при этом здоров,
#     панель показывает «включено, применено», а на ответах DNS держатся
#     SPF, DKIM и DMARC;
#   * UNBOUND_LOG_QUERIES=true подставлялось прямо в `log-queries:` —
#     unbound принимает только yes/no и с «true» не стартует вовсе. Через
#     него ходят в DNS Postfix и rspamd, то есть включение отладочного
#     журнала одним переключателем останавливало резолвинг всего стека.
#
# Принимаем оба написания. Умолчания при этом разные и намеренно: DNSSEC
# по умолчанию включён (что не похоже на «нет» — то «да»), журнал
# запросов по умолчанию выключен (что не похоже на «да» — то «нет»).
case "$(printf '%s' "$UNBOUND_DNSSEC" | tr 'A-Z' 'a-z')" in
    no|false|0|off) UNBOUND_DNSSEC=no ;;
    *)              UNBOUND_DNSSEC=yes ;;
esac
case "$(printf '%s' "$UNBOUND_LOG_QUERIES" | tr 'A-Z' 'a-z')" in
    yes|true|1|on) UNBOUND_LOG_QUERIES=yes ;;
    *)             UNBOUND_LOG_QUERIES=no ;;
esac

mkdir -p /var/lib/unbound /etc/unbound/conf.d

if [ "$UNBOUND_DNSSEC" = "yes" ]; then
    # unbound-anchor сам скачает и проверит текущий корневой ключ ICANN.
    # Код возврата 1 = «якорь обновлён», это не ошибка.
    unbound-anchor -a "$ANCHOR" >/dev/null 2>&1 || true
    if [ ! -s "$ANCHOR" ] && [ -s "$PACKAGED" ]; then
        cp "$PACKAGED" "$ANCHOR"
        echo "unbound: корневой якорь взят из пакета ($PACKAGED)"
    fi
fi

if [ "$UNBOUND_DNSSEC" = "yes" ] && [ -s "$ANCHOR" ]; then
    echo "server:" > /etc/unbound/conf.d/10-dnssec.conf
    echo "    auto-trust-anchor-file: \"$ANCHOR\"" >> /etc/unbound/conf.d/10-dnssec.conf
    echo "unbound: DNSSEC-валидация включена"
else
    : > /etc/unbound/conf.d/10-dnssec.conf
    echo "unbound: DNSSEC-валидация ВЫКЛЮЧЕНА (UNBOUND_DNSSEC=$UNBOUND_DNSSEC)"
fi

# Логирование каждого запроса — нужно для отладки («уходит ли запрос к списку»).
# По умолчанию выключено: на боевом сервере это лишний объём логов.
cat > /etc/unbound/conf.d/20-logging.conf <<EOF
server:
    verbosity: ${UNBOUND_VERBOSITY}
    log-queries: ${UNBOUND_LOG_QUERIES}
EOF

chown -R unbound:unbound /var/lib/unbound

exec unbound -d -c /etc/unbound/unbound.conf
