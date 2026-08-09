#!/usr/bin/env bash
# ------------------------------------------------------------------
# Продление TLS-сертификата Let's Encrypt и раскладка его по стеку.
#
#   sudo bash install/renew-certs.sh              # обычное продление (по таймеру)
#   sudo bash install/renew-certs.sh --force      # выпустить (или перевыпустить,
#                                                 # не глядя на срок)
#   sudo bash install/renew-certs.sh --deploy-only  # только скопировать текущий
#
# Почему не штатный хук certbot: сертификат нужен внутри контейнеров, а они
# видят только каталог infra/data/certs. Поэтому после выпуска файлы
# копируются туда и сервисы перечитывают их (postfix/dovecot/nginx).
#
# Certbot работает в режиме standalone и слушает 80-й порт сам, поэтому
# nginx на время проверки останавливается. Почта в это время ходит:
# останавливается только веб-вход автонастройки, на минуту.
#
# Каждый запуск оставляет отчёт: infra/data/certs/renewal.json — когда,
# чем запущен, чем кончилось и до какого числа теперь действует
# сертификат. Его читает панель («Сертификат» и «Наблюдение»). Зачем это
# нужно и почему файл лежит именно там — в lib/common.sh, раздел «Отчёт о
# продлении сертификата».
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

MODE=renew
case "${1:-}" in
    --force)         MODE=force ;;
    --deploy-only)   MODE=deploy ;;
    --install-timer) MODE=timer ;;
    '')              MODE=renew ;;
    *) die "неизвестный ключ: ${1:-}" ;;
esac

# ------------------------------------------------------------------
# Чем запущен этот прогон.
#
# «Продление не запускалось трое суток» и «его трое суток не запускали
# руками» — разные новости, и различить их можно только здесь. Юнит
# systemd, который заводит install_cert_timer, передаёт MT_RENEW_TRIGGER
# сам. На серверах, где юнит завела прежняя версия установщика, этой
# строки в файле нет — там работает запасной признак: INVOCATION_ID
# systemd задаёт КАЖДОМУ запущенному им юниту и никогда не задаёт
# оболочке человека.
# ------------------------------------------------------------------
RENEW_TRIGGER="${MT_RENEW_TRIGGER:-}"
if [ -z "$RENEW_TRIGGER" ]; then
    if [ -n "${INVOCATION_ID:-}" ]; then RENEW_TRIGGER=timer; else RENEW_TRIGGER=manual; fi
fi

# Включить автопродление и выйти. Нужно после установки из браузера:
# веб-установщик работает в контейнере, а systemd живёт на хосте —
# таймер оттуда завести нечем, и он честно просит выполнить это здесь.
if [ "$MODE" = "timer" ]; then
    step "Автопродление сертификата"
    if install_cert_timer "$SCRIPT_DIR"; then
        # Отчёт обновляем СРАЗУ: панель обязана показать «включено» в ту
        # же минуту, а не через двенадцать часов, когда таймер отработает
        # в первый раз. До этого она честно писала бы, что автопродления
        # нет, — и человек, только что его включивший, решил бы, что
        # команда не сработала.
        renew_report_refresh || warn "таймер включён, но отчёт записать не удалось: $(renew_report_path)"
        ok "таймер mailtrue-certs.timer включён (проверка дважды в сутки)"
        info "посмотреть: systemctl status mailtrue-certs.timer"
        info "в панели: раздел «Сертификат» → «Автопродление»"
        exit 0
    fi
    renew_report_refresh || true
    if have systemctl; then
        die "не удалось включить таймер: systemctl enable mailtrue-certs.timer вернул ошибку"
    fi
    die "systemd на этой машине нет. Добавьте в cron:
       17 3 * * * /bin/bash $SCRIPT_DIR/renew-certs.sh"
fi

load_env
CERT_NAME=mailtrue
LE_DIR="/etc/letsencrypt/live/$CERT_NAME"

