#!/usr/bin/env bash
# ------------------------------------------------------------------
# Самопроверка Mail.True после установки.
#
#   sudo bash install/selfcheck.sh                     # полная проверка
#   sudo bash install/selfcheck.sh --quick             # без проверки доставки
#   sudo bash install/selfcheck.sh --external you@ya.ru  # + отправка наружу
#
# Смысл: показать честную картину. Каждый пункт объясняется словами,
# у каждого непройденного пункта написано, что именно сделать.
#
# Код возврата: 0 — всё зелёное или только предупреждения,
#               1 — есть проваленные пункты.
# ------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

QUICK=0
EXTERNAL=''
while [ $# -gt 0 ]; do
    case "$1" in
        --quick)    QUICK=1; shift ;;
        --external) EXTERNAL="${2:-}"; shift 2 ;;
        --help|-h)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) die "неизвестный ключ: $1" ;;
    esac
done

load_env
DOMAIN="${MAIL_DOMAIN:?в infra/.env нет MAIL_DOMAIN}"
MAIL_HOST="${MAIL_HOSTNAME:-$DOMAIN}"
SELECTOR="${DKIM_SELECTOR:-mail}"
# Ящик, на котором проверяется доставка. По умолчанию — ящик администратора
# из состояния установки; можно указать другой: MAILTRUE_CHECK_MAILBOX=...
ADMIN_EMAIL="postmaster@$DOMAIN"
if [ -f "$STATE_FILE" ]; then
    v="$(sed -n 's/^ADMIN_EMAIL=//p' "$STATE_FILE" | tail -1)"
    if [ -n "$v" ]; then ADMIN_EMAIL="$v"; fi
fi
ADMIN_EMAIL="${MAILTRUE_CHECK_MAILBOX:-$ADMIN_EMAIL}"

printf '%s\n  Самопроверка Mail.True: %s (%s)%s\n' "$C_BOLD" "$DOMAIN" "$MAIL_HOST" "$C_OFF"

# ==================================================================
step "1. Сервисы стека"
# ==================================================================
# Что проверяем: контейнеры запущены и их healthcheck зелёный.
# Если сервис красный — почта не работает целиком или частично.

if ! docker info >/dev/null 2>&1; then
    fail "Docker не отвечает"
    hint "systemctl status docker; systemctl start docker"
    exit 1
fi

for svc in unbound postgres redis dovecot rspamd postfix autoconfig api web admin nginx; do
    state="$(service_state "$svc")"
    case "$state" in
        *healthy*)   ok "$svc — работает и здоров" ;;
        running*)    ok "$svc — работает" ;;
        '')          fail "$svc — контейнера нет"
                     hint "поднять: docker compose -f infra/docker-compose.yml -f install/compose.prod.yml up -d $svc" ;;
        *)           fail "$svc — состояние «$state»"
                     hint "смотреть журнал: docker compose -f infra/docker-compose.yml logs --tail=100 $svc" ;;
    esac
done

if [ "${CLAMAV_ENABLED:-false}" = "true" ]; then
    state="$(service_state clamav)"
    case "$state" in
        *healthy*) ok "clamav — работает (антивирус включён)" ;;
        *starting*) warn "clamav ещё качает базы сигнатур — это 5–10 минут после запуска" ;;
        *) fail "clamav включён в .env, но контейнер не здоров: ${state:-нет контейнера}"
           hint "поднять: docker compose -f infra/docker-compose.yml -f install/compose.prod.yml --profile clamav up -d" ;;
    esac
else
    info "антивирус выключен (CLAMAV_ENABLED=false) — так задумано по умолчанию"
fi

MEM=$(dc ps -q 2>/dev/null | xargs -r docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | \
      sed 's#/.*##' | awk '{ u=$0; gsub(/[A-Za-z]/,"",u);
        if ($0 ~ /GiB/) s += u*1024; else if ($0 ~ /MiB/) s += u; else if ($0 ~ /KiB/) s += u/1024 }
        END { printf "%d", s }')
if [ -n "$MEM" ] && [ "$MEM" -gt 0 ]; then
    info "стек занимает ${MEM} МБ памяти"
    if [ "$MEM" -gt 900 ] && [ "${CLAMAV_ENABLED:-false}" != "true" ]; then
        warn "это заметно больше обычных 310 МБ — посмотрите, кто ест память:"
        hint "docker stats --no-stream"
    fi
fi

# --- Свой резольвер -------------------------------------------------
# Отдельный пункт, потому что это самая тихая из возможных поломок:
# списки Spamhaus и URIBL отвечают только своим резольверам, и если
# unbound не работает, антиспам молча перестаёт ловить почти всё.
RESOLV="$(dc exec -T unbound sh -c 'dig @127.0.0.1 +time=3 +tries=1 +short 2.0.0.127.zen.spamhaus.org' 2>/dev/null | tr -d '\r' | tr '\n' ' ')"
case "$RESOLV" in
    *127.0.0.*)
        ok "свой резольвер работает: контрольная запись Spamhaus отвечает ($RESOLV)" ;;
    *127.255.255.254*)
        fail "Spamhaus отвечает «запрос через публичный резольвер» — проверки не работают"
        hint "rspamd должен ходить через unbound; проверьте dns: в docker-compose.yml" ;;
    '')
        fail "свой резольвер (unbound) не отвечает — списки спама молча перестанут работать"
        hint "смотрите: docker compose -f infra/docker-compose.yml logs unbound"
        hint "частая причина — закрытый исходящий UDP/53 или сломанный NAT" ;;
    *)
        warn "резольвер ответил неожиданно: $RESOLV" ;;
