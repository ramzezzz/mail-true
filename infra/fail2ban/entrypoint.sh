#!/bin/sh
# ------------------------------------------------------------------
# Запуск fail2ban: подстановка настроек, свой журнал, старт службы.
#
# Настройки приходят из infra/.env через docker-compose.yml. Здесь они
# превращаются в jail.local — потому что fail2ban окружение не читает
# вовсе, а держать пороги зашитыми в образе значит требовать пересборки
# ради строчки «забанить не после 15 попыток, а после 30».
# ------------------------------------------------------------------
set -eu

MAILLOG_DIR=/var/log/mail
F2B_LOG=/data/fail2ban.log
F2B_DB=/data/fail2ban.sqlite3
# Свой журнал никто не проворачивает, а место на диске почтовому серверу
# нужно для писем. Тот же приём, что у dovecot и у сервера приложения.
F2B_LOG_MAX_BYTES="${FAIL2BAN_LOG_MAX_BYTES:-20971520}"

# ------------------------------------------------------------------
# 1. Проверяем то, что нельзя проверить позже
# ------------------------------------------------------------------
# «Включено» обязано быть строго true или false: fail2ban на непонятное
# значение ключа enabled отвечает отказом ВСЕЙ конфигурации, и служба
# уходит в перезапуск по кругу без внятного объяснения.
case "${FAIL2BAN_ENABLED:-true}" in
    true|false) F2B_ENABLED="${FAIL2BAN_ENABLED:-true}" ;;
    *) echo "fail2ban: FAIL2BAN_ENABLED должно быть true или false, а не «${FAIL2BAN_ENABLED}»" >&2
       exit 1 ;;
esac
case "${FAIL2BAN_RECIDIVE_ENABLED:-true}" in
    true|false) F2B_RECIDIVE_ENABLED="${FAIL2BAN_RECIDIVE_ENABLED:-true}" ;;
    *) echo "fail2ban: FAIL2BAN_RECIDIVE_ENABLED должно быть true или false" >&2
       exit 1 ;;
esac
case "${FAIL2BAN_BANTIME_INCREMENT:-true}" in
    true|false) F2B_BANTIME_INCREMENT="${FAIL2BAN_BANTIME_INCREMENT:-true}" ;;
    *) echo "fail2ban: FAIL2BAN_BANTIME_INCREMENT должно быть true или false" >&2
       exit 1 ;;
esac

# ------------------------------------------------------------------
# 2. Белый список: кого не банить ни при каких обстоятельствах
# ------------------------------------------------------------------
# Это САМАЯ важная строка во всей настройке, и вот почему.
#
# Вход в веб-почту сервер приложения проверяет НАСТОЯЩИМ входом по IMAP
# в Dovecot (apps/api/src/routes/auth.ts). Значит, каждая неудачная
# попытка входа через браузер оставляет в dovecot.log строку
# «auth failed» с адресом НАШЕГО ЖЕ контейнера api, а не с адресом
# человека. Без этой строки первый же подбор пароля через веб-интерфейс
# приводил бы к бану контейнера api — то есть веб-почта переставала бы
# работать у всех сразу, и виноват был бы наш собственный сторож.
#
# По той же причине здесь петля (проба живости Dovecot стучится с
# 127.0.0.1) и приватные сети целиком: почтовый сервер в конторе
# обслуживает свою же сеть, и забанить бухгалтерию за три опечатки в
# пароле — худшее, что может сделать защита от подбора.
IGNORE="127.0.0.1/8 ::1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fe80::/10 fc00::/7"
# Подсеть стека задаётся настройкой и по умолчанию 172.28.0.0/16 — она уже
# внутри 172.16.0.0/12, но её могли поменять (второй стенд на той же машине).
IGNORE="$IGNORE ${DOCKER_SUBNET:-172.28.0.0/16}"
# Адреса, которые добавил администратор: свой офис, свой VPN, мониторинг.
IGNORE="$IGNORE ${FAIL2BAN_IGNORE_IPS:-}"
export F2B_IGNORE="$IGNORE"

