# Автоопределение настроек почтовых клиентов (apps/autoconfig)

Сервис, благодаря которому пользователь вводит в Thunderbird / Outlook /
Apple Mail только адрес ящика и пароль — остальные параметры клиент находит
сам. Обслуживает все три механизма автоопределения плюс профиль Apple и
страницу помощи для ручной настройки.

## Точки сервиса

| Метод | Путь | Кто ходит | Что отдаёт |
|-------|------|-----------|------------|
| GET | `/mail/config-v1.1.xml?emailaddress=…` | Thunderbird, K-9, FairEmail, Evolution | XML `clientConfig` 1.1: IMAP 993/143, POP3 995/110, SMTP 587 |
| GET | `/.well-known/autoconfig/mail/config-v1.1.xml` | Thunderbird (запасной путь) | то же |
| POST | `/autodiscover/autodiscover.xml` | Outlook (XML-запрос с `EMailAddress`) | XML со схемой Outlook: Protocol IMAP/POP3/SMTP |
| GET | `/autodiscover/autodiscover.xml?Email=…` | некоторые клиенты/проверялки | то же |
| GET | `/mobileconfig?email=…` | iPhone / macOS | `.mobileconfig` (XML plist, `application/x-apple-aspen-config`) — идентификаторы профиля и полезной нагрузки выводятся из адреса ящика |
| GET | `/api/dns-records?domain=…` | администратор | JSON + фрагмент зонного файла со всеми записями для публикации |
| GET | `/api/dns-check?domain=…` | администратор | живой резолв каждой записи: ok / mismatch / missing |
| GET | `/` | человек | страница помощи с таблицей серверов и портов |
| GET | `/healthz` | docker healthcheck | `{"ok":true}` |

Роутер нечувствителен к регистру пути: Outlook запрашивает и
`/Autodiscover/Autodiscover.xml` — оба варианта работают, XML-тело
принимается с любым Content-Type.

## Как ищут клиенты

- **Thunderbird**: `http(s)://autoconfig.<домен>/mail/config-v1.1.xml`,
  затем `http://<домен>/.well-known/autoconfig/mail/config-v1.1.xml`.
- **Outlook**: `https://<домен>/autodiscover/autodiscover.xml`, затем
  `https://autodiscover.<домен>/autodiscover/autodiscover.xml`, затем
  SRV `_autodiscover._tcp`.
- **Запасной путь для остальных** — SRV-записи RFC 6186
  (`_imaps._tcp`, `_submission._tcp`, `_pop3s._tcp`).

Nginx (infra/nginx/templates/autoconfig.conf.template) разводит хосты
`autoconfig.<домен>` и `autodiscover.<домен>` на сервис, а на корневом
домене проксирует `/.well-known/` и `/autodiscover/autodiscover.xml`
(регистронезависимо); корень `/` перенаправляется на страницу помощи.

## Конфигурация (переменные окружения)

Ничего не зашито; значения по умолчанию — для dev-домена `mail.local`.

| Переменная | По умолчанию | Смысл |
|------------|--------------|-------|
| `HOST` / `PORT` | `127.0.0.1` / `8080` | адрес HTTP-сервера (в docker — `0.0.0.0`) |
| `MAIL_DOMAIN` | `mail.local` | почтовый домен (часть адреса после `@`) |
| `MAIL_HOSTNAME` | `mail.local` | анонсируемый хост IMAP/POP3/SMTP |
| `PROVIDER_NAME` / `PROVIDER_SHORT_NAME` | `Mail.True` | имя в мастерах настройки |
| `IMAPS_PORT` / `IMAP_STARTTLS_PORT` | `993` / `143` | анонсируемые порты IMAP |
| `POP3S_PORT` / `POP3_STARTTLS_PORT` | `995` / `110` | анонсируемые порты POP3 |
| `SUBMISSION_PORT` | `587` | анонсируемый порт SMTP (STARTTLS) |
| `SUBMISSIONS_PORT` | `465` | анонсируемый порт SMTP («TLS сразу») |
| `DKIM_SELECTOR` | `mail` | селектор DKIM (как у rspamd) |
| `DKIM_DNS_DIR` | `/rspamd/dkim` | каталог с `<домен>.<селектор>.dns.txt` от rspamd |
| `DMARC_RUA` | `postmaster@<домен>` | адрес отчётов DMARC |
| `DNS_TTL` | `3600` | TTL в рекомендуемых записях |

