# Postfix c поддержкой PostgreSQL. swaks и curl — для сквозных тестов доставки.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        postfix postfix-pgsql \
        gettext-base ca-certificates \
        swaks libnet-ssleay-perl libio-socket-ssl-perl curl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 25 465 587
ENTRYPOINT ["/entrypoint.sh"]
