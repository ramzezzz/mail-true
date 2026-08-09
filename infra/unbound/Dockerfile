# Unbound — собственный рекурсивный DNS-резольвер почтового стека.
#
# Зачем он нужен: бесплатные списки Spamhaus (zen/dbl) и URIBL отказываются
# отвечать на запросы, пришедшие через публичные резольверы (8.8.8.8, 1.1.1.1
# и вообще любой «чужой» резольвер). Вместо ответа они возвращают
# 127.255.255.254 («blocked, open resolver»), и проверки молча перестают
# работать. Поэтому стек резолвит DNS сам, от своего IP.
#
# Размер: alpine + unbound ≈ 25 МБ образа, ~20–30 МБ RSS при кэшах из
# unbound.conf. bind-tools (dig) добавлен намеренно — им пользуются
# infra/test-antispam.sh и ручная диагностика.
FROM alpine:3.20

RUN apk add --no-cache unbound bind-tools ca-certificates \
    && mkdir -p /var/lib/unbound /etc/unbound/conf.d \
    && chown -R unbound:unbound /var/lib/unbound

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 53/udp 53/tcp

# Проверка здоровья спрашивает САМ РЕЗОЛЬВЕР, а не интернет.
#
# Раньше здесь резолвилось внешнее имя (rspamd.com) — то есть полная
# рекурсия к чужим серверам с проверкой DNSSEC. Здоровье unbound при этом
# означало «интернет доступен», а не «служба работает», и цена ошибки была
# несоразмерной: rspamd ждёт unbound здоровым (service_healthy), а postfix
# ждёт rspamd. Отфильтрованный исходящий UDP/53, недоступность чужого
# имени или устаревший корневой ключ DNSSEC — и unbound уходит в
# unhealthy, `docker compose up -d` прерывается словами «dependency failed
# to start», postfix не стартует вовсе. Почта не принимается совсем,
# причём `restart: unless-stopped` тут не помогает: нездоровый контейнер
# не перезапускают.
#
# `unbound-control status` ходит на 127.0.0.1:8953 (control-enable в
# unbound.conf) и отвечает, пока жив сам демон. Запасной вариант — запрос
# `localhost`, он обслуживается встроенной локальной зоной и наружу тоже
# не выходит.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=10s \
    CMD unbound-control -c /etc/unbound/unbound.conf status > /dev/null 2>&1 \
        || dig +time=2 +tries=1 @127.0.0.1 -p 53 localhost A > /dev/null \
        || exit 1

ENTRYPOINT ["/entrypoint.sh"]
