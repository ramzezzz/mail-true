# Rspamd: антиспам + DKIM. Обёртка-entrypoint генерирует DKIM-ключ и
# секретные конфиги (пароли redis/контроллера, адрес резольвера) в override.d.
FROM rspamd/rspamd:latest

USER root

# dnsutils — dig внутри контейнера: им проверяется, что rspamd действительно
# ходит к спискам через свой резольвер (infra/test-antispam.sh).
# curl — обращения к HTTP-API контроллера из тестов и скриптов.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dnsutils curl \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 11332 11334
ENTRYPOINT ["/entrypoint.sh"]