esac

# ==================================================================
step "2. Порты"
# ==================================================================
# Что проверяем: порт слушается и слушается на внешнем адресе.
# Порт, открытый только на 127.0.0.1, снаружи недоступен — почта
# не придёт, клиенты не подключатся.

check_port() {
    local port="$1" what="$2" listener
    listener="$(port_listener "$port")"
    if [ -z "$listener" ]; then
        fail "порт $port ($what) никто не слушает"
        hint "проверьте, что контейнер запущен и что в install/compose.prod.yml есть этот порт"
        return
    fi
    local addr
    addr=$(printf '%s' "$listener" | awk '{print $4}')
    case "$addr" in
        127.0.0.1:*|\[::1\]:*)
            fail "порт $port ($what) слушает только localhost ($addr)"
            hint "стек поднят без боевого переопределения; поднимите так:"
            hint "  docker compose -f infra/docker-compose.yml -f install/compose.prod.yml up -d" ;;
        *)  ok "порт $port ($what) слушает $addr" ;;
    esac
}

check_port 25  "приём почты"
check_port 587 "отправка, submission"
check_port 143 "IMAP + STARTTLS"
check_port 993 "IMAPS"
check_port 110 "POP3 + STARTTLS"
check_port 995 "POP3S"
check_port 80  "HTTP: автонастройка и продление сертификата"
check_port 443 "HTTPS: автонастройка (Outlook работает только по HTTPS)"

if [ -z "$(port_listener 465)" ]; then
    info "порт 465 (SMTPS) не слушается — стек его пока не поддерживает,"
    info "клиенты настраиваются на 587 со STARTTLS (так их и настраивает автоконфиг)"
fi

# Исходящий 25-й: без него письма не уходят наружу
OUT_OK=0
for mx in gmail-smtp-in.l.google.com alt1.aspmx.l.google.com mx.yandex.ru; do
    if tcp_probe "$mx" 25 6; then OUT_OK=1; break; fi
done
if [ "$OUT_OK" = "1" ]; then
    ok "исходящий порт 25 открыт — письма могут уходить наружу"
else
    fail "исходящий порт 25 закрыт — письма не уйдут ни на один чужой сервер"
    hint "порт режет хостер. Напишите в поддержку и попросите открыть TCP/25 наружу."
    hint "Пока не откроют, письма будут копиться в очереди postfix (mailq)."
fi

# ==================================================================
step "3. DNS-записи"
# ==================================================================
# Что проверяем: опубликованы ли записи и совпадают ли они с тем,
# что сервер о себе сообщает. Проверку делает сервис автонастройки:
# он резолвит каждую запись вживую и сравнивает с ожидаемой.

SERVER_IP="$(public_ip)"
info "внешний адрес сервера: ${SERVER_IP:-не определён}"

HOST_IPS="$(resolve_a "$MAIL_HOST" | tr '\n' ' ')"
if [ -z "$HOST_IPS" ]; then
    fail "A-записи $MAIL_HOST нет в DNS"
    hint "Опубликуйте у регистратора: $MAIL_HOST.  A  ${SERVER_IP:-<адрес сервера>}"
elif [ -n "$SERVER_IP" ] && printf '%s' "$HOST_IPS" | grep -qw "$SERVER_IP"; then
    ok "A-запись $MAIL_HOST → $HOST_IPS (это мы)"
else
    fail "A-запись $MAIL_HOST → $HOST_IPS, а сервер имеет адрес ${SERVER_IP:-?}"
    hint "Исправьте A-запись, иначе почта придёт не сюда и сертификат не выпустится."
fi

# Живой резолв каждой записи делает сервис автонастройки: он же знает,
# какими эти записи должны быть. Формат ответа — docs/autoconfig.md.
DNS_JSON="$(dc exec -T autoconfig node -e "
const short = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 120);
fetch('http://127.0.0.1:8080/api/dns-check?domain=' + encodeURIComponent('$DOMAIN'))
  .then((r) => r.json())
  .then((j) => {
    for (const c of j.results || []) {
      process.stdout.write([
        c.status, c.type, c.name, short(c.expected),
        short(Array.isArray(c.found) ? c.found.join(' ; ') : c.found), short(c.comment),
      ].join('\t') + '\n');
    }
  })
  .catch((e) => { process.stderr.write(String(e)); process.exit(1); });
" 2>/dev/null)"

if [ -z "$DNS_JSON" ]; then
    warn "сервис автонастройки не ответил — проверить DNS автоматически не вышло"
    hint "вручную: curl 'http://127.0.0.1:8025/api/dns-check?domain=$DOMAIN'"