# ------------------------------------------------------------------
# Отчёт пишется НА ВЫХОДЕ, каким бы этот выход ни был.
#
# Половина причин, по которым продление не срабатывает, — это выходы
# через die: не установлен certbot, нет файла сертификата, на сервере
# стоит свой сертификат. Записывай мы отчёт только в конце удачного
# прогона, самый важный случай («продление падает каждую ночь») не
# оставлял бы в файле ни строки, и панель показывала бы прошлый успех
# как последнее известное состояние. Поэтому — trap на EXIT: он
# срабатывает и после die, и после ошибки по set -e.
#
# Значения по умолчанию описывают наихудший исход. Если скрипт свалится
# там, где мы этого не предусмотрели, в отчёт попадёт «отказ, причина
# неизвестна» — а не тишина.
# ------------------------------------------------------------------
RENEW_STARTED_AT="$(date +%s)"
RENEW_OUTCOME=failed
RENEW_MESSAGE='Прогон оборвался, не назвав причины — смотрите вывод команды и journalctl -u mailtrue-certs.service'
RENEW_VALID_TO=''

renew_finish() {
    local rc=$?
    local secs=$(( $(date +%s) - RENEW_STARTED_AT ))
    if [ -z "$RENEW_VALID_TO" ]; then
        RENEW_VALID_TO="$(cert_valid_to_iso "$CERT_DIR/mail.crt")"
    fi
    renew_report_write "$RENEW_TRIGGER" "$MODE" "$RENEW_OUTCOME" \
        "$RENEW_VALID_TO" "$secs" "$RENEW_MESSAGE" \
        || printf '     не удалось записать отчёт о продлении в %s\n' "$(renew_report_path)" >&2
    exit "$rc"
}
trap renew_finish EXIT

deploy() {
    if [ ! -f "$LE_DIR/fullchain.pem" ]; then
        RENEW_OUTCOME=failed
        RENEW_MESSAGE="Сертификата Let's Encrypt на машине нет ($LE_DIR/fullchain.pem). Выпустить: sudo bash install/renew-certs.sh --force"
        die "нет сертификата $LE_DIR/fullchain.pem"
    fi
    mkdir -p "$CERT_DIR"
    # Именно копия, а не ссылка: контейнеры видят только каталог certs,
    # символическая ссылка наружу внутри контейнера никуда не ведёт.
    install -m 644 "$LE_DIR/fullchain.pem" "$CERT_DIR/mail.crt"
    install -m 600 "$LE_DIR/privkey.pem"   "$CERT_DIR/mail.key"
    # Отметка «откуда сертификат» — её читают панель и сам этот скрипт.
    printf 'letsencrypt\n' > "$CERT_DIR/source"
    chmod 644 "$CERT_DIR/source" 2>/dev/null || true
    ok "сертификат разложен в $CERT_DIR"
    # Postfix и Dovecot читают файл при старте процесса, nginx — по сигналу.
    dc restart postfix dovecot >/dev/null 2>&1 || warn "не удалось перезапустить postfix/dovecot"
    dc exec -T nginx nginx -s reload >/dev/null 2>&1 || dc restart nginx >/dev/null 2>&1 || true
    ok "сервисы перечитали сертификат"
}

# ------------------------------------------------------------------
# Свой сертификат продлением Let's Encrypt не перезаписывается.
#
# Этот скрипт запускает таймер systemd дважды в сутки. Если на сервере
# поставили свой сертификат (раздел «Сертификат» в панели или руками), то
# без этой проверки очередное продление тихо положило бы на его место
# сертификат Let's Encrypt — а узналось бы это по звонку «Outlook опять
# ругается на узел», через неделю и без единой записи о причине.
#
# Отметку ставит тот, кто ставил сертификат: файл source рядом с ним.
# Снимается она осознанно — переменной в командной строке, а не молча.
#
# ------------------------------------------------------------------
# ПРОВЕРКА СТОИТ ДО ВСЕХ РЕЖИМОВ, В ТОМ ЧИСЛЕ ДО --deploy-only.
#
# Раньше «--deploy-only» обрабатывался ВЫШЕ этого места и шёл прямиком в
# deploy(), то есть в `install ... $LE_DIR/fullchain.pem -> mail.crt`.
# Защита своего сертификата оставалась ниже по тексту и до дела не
# доходила. Ключ этот не экзотический: им пользуется сам установщик, его
# советуют в разделе «Сертификат», и он ровно за тем и нужен, чтобы
# «просто разложить файлы» — то есть человек уверен, что ничего не
# перевыпускает. А получал он затёртый свой сертификат: молча, с бодрым
# «сертификат разложен» на экране.
# ------------------------------------------------------------------
# ------------------------------------------------------------------
# Отметку читаем ЧЕРЕЗ ПРОВЕРКУ НАЛИЧИЯ ФАЙЛА, а не через `cat 2>/dev/null`.
#
# Раньше здесь стояло `CERT_SOURCE="$(cat ... 2>/dev/null | tr -d ...)"`, и
# на сервере без файла source это убивало ВЕСЬ СКРИПТ молча: при set -o
# pipefail неудача cat становится итогом конвейера, а при set -e — концом
# работы. Ни строки в выводе, ни кода причины; продление просто не
# происходило, а сертификат тихо шёл к истечению. Ровно тот сорт поломки,
# ради которого затеян отчёт, — и обнаружен он был первым же его прогоном.
# ------------------------------------------------------------------
CERT_SOURCE=''
if [ -f "$CERT_DIR/source" ]; then
    CERT_SOURCE="$(tr -d '[:space:]' < "$CERT_DIR/source")"
