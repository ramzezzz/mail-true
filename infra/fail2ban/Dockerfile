# fail2ban — бан по адресу за подбор паролей на почтовых портах и веб-входе.
#
# Что читает: файлы общего тома maillogs (postfix.log, dovecot.log, api.log).
# Что делает: добавляет и снимает правила пакетного фильтра НА ХОСТЕ.
# Больше не делает ничего: ни одного слушающего порта, ни сокета Docker,
# ни доступа к базе, ни доступа к письмам.
#
# База — debian:bookworm-slim, как у dovecot и postfix. Причина не в
# единообразии, а в версии: fail2ban в bookworm — 1.0.2, в котором есть
# нарастающий срок бана (bantime.increment) и сохранение банов в базе
# между перезапусками. В ubuntu 22.04 (fail2ban 0.11.2) первое работает
# хуже, а стек всё равно живёт в контейнерах, так что базовый образ
# контейнера с версией хоста совпадать не обязан.
#
# ВАЖНО про iptables. И bookworm, и целевой хост (ubuntu 22.04) по
# умолчанию используют iptables-nft. Если базовый образ окажется на
# iptables-legacy, а хост на nft (или наоборот), правила уйдут в другую
# таблицу и бан не подействует НИЧЕГО не сообщив об ошибке — команда
# отработает успешно, просто мимо. Поэтому вариант выбирается явно ниже.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        fail2ban \
    # Пакетный фильтр: им и делается сам бан.
        iptables \
    # Слежение за файлами журналов по событиям, а не опросом раз в секунду.
    # Без этого пакета fail2ban откатывается на опрос (polling): работает,
    # но на четырёх файлах это лишняя работа каждую секунду круглые сутки.
        python3-pyinotify \
    # envsubst — подстановка настроек из окружения в jail.local,
    # тем же способом, что у postfix и dovecot в этом стеке.
        gettext-base \
    && rm -rf /var/lib/apt/lists/* \
    # Явно закрепляем nft-вариант: см. пояснение выше.
    && update-alternatives --set iptables /usr/sbin/iptables-nft \
    && update-alternatives --set ip6tables /usr/sbin/ip6tables-nft \
    # Debian включает в своём пакете камеру sshd, и она нам мешает дважды.
    #
    # Во-первых, читать ей нечего: журнала /var/log/auth.log в контейнере
    # нет, ssh здесь никто не слушает. Во-вторых — и это важнее — Debian
    # задаёт ей чтение из журнала systemd, а модуля python3-systemd в
    # образе нет: fail2ban на этом ругается при разборе конфигурации, и
    # ошибка про постороннюю камеру выглядит как ошибка наших.
    #
    # Защиту ssh на самой машине это не отменяет — она в контейнере и не
    # жила бы: доступ по ssh закрывает fail2ban, установленный на хосте,
    # либо ключи вместо паролей. Здесь речь только о почте.
    && rm -f /etc/fail2ban/jail.d/defaults-debian.conf

# Свои фильтры и своё действие. Имена начинаются с mailtrue-, чтобы их
# нельзя было спутать со штатными файлами пакета: штатные обновляются
# вместе с fail2ban, наши — вместе с продуктом.
COPY filter.d/ /etc/fail2ban/filter.d/
COPY action.d/ /etc/fail2ban/action.d/
COPY jail.local.template /etc/fail2ban/jail.local.template
COPY fail2ban.local.template /etc/fail2ban/fail2ban.local.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# Проба: служба отвечает на своём управляющем сокете. Это именно проверка
# живости, а не «процесс есть»: fail2ban-server умеет остаться процессом,
# уйдя в себя после ошибки конфигурации, и тогда баны просто не ставятся.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD fail2ban-client ping 2>/dev/null | grep -q pong

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
