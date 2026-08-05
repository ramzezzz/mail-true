#!/bin/sh
# Письмо-предупреждение о приближении к квоте.
# Вызывается службой quota-warning (см. dovecot.conf, plugin { quota_warning }),
# аргументы: $1 — достигнутый процент, $2 — адрес ящика.
#
# Важно: Dovecot запускает служебные скрипты с вычищенным окружением, поэтому
# PATH задаём сами, а внешними командами не пользуемся вовсе — текст письма
# уходит в dovecot-lda прямо из here-document.
# noenforcing нужен, чтобы само предупреждение влезло в почти полный ящик.
#
# exec 1>&2: служба `script` подставляет на stdout сокет вызывающего процесса,
# а log_path = /dev/stdout — это /proc/self/fd/1, то есть тот самый сокет.
# Открыть его как файл нельзя, и dovecot-lda падал бы с «Can't open log file».
# Переводим stdout на stderr — там настоящий журнал контейнера.
exec 1>&2
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

PERCENT=$1
USER=$2
DOMAIN=${MAIL_DOMAIN:-mail.local}

/usr/lib/dovecot/dovecot-lda -d "$USER" \
    -o "plugin/quota=maildir:User quota:noenforcing" \
    -o info_log_path=/dev/null <<EOF
From: postmaster@$DOMAIN
To: $USER
Subject: Ящик заполнен на ${PERCENT}%
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Ваш почтовый ящик заполнен на ${PERCENT}% от выделенной квоты.

Когда место закончится, новые письма приниматься не будут — отправители
получат отказ. Освободите место: удалите ненужные письма и очистите Корзину.
EOF