else
    while IFS=$'\t' read -r status rtype rname expected found comment; do
        [ -n "${rtype:-}" ] || continue
        label="$rtype $rname"
        case "$status" in
            ok)       ok "$label — опубликована и совпадает" ;;
            mismatch) fail "$label — опубликована, но отличается от ожидаемой"
                      hint "ожидается: ${expected:-?}"
                      hint "в DNS:     ${found:-?}"
                      hint "${comment:-}" ;;
            missing)  fail "$label — не опубликована"
                      if [ "${#expected}" -gt 100 ]; then
                          hint "готовую строку возьмите в $STATE_DIR/dns-records.txt"
                      else
                          hint "добавьте у регистратора: $rname $rtype ${expected:-?}"
                      fi ;;
            error)    warn "$label — не удалось проверить (${comment:-ошибка резолва})"
                      hint "обычно это значит, что зоны домена ещё нет в DNS" ;;
            *)        warn "$label — состояние «$status»" ;;
        esac
    done <<< "$DNS_JSON"
fi

# --- PTR (обратная зона) -------------------------------------------
# Крупные почтовые службы отклоняют письма с адресов без обратной записи.
if [ -z "$SERVER_IP" ]; then
    warn "не удалось определить внешний адрес — PTR не проверить"
elif have dig; then
    PTR="$(dig +short -x "$SERVER_IP" 2>/dev/null | sed 's/\.$//' | head -1)"
    if [ -z "$PTR" ]; then
        fail "обратной записи (PTR) для $SERVER_IP нет"
        hint "PTR настраивается НЕ у регистратора домена, а в панели хостинга"
        hint "(часто раздел «rDNS» у VPS). Нужно: $SERVER_IP → $MAIL_HOST"
        hint "Без PTR Google, Mail.ru и Яндекс отклоняют письма ещё на подключении."
    elif [ "$PTR" = "$MAIL_HOST" ]; then
        ok "PTR: $SERVER_IP → $PTR (совпадает с именем сервера)"
    else
        fail "PTR: $SERVER_IP → $PTR, а сервер представляется как $MAIL_HOST"
        hint "Имена должны совпадать. Поменяйте rDNS в панели хостинга на $MAIL_HOST"
    fi
else
    warn "нет dig (пакет dnsutils) — PTR не проверить"
fi

# ==================================================================
step "4. TLS-сертификат"
# ==================================================================
# Что проверяем: сертификат настоящий (а не самоподписанный), покрывает
# все нужные имена и не истекает в ближайшее время.

CRT="$CERT_DIR/mail.crt"
if [ ! -f "$CRT" ]; then
    fail "нет файла сертификата $CRT"
else
    SUBJ="$(openssl x509 -in "$CRT" -noout -subject 2>/dev/null | sed 's/^subject= *//')"
    ISSUER="$(openssl x509 -in "$CRT" -noout -issuer 2>/dev/null | sed 's/^issuer= *//')"
    SANS="$(openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | tr -d ' ' | grep -o 'DNS:[^,]*' | sed 's/DNS://' | tr '\n' ' ')"
    END="$(openssl x509 -in "$CRT" -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
    END_TS="$(date -d "$END" +%s 2>/dev/null || echo 0)"
    DAYS=$(( (END_TS - $(date +%s)) / 86400 ))

    if [ "$SUBJ" = "$ISSUER" ]; then
        warn "сертификат самоподписанный"
        hint "почта работает, но клиенты будут ругаться, а Outlook откажется"
        hint "настраиваться автоматически. Выпустить настоящий:"
        hint "  sudo bash install/renew-certs.sh --force"
        hint "(перед этим DNS-имена должны указывать на сервер)"
    else
        ok "сертификат выдан удостоверяющим центром: ${ISSUER:0:60}"
    fi

    if [ "$DAYS" -gt 20 ]; then
        ok "срок действия: ещё $DAYS дней (до $END)"
    elif [ "$DAYS" -gt 0 ]; then
        warn "сертификат истекает через $DAYS дней ($END)"
        hint "продлить: sudo bash install/renew-certs.sh"
    else
        fail "сертификат истёк ($END)"
        hint "продлить: sudo bash install/renew-certs.sh --force"
    fi

    for name in "$MAIL_HOST" "mail.$DOMAIN" "admin.$DOMAIN" "autoconfig.$DOMAIN" "autodiscover.$DOMAIN"; do
        if printf '%s' "$SANS" | grep -qw "$name"; then
            ok "сертификат покрывает $name"
        else
            warn "сертификат не покрывает $name"
            hint "клиент, который придёт на это имя, увидит ошибку сертификата"
        fi
    done

    # Живая проверка: тот ли сертификат реально отдают сервисы
    for probe in "993:IMAPS" "443:HTTPS"; do
        port="${probe%%:*}"; what="${probe##*:}"
        if printf 'Q\n' | timeout 8 openssl s_client -connect "127.0.0.1:$port" \
                -servername "$MAIL_HOST" >/dev/null 2>&1; then
            ok "$what ($port) отдаёт TLS-сертификат"
        else
            fail "$what ($port) не отвечает по TLS"
        fi
    done
    if printf 'Q\n' | timeout 8 openssl s_client -connect "127.0.0.1:587" -starttls smtp >/dev/null 2>&1; then
        ok "submission (587) поддерживает STARTTLS"
    else
        fail "submission (587) не поднимает STARTTLS — клиенты не смогут отправлять"
    fi
fi

# ==================================================================
step "5. DKIM"
# ==================================================================
# Что проверяем: ключ есть у rspamd, публичная часть опубликована в DNS
# и совпадает с ключом. Несовпадение хуже отсутствия: письма будут
# подписаны ключом, который получатель не сможет проверить.