fi
if [ "$CERT_SOURCE" = "custom" ] && [ "${MT_REPLACE_CUSTOM_CERT:-0}" != "1" ]; then
    CURRENT_CN="$(openssl x509 -in "$CERT_DIR/mail.crt" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p' || true)"
    # В отчёте это НЕ отказ: продление сработало ровно так, как задумано.
    # Покрась мы этот случай красным, панель ругалась бы дважды в сутки на
    # сервере, где всё правильно, — и на её ругань перестали бы смотреть.
    RENEW_OUTCOME=skipped-custom
    RENEW_MESSAGE="На сервере стоит свой сертификат (CN=${CURRENT_CN:-?}) — продление Let's Encrypt его намеренно не трогает"
    die "на этом сервере стоит СВОЙ сертификат (CN=${CURRENT_CN:-?}), а не Let's Encrypt.
       Продление заменило бы его — этого не делается молча.

       Если сертификат действительно пора менять, поставьте новый в панели:
         раздел «Сертификат» → «Поставить свой».

       Если вы хотите вернуться к Let's Encrypt и перезаписать свой сертификат:
         MT_REPLACE_CUSTOM_CERT=1 sudo bash $0 ${1:-}"
fi

# Раскладка без выпуска — теперь ПОСЛЕ проверки своего сертификата.
if [ "$MODE" = "deploy" ]; then
    deploy
    RENEW_OUTCOME=deployed
    RENEW_MESSAGE="Сертификат разложен по стеку из $LE_DIR; выпуск и продление при этом не запускались"
    exit 0
fi

if ! have certbot; then
    RENEW_MESSAGE='На машине нет certbot — продлевать нечем. Установить: apt-get install -y certbot'
    die "certbot не установлен: apt-get install -y certbot"
fi

cert_enddate() {
    if [ -f "$LE_DIR/cert.pem" ]; then
        openssl x509 -in "$LE_DIR/cert.pem" -noout -enddate 2>/dev/null || true
    fi
}
BEFORE="$(cert_enddate)"

step "Продление сертификата"
info "останавливаем nginx на время проверки Let's Encrypt"
dc stop nginx >/dev/null 2>&1 || true

