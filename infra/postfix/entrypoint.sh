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

# ------------------------------------------------------------------
# Журнал: файл в общем томе И stdout контейнера одновременно.
#
# Почему не что-то одно. Админке нужен ФАЙЛ: сокета Docker у сервера
# приложения нет, а «docker compose logs» без него недоступен. Людям и
# проверкам стенда нужен STDOUT: `docker compose logs postfix` — первое,
# куда смотрят, и на этот вывод опираются infra/test-*.sh.
#
# Postfix умеет писать только в одно место (maillog_file), поэтому пишем
# в файл, а в stdout его переливает tail. Проворачивание файла делает
# посредник очереди командой `postfix logrotate`; tail -F следит за ИМЕНЕМ
# и после проворота сам открывает новый файл.
# ------------------------------------------------------------------
MAILLOG="${QUEUE_AGENT_MAILLOG:-/var/log/mail/postfix.log}"
mkdir -p "$(dirname "$MAILLOG")"
chmod 1777 "$(dirname "$MAILLOG")" 2>/dev/null || true
touch "$MAILLOG"
chown postfix "$MAILLOG" 2>/dev/null || true
chmod 644 "$MAILLOG"
tail -n 0 -F "$MAILLOG" &

# ------------------------------------------------------------------
# ПРОВОРОТ ЖУРНАЛА — БЕЗУСЛОВНЫЙ, КАК У DOVECOT
# ------------------------------------------------------------------
# Раньше он жил ВНУТРИ посредника очереди (rotate_maillog в
# queue-agent.pl), а посредник запускается только при заданном секрете.
# Секрет в infra/.env.example пустой, в compose умолчание тоже пустое —
# значит стек, поднятый документированным способом («cp .env.example .env
# && up -d»), оставался вовсе без проворота. Ровно тот исход, о котором
# предупреждает комментарий в самом посреднике: «файл рос бы без конца и
# однажды занял бы весь диск».
#
# Установленный по инструкции сервер это не задевало — install.sh секрет
# генерирует, — но связывать уборку диска с необязательной возможностью
# неправильно: у Dovecot проворот сделан отдельным циклом и ни от чего не
# зависит. Делаем так же.
#
# Права на новый файл ставятся тут же: после переименования Postfix заведёт
# журнал сам, от root и с маской 077, а читает его сервер приложения под
# другим пользователем (раздел «Журналы почты»).
MAILLOG_MAX_BYTES=${POSTFIX_LOG_MAX_BYTES:-33554432}
(
    while true; do
        sleep 60
        SIZE=$(stat -c %s "$MAILLOG" 2>/dev/null || echo 0)
        if [ "$SIZE" -gt "$MAILLOG_MAX_BYTES" ]; then
            mv -f "$MAILLOG" "$MAILLOG.1" 2>/dev/null || true
            touch "$MAILLOG" 2>/dev/null || true
            chown postfix "$MAILLOG" 2>/dev/null || true
            chmod 644 "$MAILLOG" 2>/dev/null || true
        fi
    done
) &

# Посредник к очереди для админки. Без секрета не запускается вовсе
# (см. queue-agent.pl) — то есть по умолчанию его просто нет.
if [ -n "${QUEUE_AGENT_TOKEN:-}" ]; then
    QUEUE_AGENT_MAILLOG="$MAILLOG"
    export QUEUE_AGENT_MAILLOG QUEUE_AGENT_TOKEN QUEUE_AGENT_PORT
    # Перезапуск в цикле: посредник не должен уносить с собой почтовый
    # сервер, но и молча исчезать навсегда тоже не должен.
    sh -c 'while true; do /usr/local/bin/queue-agent.pl; sleep 5; done' &
fi

# ------------------------------------------------------------------
# Слежение за файлом сертификата.
#
# Сертификат меняют трижды за жизнь сервера: при установке, при продлении
# Let's Encrypt и когда приносят свой (раздел «Сертификат» в панели).
# Postfix читает его при старте процесса и сам об изменении не узнаёт —
# до сих пор это лечили командой `docker compose restart postfix` с хоста.
#
# Из панели такой команды не отдать: сокета Docker у сервера приложения
# нет и не будет — он равен правам root на всей машине, и платить эту цену
# за перечитывание файла нельзя. Поэтому Postfix следит за файлом сам.
#
# `postfix reload` заставляет master перезапустить своих демонов: новые
# соединения обслуживает уже свежий smtpd с новым сертификатом. Приём
# почты при этом не прерывается — идущие сеансы дорабатывают до конца.
# ------------------------------------------------------------------
CERT_WATCH_INTERVAL="${CERT_WATCH_INTERVAL:-10}"
if [ "$CERT_WATCH_INTERVAL" -gt 0 ] 2>/dev/null; then
    (
        prev=''
        while true; do
            now=$(cat /certs/mail.crt /certs/mail.key 2>/dev/null | md5sum)
            if [ -n "$prev" ] && [ "$now" != "$prev" ]; then
                echo "Сертификат изменился — перечитываем (postfix reload)"
                postfix reload >/dev/null 2>&1 || true
            fi
            prev="$now"
            sleep "$CERT_WATCH_INTERVAL"
        done
    ) &
fi

exec /usr/sbin/postfix start-fg
