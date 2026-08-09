#!/bin/sh
# Генерируем конфигурацию Dovecot из шаблонов (/etc/dovecot-repo, монтируется из
# infra/dovecot/conf) с подстановкой переменных из .env и запускаем в foreground.
# После правки конфигов на хосте: docker compose restart dovecot
set -e

: "${MAIL_DOMAIN:=mail.local}"
# По умолчанию — безопасное значение: без TLS пароль не принимаем.
: "${DOVECOT_DISABLE_PLAINTEXT_AUTH:=yes}"

# ------------------------------------------------------------------
# Приведение «да/нет» к тому виду, который понимает Dovecot
# ------------------------------------------------------------------
# Значение подставляется прямо в `disable_plaintext_auth = …`, а Dovecot
# принимает только yes/no: на «true» он отвечает «Invalid boolean» и НЕ
# ЗАПУСКАЕТСЯ. Умирает при этом не только чтение почты (IMAP/POP3), но и
# LMTP на 24-м порту — то есть принятая Postfix почта перестаёт
# укладываться в ящики.
#
# А «true» сюда приходит штатным путём: настройки сервера в панели
# хранят логические значения строками «true»/«false», и переключатель
# этой настройки записывает в infra/.env именно их. Один щелчок в панели
# останавливал почту, причём негодное значение оставалось в файле — то
# есть служба не поднималась и после перезапуска.
#
# Поэтому принимаем оба написания и любой регистр. Всё, что не похоже на
# «нет», считаем «да»: ошибка в сторону безопасности — пароль не уйдёт
# по нешифрованному соединению.
case "$(printf '%s' "$DOVECOT_DISABLE_PLAINTEXT_AUTH" | tr 'A-Z' 'a-z')" in
    no|false|0|off) DOVECOT_DISABLE_PLAINTEXT_AUTH=no ;;
    *)              DOVECOT_DISABLE_PLAINTEXT_AUTH=yes ;;
esac
# Внутренняя сеть стека — должна совпадать с подсетью из docker-compose.yml
export MAIL_DOMAIN POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DOVECOT_DISABLE_PLAINTEXT_AUTH

envsubst '${MAIL_DOMAIN} ${DOVECOT_DISABLE_PLAINTEXT_AUTH}' \
    < /etc/dovecot-repo/dovecot.conf.template > /etc/dovecot/dovecot.conf

envsubst '${POSTGRES_DB} ${POSTGRES_USER} ${POSTGRES_PASSWORD}' \
    < /etc/dovecot-repo/dovecot-sql.conf.ext.template > /etc/dovecot/dovecot-sql.conf.ext
chmod 600 /etc/dovecot/dovecot-sql.conf.ext

# ------------------------------------------------------------------
# Служебный (master) пользователь для входа администратора в чужой ящик.
# Файл passwd-file: «логин:{СХЕМА}хэш». Пароль хэшируется здесь же,
# в открытом виде на диск не попадает. Без DOVECOT_MASTER_PASSWORD файл
# остаётся пустым — тогда служебный вход просто не работает.
# ------------------------------------------------------------------
: > /etc/dovecot/master-users
if [ -n "${DOVECOT_MASTER_USER:-}" ] && [ -n "${DOVECOT_MASTER_PASSWORD:-}" ]; then
    MASTER_HASH=$(doveadm pw -s SHA512-CRYPT -p "$DOVECOT_MASTER_PASSWORD" | tr -d '\r\n')
    printf '%s:%s\n' "$DOVECOT_MASTER_USER" "$MASTER_HASH" > /etc/dovecot/master-users
    echo "Служебный пользователь Dovecot: $DOVECOT_MASTER_USER"
fi
# passwd-file читает процесс auth уже под пользователем dovecot,
# поэтому файл принадлежит ему и доступен только на чтение только ему.
chown dovecot:dovecot /etc/dovecot/master-users
chmod 400 /etc/dovecot/master-users

# Права на тома (named volume может прийти с root-владельцем):
#   /var/mail/vhosts — письма, /var/mail/index — индексы, включая Xapian
mkdir -p /var/mail/vhosts /var/mail/index
chown vmail:vmail /var/mail/vhosts /var/mail/index

# ------------------------------------------------------------------
# Журнал: файл в общем томе И stdout контейнера одновременно.
# Причина та же, что у Postfix (см. infra/postfix/entrypoint.sh): админке
# нужен файл, людям и проверкам стенда — `docker compose logs dovecot`.
# Своей ротации у Dovecot нет, поэтому проворачиваем сами и говорим
# `doveadm log reopen` — без него запись продолжилась бы в переименованный
# файл, а новый остался бы пустым.
# ------------------------------------------------------------------
DOVELOG=/var/log/mail/dovecot.log
DOVELOG_MAX_BYTES=${DOVECOT_LOG_MAX_BYTES:-33554432}
mkdir -p /var/log/mail
chmod 1777 /var/log/mail 2>/dev/null || true
touch "$DOVELOG"
chmod 644 "$DOVELOG"
tail -n 0 -F "$DOVELOG" &
(
    while true; do
        sleep 60
        SIZE=$(stat -c %s "$DOVELOG" 2>/dev/null || echo 0)
        if [ "$SIZE" -gt "$DOVELOG_MAX_BYTES" ]; then
            mv -f "$DOVELOG" "$DOVELOG.1"
            doveadm log reopen >/dev/null 2>&1 || true
            # ------------------------------------------------------------------
            # ПРАВА НА НОВЫЙ ФАЙЛ — ОБЯЗАТЕЛЬНО, И ИМЕННО ЗДЕСЬ
            # ------------------------------------------------------------------
            # Первый файл создаёт entrypoint и сразу ставит 644 (выше). А
            # после проворота файл заводит сам Dovecot — от root и с маской
            # 077, то есть 0600 root:root. Проверено на нашем же образе.
            #
            # Читает этот файл сервер приложения, работающий под uid 5000:
            # раздел «Журналы почты» в панели и история входов владельца
            # ящика по IMAP/POP3. После первого же проворота оба молча
            # пустели — и пустели снова после каждого следующего.
            #
            # У Postfix этот шаг уже есть и написан по тому же поводу
            # (fix_maillog_permissions в queue-agent.pl); в цикле Dovecot
            # его просто забыли.
            touch "$DOVELOG" 2>/dev/null || true
            chmod 644 "$DOVELOG" 2>/dev/null || true
        fi
    done
) &

# ------------------------------------------------------------------
# Слежение за файлом сертификата — по той же причине, что у Postfix
# (см. infra/postfix/entrypoint.sh): раздел «Сертификат» в панели меняет
# файл, а сокета Docker у сервера приложения нет и не будет.
#
# `doveadm reload` перечитывает конфигурацию вместе с файлами сертификата.
# Уже открытые сеансы IMAP не рвутся: новые настройки получают следующие.
# ------------------------------------------------------------------
CERT_WATCH_INTERVAL="${CERT_WATCH_INTERVAL:-10}"
if [ "$CERT_WATCH_INTERVAL" -gt 0 ] 2>/dev/null; then
    (
        prev=''
        while true; do
            now=$(cat /certs/mail.crt /certs/mail.key 2>/dev/null | md5sum)
            if [ -n "$prev" ] && [ "$now" != "$prev" ]; then
                echo "Сертификат изменился — перечитываем (doveadm reload)"
                doveadm reload >/dev/null 2>&1 || true
            fi
            prev="$now"
            sleep "$CERT_WATCH_INTERVAL"
        done
    ) &
fi

exec dovecot -F
