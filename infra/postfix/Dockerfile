# Postfix c поддержкой PostgreSQL. swaks и curl — для сквозных тестов доставки.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        postfix postfix-pgsql \
        gettext-base ca-certificates \
        swaks libnet-ssleay-perl libio-socket-ssl-perl curl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
# Посредник к очереди: показать/протолкнуть/удалить письмо по просьбе
# админки. Живёт здесь, потому что очередью управляют только программы
# Postfix, а давать серверу приложения сокет Docker ради этого нельзя.
COPY queue-agent.pl /usr/local/bin/queue-agent.pl
RUN chmod +x /entrypoint.sh /usr/local/bin/queue-agent.pl \
    # Общий том с журналами: сюда пишет postlogd, отсюда читает админка.
    # Права задаются В ОБРАЗЕ — docker переносит их на свежесозданный том,
    # иначе он появился бы как root:root и писать в него смогли бы не все.
    # Бит t (как у /tmp): каждый пишет свой файл и не может удалить чужой.
    && mkdir -p /var/log/mail && chmod 1777 /var/log/mail

EXPOSE 25 465 587
ENTRYPOINT ["/entrypoint.sh"]
