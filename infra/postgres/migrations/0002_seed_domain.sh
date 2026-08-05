#!/bin/sh
# Сидируем основной домен из переменной окружения MAIL_DOMAIN (по умолчанию mail.local).
set -e
: "${MAIL_DOMAIN:=mail.local}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOF
INSERT INTO virtual_domains (name) VALUES ('${MAIL_DOMAIN}')
ON CONFLICT (name) DO NOTHING;
EOF
