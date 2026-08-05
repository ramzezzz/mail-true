# Dovecot: IMAP + LMTP + SASL, аутентификация из PostgreSQL, Maildir-хранилище,
# полнотекстовый поиск (FTS Xapian) и квоты.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-pgsql \
        dovecot-fts-xapian \
    # Sieve — раскладка писем по папкам при доставке. Нужен сразу для двух
    # вещей: помеченный спам должен попадать в папку «Спам» (сам Rspamd этого
    # сделать не может — он только ставит заголовок), и на нём же будут
    # работать пользовательские правила фильтрации.
        dovecot-sieve dovecot-managesieved \
        gettext-base netcat-openbsd ca-certificates \
    # Разборщики вложений для fts_decoder (decode2text.sh):
    #   poppler-utils — pdftotext (PDF)
    #   catdoc        — catdoc/catppt/xls2csv (старые .doc/.ppt/.xls)
    #   unzip         — распаковка OOXML/ODF (.docx/.xlsx/.pptx/.odt/.ods/.odp),
    #                   текст из XML достаёт штатный /usr/lib/dovecot/xml2text
    #   unrtf         — .rtf
        poppler-utils catdoc unzip unrtf \
    && rm -rf /var/lib/apt/lists/*

# Пользователь-владелец всех Maildir (uid/gid 5000)
RUN groupadd -g 5000 vmail \
    && useradd -u 5000 -g vmail -d /var/mail/vhosts -s /usr/sbin/nologin vmail \
    && mkdir -p /var/mail/vhosts /var/mail/index \
    && chown -R vmail:vmail /var/mail/vhosts /var/mail/index

# Глобальный фильтр Sieve: раскладка помеченного спама в папку «Спам».
#
# Компилируем его прямо при сборке образа. Без этого Dovecot пытается
# скомпилировать скрипт при КАЖДОЙ доставке письма, не может (каталог
# принадлежит root, а доставка идёт от vmail) и пишет в журнал две строки
# ошибки на каждое письмо. Работать-то работает — интерпретирует исходник, —
# но это лишняя работа на каждом письме и залитый ошибками журнал.
COPY sieve/ /etc/dovecot/sieve/
RUN sievec /etc/dovecot/sieve/spam-to-junk.sieve \
    && ls -l /etc/dovecot/sieve/spam-to-junk.svbin

# Извлечение текста из вложений (вызывается службой decode2text)
COPY decode2text.sh /usr/lib/dovecot/decode2text.sh
# Письмо-предупреждение при приближении к квоте
COPY quota-warning.sh /usr/local/bin/quota-warning.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/lib/dovecot/decode2text.sh /usr/local/bin/quota-warning.sh /entrypoint.sh

# 143/993 IMAP, 110/995 POP3, 24 LMTP, 12345 SASL-auth для Postfix,
# 12340 quota-status (policy-сервис Postfix: отказ переполненному ящику на RCPT)
EXPOSE 143 993 110 995 24 12345 12340
ENTRYPOINT ["/entrypoint.sh"]