# ------------------------------------------------------------------
# --force УМЕЕТ ВЫПУСКАТЬ, А НЕ ТОЛЬКО ПРОДЛЕВАТЬ.
#
# `certbot renew` работает с уже существующей записью о сертификате. На
# сервере, где сертификата ещё нет (самоподписанный, выпуск при установке
# не удался — не разошёлся DNS, был занят 80-й порт), она отвечает
# «no certificate found with name mailtrue» и выходит с ошибкой.
#
# А на «--force» отсылают из пяти мест, и все они — про сервер БЕЗ
# сертификата: подсказка неудавшегося выпуска в установщике, отказ
# deploy(), документация, панель. Человек делал ровно то, что ему велели,
# и получал отказ, из которого не следует ничего: слова «renew» он не
# просил, имени mailtrue не знает.
#
# Поэтому: нет записи — выпускаем (certonly), есть — продлеваем (renew).
# ------------------------------------------------------------------
RC=0
if [ ! -d "$LE_DIR" ] && [ "$MODE" = "force" ]; then
    info "сертификата $CERT_NAME на машине ещё нет — выпускаем впервые"
    # Адрес для уведомлений об истечении Let's Encrypt требует обязательно.
    # Берём тот, что записала установка (install/state/install.conf), —
    # иначе человеку пришлось бы вспоминать, какой он указывал.
    LE_EMAIL=''
    if [ -f "$STATE_FILE" ]; then
        # «|| true» обязателен: скрипт идёт под set -euo pipefail, и любая
        # единица внутри конвейера оборвала бы продление молча — ровно тот
        # сорт поломки, ради которого затеян отчёт.
        LE_EMAIL="$(sed -n 's/^LE_EMAIL=//p' "$STATE_FILE" | tail -1 | tr -d '\r' || true)"
    fi
    [ -n "$LE_EMAIL" ] || LE_EMAIL="postmaster@${MAIL_DOMAIN:-localhost}"
    if cert_reachable_names "${MAIL_HOSTNAME:-${MAIL_DOMAIN:-}}" "${MAIL_DOMAIN:-}"; then
        CERTBOT_ARGS=(certonly --standalone --non-interactive --agree-tos
                      --cert-name "$CERT_NAME" --keep-until-expiring
                      --email "$LE_EMAIL")
        for name in "${MT_CERT_NAMES[@]}"; do CERTBOT_ARGS+=(-d "$name"); done
        certbot "${CERTBOT_ARGS[@]}" || RC=$?
    else
        # Отдельный код и отдельная причина: «certbot вернул 1» здесь
        # было бы неправдой — certbot даже не запускался, а править надо
        # записи DNS, а не сервер.
        RC=0
        dc start nginx >/dev/null 2>&1 || true
        fail "ни одно имя не указывает на этот сервер — Let's Encrypt откажет"
        hint "опубликуйте A-запись $MAIL_HOSTNAME и CNAME mail./admin./autoconfig.$MAIL_DOMAIN"
        hint "затем повторите: sudo bash $0 --force"
        RENEW_OUTCOME=failed
        RENEW_MESSAGE="Выпуск не начинался: ни одно имя ($MAIL_HOSTNAME, mail./admin./autoconfig.$MAIL_DOMAIN) не ведёт на этот сервер. Опубликуйте записи DNS и повторите."
        exit 1
    fi
elif [ "$MODE" = "force" ]; then
    certbot renew --cert-name "$CERT_NAME" --standalone --force-renewal --non-interactive || RC=$?
else
    certbot renew --cert-name "$CERT_NAME" --standalone --non-interactive || RC=$?
fi

dc start nginx >/dev/null 2>&1 || true

if [ "$RC" -ne 0 ]; then
    fail "certbot вернул код $RC"
    hint "подробности: /var/log/letsencrypt/letsencrypt.log"
    # Причина словами — самое ценное, что остаётся от неудачного прогона:
    # к моменту, когда на отчёт посмотрят, журнал certbot успевает
    # смениться, а панели журналы хоста и так не видны.
    RENEW_OUTCOME=failed
    RENEW_MESSAGE="certbot вернул код $RC. Подробности на сервере: /var/log/letsencrypt/letsencrypt.log"
    exit "$RC"
fi

AFTER="$(cert_enddate)"
RENEW_VALID_TO="$(cert_valid_to_iso "$LE_DIR/cert.pem")"

if [ "$BEFORE" = "$AFTER" ] && [ "$MODE" != "force" ]; then
    ok "сертификат ещё свежий, продление не требовалось ($AFTER)"
    RENEW_OUTCOME=not-due
    RENEW_MESSAGE="Продление не требовалось: срок ещё не подошёл. Сертификат действует до $AFTER"
    # Всё равно раскладываем: файлы в стеке могли отстать от /etc/letsencrypt
    deploy
else
    ok "сертификат продлён ($AFTER)"
    RENEW_OUTCOME=renewed
    RENEW_MESSAGE="Сертификат продлён, теперь действует до $AFTER"
    deploy
fi