DKIM_LOCAL="$(dc exec -T rspamd sh -c "cat /var/lib/rspamd/dkim/${DOMAIN}.${SELECTOR}.dns.txt 2>/dev/null" 2>/dev/null | tr -d '\r')"
if [ -z "$DKIM_LOCAL" ]; then
    fail "у rspamd нет ключа DKIM для $DOMAIN (селектор $SELECTOR)"
    hint "ключ создаётся при первом запуске rspamd; перезапустите: docker compose restart rspamd"
else
    LOCAL_P="$(printf '%s' "$DKIM_LOCAL" | grep -o 'p=[A-Za-z0-9+/=]*' | head -1 | cut -c3- | tr -d '"')"
    ok "ключ DKIM у rspamd есть (селектор $SELECTOR)"
    if have dig; then
        PUB="$(dig +short TXT "${SELECTOR}._domainkey.${DOMAIN}" 2>/dev/null | tr -d '"' | tr -d ' ' | tr -d '\n')"
        if [ -z "$PUB" ]; then
            fail "запись ${SELECTOR}._domainkey.${DOMAIN} не опубликована"
            hint "возьмите готовую строку из install/state/dns-records.txt"
        else
            PUB_P="$(printf '%s' "$PUB" | grep -o 'p=[A-Za-z0-9+/=]*' | head -1 | cut -c3-)"
            if [ -n "$LOCAL_P" ] && [ "$PUB_P" = "$LOCAL_P" ]; then
                ok "опубликованный ключ DKIM совпадает с ключом сервера"
            else
                fail "опубликованный ключ DKIM НЕ совпадает с ключом сервера"
                hint "получатели не смогут проверить подпись — это хуже, чем без DKIM"
                hint "замените TXT-запись на строку из install/state/dns-records.txt"
            fi
        fi
    fi
fi

# ==================================================================
step "6. Почта в обе стороны"
# ==================================================================
# Что проверяем: письмо снаружи доходит до ящика, письмо изнутри
# отправляется через submission и подписывается DKIM.

if [ "$QUICK" = "1" ]; then
    info "пропущено (--quick)"
else
    TOKEN="sc$(date +%s)$RANDOM"

    # --- Входящее -------------------------------------------------
    if dc exec -T postfix swaks --server postfix:25 --helo checker.example.com \
            --from "selfcheck@example.com" --to "$ADMIN_EMAIL" \
            --header "Subject: selfcheck-in $TOKEN" --body "selfcheck inbound $TOKEN" \
            >/dev/null 2>&1; then
        ok "письмо принято на порт 25"
    else
        fail "порт 25 не принял письмо"
        hint "смотрите: docker compose -f infra/docker-compose.yml logs --tail=50 postfix"
    fi

    FOUND=''
    for _ in $(seq 1 30); do
        if dc exec -T dovecot doveadm search -u "$ADMIN_EMAIL" \
                mailbox INBOX HEADER Subject "$TOKEN" 2>/dev/null | grep -q .; then
            FOUND=1; break
        fi
        sleep 1
    done
    if [ -n "$FOUND" ]; then
        ok "письмо доставлено в ящик $ADMIN_EMAIL"
    else
        fail "письмо не дошло до ящика за 30 секунд"
        hint "проверьте, что ящик существует и что LMTP-доставка работает:"
        hint "  docker compose -f infra/docker-compose.yml logs --tail=50 dovecot"
    fi

    # --- Исходящее ------------------------------------------------
    # Входим служебным (master) пользователем: пароль владельца ящика
    # самопроверке не нужен и нигде не хранится.
    if [ -z "${DOVECOT_MASTER_USER:-}" ] || [ -z "${DOVECOT_MASTER_PASSWORD:-}" ]; then
        warn "служебный пользователь Dovecot не настроен — отправку не проверить"
        hint "задайте DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD в infra/.env"
    else
        AUTH_USER="${ADMIN_EMAIL}*${DOVECOT_MASTER_USER}"
        if dc exec -T postfix swaks --server postfix:587 --tls \
                --auth PLAIN --auth-user "$AUTH_USER" --auth-password "$DOVECOT_MASTER_PASSWORD" \
                --from "$ADMIN_EMAIL" --to "$ADMIN_EMAIL" \
                --header "Subject: selfcheck-out $TOKEN" --body "selfcheck outbound $TOKEN" \
                >/dev/null 2>&1; then
            ok "отправка через submission:587 с аутентификацией работает"
        else
            fail "отправка через submission:587 не прошла"
            hint "проверьте пароль служебного пользователя в infra/.env и журнал postfix"
        fi

        FOUND2=''
        for _ in $(seq 1 30); do
            if dc exec -T dovecot doveadm search -u "$ADMIN_EMAIL" \
                    mailbox INBOX HEADER Subject "selfcheck-out $TOKEN" 2>/dev/null | grep -q .; then
                FOUND2=1; break
            fi
            sleep 1
        done
        if [ -n "$FOUND2" ]; then
            HDRS="$(dc exec -T dovecot doveadm fetch -u "$ADMIN_EMAIL" hdr \
                    mailbox INBOX HEADER Subject "selfcheck-out $TOKEN" 2>/dev/null)"
            if printf '%s' "$HDRS" | grep -qi '^DKIM-Signature:'; then
                ok "исходящее письмо подписано DKIM (rspamd)"
            else
                fail "исходящее письмо без DKIM-подписи"
                hint "проверьте ключ: docker compose exec rspamd ls /var/lib/rspamd/dkim/"
            fi
        else
            fail "исходящее письмо не вернулось в ящик за 30 секунд"
        fi
    fi

    # --- Наружу (по запросу) --------------------------------------
    if [ -n "$EXTERNAL" ]; then
        if dc exec -T postfix swaks --server postfix:587 --tls \
                --auth PLAIN --auth-user "${ADMIN_EMAIL}*${DOVECOT_MASTER_USER:-}" \
                --auth-password "${DOVECOT_MASTER_PASSWORD:-}" \
                --from "$ADMIN_EMAIL" --to "$EXTERNAL" \
                --header "Subject: Mail.True selfcheck $TOKEN" \
                --body "Проверка доставки наружу. Токен $TOKEN" >/dev/null 2>&1; then
            ok "письмо на $EXTERNAL принято к отправке"
            sleep 8
            QUEUE="$(dc exec -T postfix mailq 2>/dev/null | tail -5)"
            if printf '%s' "$QUEUE" | grep -qi 'Mail queue is empty'; then
                ok "очередь пуста — письмо ушло на чужой сервер"
                hint "проверьте, дошло ли оно, и не попало ли в спам"
            else
                warn "письмо задержалось в очереди:"
                printf '%s\n' "$QUEUE"
                hint "частая причина — закрытый исходящий 25-й порт"
            fi
        else
            fail "не удалось отправить письмо на $EXTERNAL"
        fi
    fi
