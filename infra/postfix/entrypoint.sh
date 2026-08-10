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
# Предел размера письма приходит из настроек сервера (панель правит
# MESSAGE_MAX_BYTES). Раньше в main.cf.template стояло число, и поднятый в
# панели предел приводил к 552 от нашего же Postfix: интерфейс письмо
# принимал, а отправить его было нельзя.
: "${MESSAGE_MAX_BYTES:=26214400}"
export MAIL_DOMAIN MAIL_HOSTNAME POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DOVECOT_IP
export MESSAGE_MAX_BYTES

VARS='${MAIL_DOMAIN} ${MAIL_HOSTNAME} ${POSTGRES_DB} ${POSTGRES_USER} ${POSTGRES_PASSWORD} ${DOVECOT_IP} ${MESSAGE_MAX_BYTES}'

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
#
# ПРОВОРАЧИВАЕТ `postfix logrotate`, А НЕ `mv`
# ------------------------------------------------------------------
# Переименовать файл самому НЕДОСТАТОЧНО, и это не тонкость, а поломка.
# Журнал пишет postlogd, он держит файл открытым по дескриптору: после
# `mv` запись продолжается в переименованный `postfix.log.1`, а новый
# `postfix.log` остаётся пустым НАВСЕГДА. Дальше состояние необратимо —
# оба цикла проворота смотрят на размер `postfix.log`, а он нулевой.
#
# Что при этом ломается, всё сразу:
#   * диск — `postfix.log.1` растёт без предела, ровно то, ради чего
#     проворот и заводили;
#   * панель — «Журналы почты», «Почтовый поток» и история входов и
#     отправки владельца ящика читают `postfix.log` и навсегда пустеют
#     на исправном сервере;
#   * защита от подбора — камера fail2ban `mailtrue-postfix-sasl` читает
#     тот же файл: подбор паролей перестаёт баниться молча, при зелёном
#     `fail2ban-client status`;
#   * `docker compose logs postfix` — `tail -F` следит за именем и
#     переоткрывает новый пустой файл.
#
# `postfix logrotate` переименовывает файл И заставляет postlogd открыть
# новый — это и написано в посреднике очереди (queue-agent.pl,
# rotate_maillog), но его порог выше нашего, поэтому первым всегда
# срабатывал этот цикл, и правильный проворот не вызывался уже никогда.
# У Dovecot та же схема сделана верно (`doveadm log reopen`), у fail2ban
# тоже (`fail2ban-client flushlogs`) — пропущен был именно Postfix.
#
# Права на новый файл ставятся тут же: после проворота Postfix заводит
# журнал сам, от root и с маской 077, а читает его сервер приложения под
# другим пользователем (раздел «Журналы почты»).
MAILLOG_MAX_BYTES=${POSTFIX_LOG_MAX_BYTES:-33554432}
# Сколько провёрнутых кусков держим. Накопление кусков съедает диск так
# же, как один растущий файл, поэтому уборка — часть проворота.
MAILLOG_KEEP=${POSTFIX_LOG_KEEP:-3}
(
    while true; do
        sleep 60
        SIZE=$(stat -c %s "$MAILLOG" 2>/dev/null || echo 0)
        if [ "$SIZE" -gt "$MAILLOG_MAX_BYTES" ]; then
            if postfix logrotate >/dev/null 2>&1; then
                touch "$MAILLOG" 2>/dev/null || true
                chown postfix "$MAILLOG" 2>/dev/null || true
                chmod 644 "$MAILLOG" 2>/dev/null || true
                # Лишние куски: оставляем свежие, остальные убираем.
                ls -1t "$MAILLOG".* 2>/dev/null | tail -n +"$((MAILLOG_KEEP + 1))" |
                    while read -r OLD; do rm -f "$OLD"; done
            else
                # Провернуть не вышло (Postfix ещё не поднялся или команда
                # отказала). Молчать нельзя: без проворота файл растёт, а
                # `mv` в обход postlogd — это ровно та поломка, от которой
                # мы здесь и уходим.
                echo "Не удалось провернуть журнал Postfix (postfix logrotate)" >&2
            fi
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
        applied=''
        seen=''
        while true; do
            now=$(cat /certs/mail.crt /certs/mail.key 2>/dev/null | md5sum)
            # Пара перечитывается, только когда она УСТОЯЛАСЬ.
            #
            # Хеш считается по сертификату И ключу вместе, а замена меняет
            # их двумя переименованиями подряд. Опрос, попавший между ними,
            # перечитал бы новый ключ со старым сертификатом. Комментарии в
            # замене (routes/tls.ts, agent.pl) обещали, что сторож «следит
            # за сертификатом», — на деле он следит за обоими файлами, и
            # порядок переименований от этого не защищает.
            #
            # Два одинаковых замера подряд закрывают окно: между
            # переименованиями микросекунды, между опросами — секунды.
            if [ -n "$applied" ] && [ "$now" = "$seen" ] && [ "$now" != "$applied" ]; then
                echo "Сертификат изменился — перечитываем (postfix reload)"
                postfix reload >/dev/null 2>&1 || true
                applied="$now"
            fi
            [ -n "$applied" ] || applied="$now"
            seen="$now"
            sleep "$CERT_WATCH_INTERVAL"
        done
    ) &
fi

exec /usr/sbin/postfix start-fg