# ------------------------------------------------------------------
# 3. Подстановка настроек
# ------------------------------------------------------------------
export F2B_ENABLED F2B_RECIDIVE_ENABLED F2B_BANTIME_INCREMENT
export F2B_BANTIME="${FAIL2BAN_BANTIME:-1h}"
export F2B_FINDTIME="${FAIL2BAN_FINDTIME:-10m}"
export F2B_BANTIME_MAX="${FAIL2BAN_BANTIME_MAX:-7d}"
export F2B_DOVECOT_MAXRETRY="${FAIL2BAN_DOVECOT_MAXRETRY:-15}"
export F2B_POSTFIX_MAXRETRY="${FAIL2BAN_POSTFIX_MAXRETRY:-10}"
export F2B_API_MAXRETRY="${FAIL2BAN_API_MAXRETRY:-20}"
export F2B_RECIDIVE_BANTIME="${FAIL2BAN_RECIDIVE_BANTIME:-1w}"
export F2B_RECIDIVE_MAXRETRY="${FAIL2BAN_RECIDIVE_MAXRETRY:-3}"
export F2B_LOGLEVEL="${FAIL2BAN_LOGLEVEL:-INFO}"
export F2B_LOG F2B_DB MAILLOG_DIR

# Список переменных перечислен явно. Иначе envsubst съел бы любой доллар
# в файле — а в конфигурации fail2ban доллары встречаются в регулярных
# выражениях, и «сломанный фильтр» выглядел бы как «фильтр не срабатывает».
VARS='${F2B_ENABLED} ${F2B_IGNORE} ${F2B_BANTIME} ${F2B_FINDTIME}
      ${F2B_BANTIME_MAX} ${F2B_BANTIME_INCREMENT} ${F2B_DOVECOT_MAXRETRY}
      ${F2B_POSTFIX_MAXRETRY} ${F2B_API_MAXRETRY} ${F2B_RECIDIVE_ENABLED}
      ${F2B_RECIDIVE_BANTIME} ${F2B_RECIDIVE_MAXRETRY} ${F2B_LOGLEVEL}
      ${F2B_LOG} ${F2B_DB} ${MAILLOG_DIR}'

envsubst "$VARS" < /etc/fail2ban/jail.local.template     > /etc/fail2ban/jail.local
envsubst "$VARS" < /etc/fail2ban/fail2ban.local.template > /etc/fail2ban/fail2ban.local

# ------------------------------------------------------------------
# 4. Свой журнал: файл (его читает камера «повторные») И stdout
# ------------------------------------------------------------------
# Файл нужен камере recidive: она ловит тех, кого уже банили, и читает
# для этого журнал самого fail2ban. Stdout нужен людям и проверкам
# стенда — `docker compose logs fail2ban` должен показывать баны.
mkdir -p /data /var/run/fail2ban
touch "$F2B_LOG"
chmod 640 "$F2B_LOG"
tail -n 0 -F "$F2B_LOG" &

(
    while true; do
        sleep 300
        SIZE=$(stat -c %s "$F2B_LOG" 2>/dev/null || echo 0)
        if [ "$SIZE" -gt "$F2B_LOG_MAX_BYTES" ]; then
            mv -f "$F2B_LOG" "$F2B_LOG.1"
            # Без этого запись продолжилась бы в переименованный файл,
            # а новый остался бы пустым — и камера «повторные» ослепла бы.
            fail2ban-client flushlogs >/dev/null 2>&1 || true
        fi
    done
) &

# ------------------------------------------------------------------
# 5. Что видно, а что нет
# ------------------------------------------------------------------
# Печатаем честно: какие журналы на месте. Отсутствующий файл — не повод
# падать (постучится api или postfix — файл появится, и fail2ban подхватит
# его сам), но повод сказать об этом словами. Молчаливо неработающая
# защита от подбора хуже отсутствующей: на неё рассчитывают.
if [ "$F2B_ENABLED" = "true" ]; then
    for f in dovecot.log postfix.log api.log; do
        if [ -r "$MAILLOG_DIR/$f" ]; then
            echo "fail2ban: журнал $MAILLOG_DIR/$f — на месте"
        else
            echo "fail2ban: журнала $MAILLOG_DIR/$f пока нет; камера начнёт работать, когда он появится"
        fi
    done
else
    echo "fail2ban: защита ВЫКЛЮЧЕНА (FAIL2BAN_ENABLED=false) — служба работает, но никого не банит"
fi

# -f — не уходить в фон (иначе контейнер завершится сразу же).
# -x — убрать сокет, оставшийся от прошлого запуска: после `docker kill`
#      или падения машины файл сокета переживает контейнер, и без -x
#      служба отказывалась стартовать «уже запущена», хотя не запущена.
exec fail2ban-server -f -x