fi

# ==================================================================
step "7. Веб-интерфейс"
# ==================================================================
# Проверяем так же, как это увидит браузер: через nginx, по имени хоста,
# а не в обход. Обращаемся на localhost — DNS для этого не нужен, поэтому
# проверка работает и до того, как записи разошлись.

# web_probe <имя хоста> <путь> <ожидаемый код> <описание>
web_probe() {
    local host="$1" path="$2" want="$3" what="$4" code
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
            --resolve "$host:443:127.0.0.1" "https://$host$path" 2>/dev/null || echo 000)"
    if [ "$code" = "$want" ]; then
        ok "$what (HTTP $code)"
        return 0
    fi
    fail "$what: ожидался HTTP $want, получен ${code:-нет ответа}"
    return 1
}

web_probe "$DOMAIN"        "/" 200 "почта отдаётся на https://$DOMAIN" || \
    hint "журнал: docker compose -f infra/docker-compose.yml logs --tail=50 web nginx"
web_probe "mail.$DOMAIN"   "/" 200 "почта отдаётся на https://mail.$DOMAIN"
web_probe "admin.$DOMAIN"  "/" 200 "админка отдаётся на https://admin.$DOMAIN"

# 401 здесь — правильный ответ: сессии нет, но сервер приложения жив
if web_probe "mail.$DOMAIN" "/api/folders" 401 "сервер приложения отвечает на /api"; then
    :
else
    hint "журнал: docker compose -f infra/docker-compose.yml logs --tail=50 api"
fi

# Статика интерфейса должна приходить целиком, иначе страница будет белой
ASSET="$(curl -sk --max-time 10 --resolve "mail.$DOMAIN:443:127.0.0.1" \
         "https://mail.$DOMAIN/" 2>/dev/null | grep -oE '/assets/[^"]+\.js' | head -1)"
if [ -n "$ASSET" ]; then
    web_probe "mail.$DOMAIN" "$ASSET" 200 "файлы сборки интерфейса отдаются"
else
    fail "в index.html почты не нашлось ссылки на файлы сборки"
fi

# ==================================================================
step "8. Безопасность и хранилище"
# ==================================================================

# Пароль в открытом виде без шифрования — в разработке удобно, в бою нельзя.
PLAIN_AUTH="$(dc exec -T dovecot doveconf -h disable_plaintext_auth 2>/dev/null | tr -d '\r')"
case "$PLAIN_AUTH" in
    yes) ok "IMAP/POP3 не принимают пароль без шифрования (disable_plaintext_auth = yes)" ;;
    no)
        warn "Dovecot принимает пароль без STARTTLS (disable_plaintext_auth = no)"
        hint "это настройка для разработки: пароль ходит по сети открытым текстом"
        hint "в infra/dovecot/conf/dovecot.conf.template поставьте"
        hint "  disable_plaintext_auth = yes"
        hint "и перезапустите: docker compose restart dovecot" ;;
    *) info "значение disable_plaintext_auth определить не удалось" ;;
esac

