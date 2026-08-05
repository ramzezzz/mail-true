#!/usr/bin/env bash
# Генерация самоподписанного TLS-сертификата для локальной разработки.
# Результат: infra/data/certs/mail.crt + mail.key (каталог в .gitignore).
# Использует openssl хоста (есть в Git Bash), при отсутствии — docker.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$INFRA_DIR/data/certs"

# Домен из .env (или значение по умолчанию)
DOMAIN="mail.local"
if [ -f "$INFRA_DIR/.env" ]; then
    v=$(grep -E '^MAIL_DOMAIN=' "$INFRA_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '\r' || true)
    [ -n "${v:-}" ] && DOMAIN="$v"
fi

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/mail.crt" ] && [ -f "$CERT_DIR/mail.key" ] && [ "${1:-}" != "--force" ]; then
    echo "Сертификаты уже существуют: $CERT_DIR (перегенерация: gen-certs.sh --force)"
    exit 0
fi

gen() {
    # cd + относительные имена: нативному openssl не нужны MSYS-пути,
    # а MSYS_NO_PATHCONV не даёт Git Bash искажать "/CN=..."
    (cd "$CERT_DIR" && MSYS_NO_PATHCONV=1 "$1" req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout mail.key -out mail.crt \
        -subj "/CN=$DOMAIN/O=Mail.True Dev" \
        -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN,DNS:localhost,IP:127.0.0.1")
}

if command -v openssl >/dev/null 2>&1; then
    gen openssl
else
    MSYS_NO_PATHCONV=1 docker run --rm -v "$CERT_DIR:/work" -w /work alpine/openssl \
        req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout mail.key -out mail.crt \
        -subj "/CN=$DOMAIN/O=Mail.True Dev" \
        -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN,DNS:localhost,IP:127.0.0.1"
fi

echo "Готово: $CERT_DIR/mail.crt, $CERT_DIR/mail.key (CN=$DOMAIN, срок 10 лет)"
