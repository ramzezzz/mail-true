# Rspamd: антиспам + DKIM. Обёртка-entrypoint генерирует DKIM-ключ и
# секретные конфиги (пароли redis/контроллера, адрес резольвера) в override.d.
# Версия закреплена намеренно. Штатное обновление продукта делает
# `docker compose up -d --build`, то есть с плавающим `latest` версия
# milter-а и подписывальщика DKIM могла смениться на мажорную сама, между
# двумя обновлениями и без единой строчки в журнале. Продукт на этом уже
# обжигался: в rspamd 4.1 перестали разворачиваться `{= env.X =}` в
# конфигурациях — антивирус после такого обновления нельзя было включить
# вообще (разбор — в local.d/antivirus.conf). Тег 4.1 — ветка, а не
# отдельная сборка: исправления внутри неё приезжают, смена мажорной — нет.
FROM rspamd/rspamd:4.1

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