**Как эти значения задаются на установке.** В таблице — имена внутри
контейнера. В `infra/.env` порты называются с приставкой `AUTOCONFIG_`
(`AUTOCONFIG_IMAPS_PORT`, `AUTOCONFIG_SUBMISSION_PORT` и т. д.), и
`infra/docker-compose.yml` подставляет их сюда. Приставка не косметика:
в том же файле уже есть `IMAPS_PORT`/`SUBMISSION_PORT`, и означают они
другое — порт публикации на ХОСТЕ. Анонсируемый порт обязан оставаться
стандартным даже там, где публикация сдвинута ради второго стенда;
раньше сюда не пробрасывалось ни одно значение вовсе, и настраиваемость
существовала только в схеме.

DKIM-ключ генерирует rspamd; autoconfig читает готовую DNS-запись из общего
тома `rspamd-data` (смонтирован read-only в `/rspamd`). Файлы `*.dns.txt`
сделаны world-readable в entrypoint rspamd (это публичные данные), приватный
ключ остаётся `600`.

## DNS-записи для боевой установки

Полный актуальный набор (с реальным DKIM-ключом) выдаёт
`GET /api/dns-records?domain=<домен>`; проверка публикации —
`GET /api/dns-check?domain=<домен>`. Состав:

```
@                  MX    10 <хост>.
@                  TXT   "v=spf1 mx ~all"
mail._domainkey    TXT   "v=DKIM1; k=rsa; p=<ключ из rspamd>"
_dmarc             TXT   "v=DMARC1; p=quarantine; rua=mailto:postmaster@<домен>; adkim=s; aspf=s"
autoconfig         CNAME <хост>.
autodiscover       CNAME <хост>.
_imaps._tcp        SRV   0 1 993 <хост>.
_submission._tcp   SRV   0 1 587 <хост>.
_pop3s._tcp        SRV   0 1 995 <хост>.
_autodiscover._tcp SRV   0 0 443 <хост>.
```

Плюс обычная A-запись `<хост>` → IP сервера и валидный TLS-сертификат,
покрывающий `<домен>`, `autoconfig.<домен>` и `autodiscover.<домен>`
(Outlook требует HTTPS без ошибок сертификата).

### Как проверяется CNAME

Вместо `CNAME autoconfig → <хост>` многие панели DNS публикуют обычную
A-запись — это допустимо, но только если адрес совпадает с адресом нашего
сервера. Проверка резолвит A-запись имени и A-запись `MAIL_HOSTNAME` и
сравнивает адреса:

- адреса пересекаются → `ok`;
- не пересекаются → `mismatch` с обоими наборами адресов в комментарии
  («клиенты уйдут на чужой сервер»);
- адрес самого `MAIL_HOSTNAME` не резолвится → `error` («сравнить не с чем»),
  но не `ok`.

Раньше на этой ветке безусловно возвращалось `ok`: и админка, и
`install/selfcheck.sh` показывали зелёный статус для совершенно
постороннего сервера — типичная ситуация, когда записи опубликованы адресом
или осталась запись прежнего провайдера, а Outlook при этом уходил не туда.

`checkDns()` принимает необязательный четвёртый параметр — резольвер
(`DnsResolverLike`), чтобы проверку можно было прогнать на подставном DNS.

## Профиль Apple

`PayloadIdentifier` профиля и полезной нагрузки — свой у каждого ящика
(`<обратный домен>.mailprofile.<UUID из адреса>`). iOS и macOS считают
профили с одинаковым `PayloadIdentifier` одним и тем же и **заменяют**
ранее установленный: с константой в этом поле установка профиля для второго
ящика того же сервера сносила первый вместо добавления. Идентификаторы
детерминированы: повторная установка профиля того же ящика обновляет
существующий, а не плодит копии.

## POP3

Автонастройка анонсирует POP3, поэтому он включён в Dovecot
(`infra/dovecot`): пакет `dovecot-pop3d`, `protocols = imap pop3 lmtp`,
порты 110 (STARTTLS; в dev разрешён PLAIN) и 995 (SSL) опубликованы
в docker-compose.

## Разработка и проверка

```bash
# юнит-тесты (сборка типов + node --test, XML проверяется разбором jsdom)
npm test --workspace @mail-true/autoconfig

# живой smoke: обходит все точки, XML валидируется разбором
node apps/autoconfig/dist/smoke.js http://127.0.0.1:8025                       # напрямую
node apps/autoconfig/dist/smoke.js http://127.0.0.1:8080 autoconfig.mail.local # через nginx
node apps/autoconfig/dist/smoke.js http://127.0.0.1:8080 autodiscover.mail.local

# порты в dev (infra/.env): autoconfig 8025, nginx 8080 (http) / 8443 (https)
```

Сборка образа: контекст — корень репозитория (нужен `tsconfig.base.json`),
Dockerfile — `apps/autoconfig/Dockerfile`, две стадии (tsc → рантайм без
dev-зависимостей, пользователь `node`).