if [ -f "$ENV_FILE" ]; then
    PERM="$(stat -c '%a' "$ENV_FILE" 2>/dev/null)"
    if [ "$PERM" = "600" ]; then
        ok "права на infra/.env — 600 (пароли не видны другим пользователям)"
    else
        warn "права на infra/.env — $PERM, а должно быть 600"
        hint "chmod 600 $ENV_FILE"
    fi
    # Концы строк Windows в .env — поломка с самым обманчивым видом:
    # docker compose «\r» отбрасывает, контейнеры работают, а скрипты
    # обслуживания (установщик, копия, восстановление) получают значения
    # с невидимым хвостом и упираются в «role "mailserver" does not exist»
    # при полностью исправной базе. Сами скрипты теперь от этого защищены
    # (load_env в install/lib/common.sh), но файл всё равно надо починить:
    # его читает не только наш код.
    if grep -q $'\r' "$ENV_FILE"; then
        warn "в infra/.env концы строк Windows (CRLF) — это ломает скрипты обслуживания"
        hint "починить: sed -i 's/\\r\$//' $ENV_FILE"
    else
        ok "концы строк в infra/.env обычные (LF)"
    fi
    if grep -qE '^(POSTGRES_PASSWORD|REDIS_PASSWORD|RSPAMD_PASSWORD)=change-me' "$ENV_FILE"; then
        fail "в infra/.env остались пароли из примера (change-me-…)"
        hint "перезапустите установщик или поменяйте пароли вручную"
    else
        ok "пароли в infra/.env не из примера"
    fi
fi

# --- Пароль администратора не из примера ---------------------------
# В install/answers.example.env лежит заглушка «смените-этот-пароль».
# Она длиннее десяти символов и потому проходила проверку длины
# установщика — боевой сервер оставался с общеизвестным паролем, а
# самопроверка об этом молчала. Сверяем хэш из базы с заглушками.
ADMIN_LOGIN_SC=''
if [ -f "$STATE_FILE" ]; then
    ADMIN_LOGIN_SC="$(sed -n 's/^ADMIN_LOGIN=//p' "$STATE_FILE" | tail -1)"
fi
[ -n "$ADMIN_LOGIN_SC" ] || ADMIN_LOGIN_SC="${ADMIN_EMAIL%@*}"

ADMIN_HASH_SC="$(dc exec -T -e A_LOGIN="$ADMIN_LOGIN_SC" postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
           -v login="$A_LOGIN" -c "SELECT password_hash FROM admin_users WHERE login = :'"'"'login'"'"'"' \
    2>/dev/null | tr -d '\r' | head -1)"

if [ -z "$ADMIN_HASH_SC" ]; then
    warn "не удалось прочитать хэш пароля администратора «$ADMIN_LOGIN_SC» из базы"
    hint "проверьте, что учётная запись админки создана: install/install.sh"
else
    WEAK="$(printf '%s\n' "${MT_PLACEHOLDER_PASSWORDS[@]}" | \
        dc exec -T -e A_HASH="$ADMIN_HASH_SC" autoconfig node -e '
let list = "";
process.stdin.on("data", (c) => { list += c; });
process.stdin.on("end", () => {
  const { scryptSync, timingSafeEqual } = require("node:crypto");
  const parts = String(process.env.A_HASH || "").split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) { process.exit(0); }
  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const key = Buffer.from(keyB64, "base64url");
  for (const pw of list.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const got = scryptSync(pw.normalize("NFKC"), salt, key.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    if (got.length === key.length && timingSafeEqual(got, key)) {
      process.stdout.write(pw);
      return;
    }
  }
});' 2>/dev/null | tr -d '\r')"
    if [ -n "$WEAK" ]; then
        fail "пароль администратора «$ADMIN_LOGIN_SC» — заглушка из примера («$WEAK»)"
        hint "он открывает и админку, и ящик администратора; его знает любой,"
        hint "кто видел install/answers.example.env. Смените немедленно:"
        hint "  MAILTRUE_ADMIN_PASSWORD='свой-пароль' sudo bash install/install.sh"
    else
        ok "пароль администратора не из примера"
    fi
fi

# Тот же пароль-заглушка мог остаться и у почтового ящика
if dc exec -T dovecot doveadm auth test "$ADMIN_EMAIL" 'смените-этот-пароль' >/dev/null 2>&1; then
    fail "ящик $ADMIN_EMAIL открывается паролем-заглушкой из примера"
    hint "смените: bash infra/scripts/create-mailbox.sh $ADMIN_EMAIL 'свой-пароль'"
else
    ok "ящик администратора не открывается паролем-заглушкой"
fi

# --- Место на диске -------------------------------------------------
# Проверять только раздел с репозиторием было мало и вводило в заблуждение.
# Письма, база и очередь лежат НЕ там: они в томах docker, а его каталог
# (обычно /var/lib/docker) на серверах сплошь и рядом — отдельный раздел,
# причём меньший. Ровно этот раздел и кончается первым: том vmail растёт с
# каждым письмом. Когда он заполняется, Postfix перестаёт принимать почту,
# Postgres уходит в режим только чтения — а проверка показывала «свободно
# 200 ГБ», честно измеряя совсем другой диск.
check_disk() {   # check_disk <путь> <что это>
    local path="$1" what="$2" avail pct
    avail="$(df -BG --output=avail "$path" 2>/dev/null | tail -1 | tr -dc '0-9')"
    pct="$(df --output=pcent "$path" 2>/dev/null | tail -1 | tr -dc '0-9')"
    [ -n "${avail:-}" ] || return 0
    if [ "${pct:-0}" -ge 90 ]; then
        fail "$what: занято ${pct}% (свободно ${avail} ГБ)"
        hint "когда место кончится, почта перестанет приниматься, а база уйдёт в режим только чтения"
    elif [ "${pct:-0}" -ge 80 ]; then
        warn "$what: занято ${pct}% (свободно ${avail} ГБ)"
    else
        ok "$what: свободно ${avail} ГБ (занято ${pct:-?}%)"
    fi
}

