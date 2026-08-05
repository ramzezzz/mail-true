#!/bin/sh
# Генерируем конфигурацию Postfix из шаблонов (/etc/postfix-repo, монтируется из
# infra/postfix/conf) с подстановкой переменных из .env, затем запускаем postfix
# в foreground. После правки конфигов на хосте: docker compose restart postfix
set -e

: "${MAIL_DOMAIN:=mail.local}"
: "${MAIL_HOSTNAME:=mail.local}"
# Постоянный адрес Dovecot: он попадает в mynetworks, чтобы правила
# «переслать» и «автоответчик» могли отправлять почту наружу.
: "${DOVECOT_IP:=172.28.0.54}"
export MAIL_DOMAIN MAIL_HOSTNAME POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DOVECOT_IP

VARS='${MAIL_DOMAIN} ${MAIL_HOSTNAME} ${POSTGRES_DB} ${POSTGRES_USER} ${POSTGRES_PASSWORD} ${DOVECOT_IP}'

envsubst "$VARS" < /etc/postfix-repo/main.cf.template > /etc/postfix/main.cf
cp /etc/postfix-repo/master.cf /etc/postfix/master.cf

mkdir -p /etc/postfix/pgsql
for tpl in /etc/postfix-repo/pgsql/*.template; do
    out="/etc/postfix/pgsql/$(basename "$tpl" .template)"
    envsubst "$VARS" < "$tpl" > "$out"
done
# В pgsql-конфигах пароль БД — прячем от посторонних
chgrp -R postfix /etc/postfix/pgsql
chmod 750 /etc/postfix/pgsql
chmod 640 /etc/postfix/pgsql/*.cf

# Таблица aliases нужна postfix даже если не используется
touch /etc/aliases
newaliases

exec /usr/sbin/postfix start-fg