check_disk "$REPO_DIR" "место на диске с репозиторием"

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
if [ -n "$DOCKER_ROOT" ] && [ -d "$DOCKER_ROOT" ]; then
    # Один и тот же раздел проверяем один раз: два одинаковых пункта в отчёте
    # выглядят как ошибка проверки, а не как забота.
    FS_REPO="$(df --output=source "$REPO_DIR" 2>/dev/null | tail -1)"
    FS_DOCKER="$(df --output=source "$DOCKER_ROOT" 2>/dev/null | tail -1)"
    if [ "$FS_REPO" != "$FS_DOCKER" ]; then
        check_disk "$DOCKER_ROOT" "место на диске с письмами и базой ($DOCKER_ROOT)"
    else
        info "письма и база лежат на том же разделе ($DOCKER_ROOT)"
    fi
else
    warn "не удалось узнать, где docker держит тома — место под письма не проверено"
    hint "docker info --format '{{.DockerRootDir}}'"
fi

if [ -d "$STATE_DIR" ] && [ -f "$STATE_DIR/last-backup" ]; then
    LAST="$(cat "$STATE_DIR/last-backup")"
    AGE=$(( ( $(date +%s) - $(date -d "$LAST" +%s 2>/dev/null || echo 0) ) / 86400 ))
    if [ "$AGE" -le 7 ]; then
        ok "последняя резервная копия: $LAST ($AGE дн. назад)"
    else
        warn "последняя резервная копия сделана $AGE дней назад ($LAST)"
        hint "sudo bash install/backup.sh"
    fi
else
    warn "резервных копий ещё не делали"
    hint "sudo bash install/backup.sh — и проверьте восстановление на тестовой машине"
fi

# ==================================================================
step "9. Схема базы соответствует версии продукта"
# ==================================================================
# Зачем отдельный пункт. Обновление продукта — это `git pull` и повторный
# запуск install.sh, который прогоняет каталог миграций. Если хоть одна не
# применилась (а причины бывают: место на диске, чужая блокировка, ручная
# правка схемы), стек всё равно поднимется и почта пойдёт. Молча отвалится
# только новое: отложенная отправка, отложенные письма, контакты, показатели.
# Человек увидит это как «кнопка не работает», и никакая другая проверка
# ему об этом не скажет.
#
# Список нужного берём из самих файлов миграций, а не из перечня в коде:
# перечень в коде всегда отстаёт от каталога — на этом уже обжигались.

WANT_TABLES="$(grep -hoiE 'CREATE TABLE IF NOT EXISTS +(public\.)?[a-z_0-9]+' \
    "$INFRA_DIR"/postgres/migrations/*.sql 2>/dev/null |
    awk '{ t = tolower($NF); sub(/^public\./, "", t); print t }' | sort -u)"

# Колонки, добавленные ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Часть
# нового (логотипы отправителей, оформление, отложенная отправка) — это
# именно колонки в существующих таблицах, отсутствие таблицы их не поймает.
WANT_COLUMNS="$(awk '
    tolower($0) ~ /alter[ \t]+table/ {
        line = tolower($0); sub(/.*alter[ \t]+table[ \t]+/, "", line)
        sub(/^public\./, "", line); sub(/[^a-z_0-9].*$/, "", line)
        tbl = line
    }
    tolower($0) ~ /add[ \t]+column[ \t]+if[ \t]+not[ \t]+exists/ {
        line = tolower($0); sub(/.*add[ \t]+column[ \t]+if[ \t]+not[ \t]+exists[ \t]+/, "", line)
        sub(/[^a-z_0-9].*$/, "", line)
        if (tbl != "" && line != "") print tbl "." line
    }
' "$INFRA_DIR"/postgres/migrations/*.sql 2>/dev/null | sort -u)"

HAVE_TABLES="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
    -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public'" \
    2>/dev/null | tr -d '\r' | sort -u)"
HAVE_COLUMNS="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA \
    -c "SELECT table_name || '.' || column_name FROM information_schema.columns WHERE table_schema='public'" \
    2>/dev/null | tr -d '\r' | sort -u)"

if [ -z "$HAVE_TABLES" ]; then
    fail "не удалось прочитать схему базы — проверьте доступность postgres"
else
    MISSING_T="$(comm -23 <(printf '%s\n' "$WANT_TABLES") <(printf '%s\n' "$HAVE_TABLES") | tr '\n' ' ')"
    MISSING_C="$(comm -23 <(printf '%s\n' "$WANT_COLUMNS") <(printf '%s\n' "$HAVE_COLUMNS") | tr '\n' ' ')"
    N_WANT_T="$(printf '%s\n' "$WANT_TABLES" | grep -c .)"
    N_WANT_C="$(printf '%s\n' "$WANT_COLUMNS" | grep -c .)"
    if [ -z "${MISSING_T// /}" ] && [ -z "${MISSING_C// /}" ]; then
        ok "все таблицы и колонки из миграций на месте ($N_WANT_T таблиц, $N_WANT_C добавленных колонок)"
    else
        [ -z "${MISSING_T// /}" ] || fail "в базе нет таблиц из миграций: $MISSING_T"
        [ -z "${MISSING_C// /}" ] || fail "в базе нет колонок из миграций: $MISSING_C"
        hint "миграции применились не полностью — прогнать заново:"
        hint "  sudo bash install/install.sh   (повторный запуск безопасен)"
        hint "разделы панели, которым нужно недостающее, будут отвечать ошибкой"
    fi
fi

# --- Служебный пользователь Dovecot ---------------------------------
# От него зависят две вещи, которые ломаются молча: вход администратора в
# чужой ящик из панели и сборщик почты с внешних ящиков. Пароль появился
# в продукте позже самой установки, и на серверах, обновлённых с ранних
# версий, в infra/.env его просто нет: Dovecot тогда оставляет файл
# служебных пользователей ПУСТЫМ (infra/dovecot/entrypoint.sh), а панель
# отвечает «неверный пароль» на верный пароль администратора.
if [ -z "${DOVECOT_MASTER_USER:-}" ] || [ -z "${DOVECOT_MASTER_PASSWORD:-}" ]; then
    fail "служебный пользователь Dovecot не настроен — вход администратора в чужой ящик не работает"
    hint "в infra/.env нет DOVECOT_MASTER_USER или DOVECOT_MASTER_PASSWORD."
    hint "заполнит повторный запуск: sudo bash install/install.sh"
else
    # Проверяем настоящим входом: файл может существовать и быть пустым.
    # Разделитель «*» — DOVECOT_MASTER_SEPARATOR по умолчанию.
    # shellcheck disable=SC2016
    if dc exec -T -e MU="$DOVECOT_MASTER_USER" -e MP="$DOVECOT_MASTER_PASSWORD" -e MB="$ADMIN_EMAIL" \
            dovecot sh -c 'doveadm auth test "$MB*$MU" "$MP"' >/dev/null 2>&1; then
        ok "служебный вход Dovecot работает (администратор может открыть чужой ящик)"
    else
        fail "служебный вход Dovecot не работает при заданном пароле"
        hint "пароль в infra/.env разошёлся с тем, что внутри контейнера."
        hint "перечитать: docker compose -f infra/docker-compose.yml up -d dovecot"
    fi
fi

# --- Посредник к очереди Postfix ------------------------------------
# Пустой QUEUE_AGENT_TOKEN — это не «настройка по умолчанию», а выключенный
# раздел «Очередь» в панели: посредник не запускается вовсе. Установщик
# долго не заполнял этот ключ, и на каждой установке с нуля раздел молча
# отсутствовал, а узнать об этом было неоткуда.
if [ -z "${QUEUE_AGENT_TOKEN:-}" ]; then
    fail "QUEUE_AGENT_TOKEN не задан — раздел «Очередь» в панели недоступен"
    hint "посредник к очереди Postfix не запускается без общего секрета."
    hint "задать и перезапустить:"
    hint "  printf 'QUEUE_AGENT_TOKEN=%s\\n' \"\$(openssl rand -hex 32)\" >> $ENV_FILE"
    hint "  docker compose -f infra/docker-compose.yml up -d postfix api"
else
    # Секрет посредник ждёт в заголовке X-Agent-Token (infra/postfix/queue-agent.pl):
    # без него любой путь отвечает 401, и wget вернёт пустоту.
    #
    # Секрет передаём переменной окружения контейнера, а не подстановкой в
    # строку команды: так он не попадает в список процессов на машине и не
    # зависит от кавычек. Спрашиваем ИЗ КОНТЕЙНЕРА api — важно проверить тот
    # самый путь, которым ходит панель, а не доступность порта с хоста
    # (наружу он и не публикуется).
    # shellcheck disable=SC2016
    QUEUE_HTTP="$(dc exec -T -e Q_TOKEN="$QUEUE_AGENT_TOKEN" -e Q_PORT="${QUEUE_AGENT_PORT:-11345}" api \
        sh -c 'wget -qO- --header="X-Agent-Token: $Q_TOKEN" "http://postfix:$Q_PORT/healthz" 2>/dev/null' \
        2>/dev/null | tr -d '\r')"
    case "$QUEUE_HTTP" in
        *ok*|*queue*) ok "посредник к очереди Postfix отвечает — раздел «Очередь» работает" ;;
        '')  fail "посредник к очереди Postfix не отвечает — раздел «Очередь» покажет ошибку"
             hint "смотрите: docker compose -f infra/docker-compose.yml logs postfix | grep queue-agent" ;;
        *)   warn "посредник к очереди ответил неожиданно: $QUEUE_HTTP" ;;
    esac
fi

# ==================================================================
step "Итог"
# ==================================================================
printf '  пройдено: %s%d%s   предупреждений: %s%d%s   не пройдено: %s%d%s\n\n' \
    "$C_GREEN" "$MT_PASS" "$C_OFF" "$C_YELLOW" "$MT_WARN" "$C_OFF" "$C_RED" "$MT_FAIL" "$C_OFF"

if [ "$MT_FAIL" -gt 0 ]; then
    printf '  Есть непройденные пункты — смотрите пометки «→» выше.\n\n'
    exit 1
fi
if [ "$MT_WARN" -gt 0 ]; then
    printf '  Критичных проблем нет, но есть на что посмотреть.\n\n'
fi
exit 0
