# Инфраструктура Mail.True: почтовый стек в Docker

Стек для локальной разработки (и как основа для прода на Ubuntu Server 22).
Всё лежит в `infra/`, поднимается одной командой.

## Быстрый старт

```bash
cp infra/.env.example infra/.env      # поменять пароли при необходимости
bash infra/scripts/gen-certs.sh       # самоподписанные TLS-сертификаты (dev)
docker compose -f infra/docker-compose.yml up -d
bash infra/scripts/create-mailbox.sh test@mail.local test12345
bash infra/test-delivery.sh           # сквозная проверка доставки
```

## Состав стека

| Сервис     | Образ                                                | Назначение                                                                                                                                                                       |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unbound    | сборка `infra/unbound` (alpine)                      | Свой рекурсивный DNS-резольвер (`172.28.0.53`). Без него бесплатные списки Spamhaus/URIBL отказываются отвечать — см. `docs/antispam.md`                                         |
| postgres   | postgres:16-alpine                                   | Виртуальные домены/ящики/алиасы (схема в `infra/postgres/migrations/`)                                                                                                           |
| redis      | redis:7-alpine                                       | Сессии, кэш, очереди веб-приложения; статистика rspamd                                                                                                                           |
| dovecot    | сборка `infra/dovecot` (debian bookworm)             | IMAP 143/993, LMTP :24, SASL-auth :12345, quota-status :12340, Maildir, полнотекстовый поиск (FTS Xapian) и квоты — см. `docs/search.md`                                         |
| postfix    | сборка `infra/postfix` (debian bookworm)             | SMTP :25 (приём), submission :587 (STARTTLS+SASL)                                                                                                                                |
| rspamd     | сборка `infra/rspamd` (rspamd/rspamd)                | Антиспам (milter :11332), DKIM-подпись, веб-UI :11334                                                                                                                            |
| autoconfig | сборка `apps/autoconfig/Dockerfile` (node:24-alpine) | Автоопределение настроек клиентов: Mozilla Autoconfig, MS Autodiscover, .mobileconfig, DNS-записи (см. `docs/autoconfig.md`)                                                     |
| api        | сборка `apps/api/Dockerfile` (alpine + node)         | Сервер приложения: HTTP API `/api/*` и WebSocket `/ws`. Ходит в Dovecot по IMAP от имени пользователя, отправляет через submission Postfix, сессии в Redis, настройки в Postgres |
| web        | сборка `apps/web/Dockerfile` (nginx:1.27-alpine)     | Собранный Vite веб-интерфейс почты (статика)                                                                                                                                     |
| admin      | сборка `apps/admin/Dockerfile` (nginx:1.27-alpine)   | Собранная Vite админка (статика)                                                                                                                                                 |
| nginx      | nginx:1.27-alpine                                    | Единственный вход HTTP/HTTPS: почта (`<домен>`, `mail.<домен>`), админка (`admin.<домен>`), автонастройка (`autoconfig.<домен>`, `autodiscover.<домен>`, `/.well-known/`)        |
| clamav     | clamav/clamav:1.4_base                               | Антивирус. **Выключен по умолчанию** (профиль `clamav`): с базами занимает ~1 ГБ памяти. Включение — `CLAMAV_ENABLED=true` + `--profile clamav`, см. `docs/antispam.md`          |
| service-agent | сборка `infra/service-agent` (docker:cli + perl)  | Единственная служба с сокетом Docker. Умеет закрытый список операций над закрытым списком служб; подробности ниже                                                                 |
| fail2ban   | сборка `infra/fail2ban` (debian bookworm)            | Защита от подбора паролей: читает журналы и закрывает адресу доступ ко всем портам. Сеть хоста + NET_ADMIN, включена по умолчанию — см. `docs/install.md`                        |

### Посредник служб (`service-agent`)

Сокет Docker равносилен правам root на всей машине, и серверу приложения —
тому, что принимает запросы из интернета и разбирает чужие письма, — его
давать нельзя. Поэтому сокет выдан отдельной службе на Perl (`agent.pl`),
у которой:

- **закрытый список служб** (`%SERVICES`) и разрешённых над ними действий:
  перезапуск и пересоздание. Имя из запроса не подставляется в команду —
  оно ищется в списке, и наружу идёт значение ключа списка, а не строка
  клиента;
- **закрытый список ключей** `infra/.env`, свой у каждой службы (`%ENV_KEYS`):
  записать пароль базы «через autoconfig» посредник не даст — такого ключа в
  его списке нет. Держите **по одной записи на службу**: в Perl побеждает
  последняя, и вторая запись молча отменяет разрешения первой;
- **никакой сборки образов**: у compose всегда стоит `--no-build`. Сборка
  выполняла бы Dockerfile из каталога проекта, то есть была бы обходным путём
  к «выполнить что угодно»;
- **общий секрет** `SERVICE_AGENT_TOKEN` в заголовке каждого запроса; без
  секрета в окружении посредник не открывает порт вовсе.

Операции: `/healthz`, `/status`, `/restart`, `/recreate`, `/stack` (состояние
и память контейнеров), `/dkim` (готовая DNS-запись подписи), `/certbot`
(выпуск Let's Encrypt через webroot), `/env-unset` (убрать ключ при возврате
настройки к умолчанию), `/audit` (на каких адресах слушают порты и права
`infra/.env` — только вердикты и числа, без значений).

## Порты на хосте (все на 127.0.0.1)

| Порт  | Сервис     | Протокол                                                                                       |
| ----- | ---------- | ---------------------------------------------------------------------------------------------- |
| 25    | postfix    | SMTP (приём входящей почты)                                                                    |
| 587   | postfix    | Submission: STARTTLS + SASL (PLAIN/LOGIN)                                                      |
| 143   | dovecot    | IMAP (STARTTLS; в dev разрешён PLAIN)                                                          |
| 993   | dovecot    | IMAPS                                                                                          |
| 110   | dovecot    | POP3 (STARTTLS; в dev разрешён PLAIN)                                                          |
| 995   | dovecot    | POP3S                                                                                          |
| 8025  | autoconfig | Сервис автонастройки напрямую (отладка)                                                        |
| 3000  | api        | Сервер приложения напрямую (отладка). На боевом сервере не публикуется вовсе                   |
| 8080  | nginx      | HTTP: почта, админка, autoconfig/autodiscover/.well-known                                      |
| 8443  | nginx      | HTTPS (self-signed dev-сертификат)                                                             |
| 5432  | postgres   | PostgreSQL (для веб-приложения)                                                                |
| 6380  | redis      | Redis (**6380**, т.к. 6379 на dev-машине занят чужим Redis; внутри docker-сети — `redis:6379`) |
| 11334 | rspamd     | Веб-интерфейс/API rspamd (пароль `RSPAMD_PASSWORD`)                                            |
| 8081  | nginx      | Резервный вход в панель по адресу сервера, без DNS. Слушает только там, куда его привязали (`ADMIN_LOCAL_BIND`, по умолчанию 127.0.0.1), и отвечает только частным сетям |

Порт посредника служб (`SERVICE_AGENT_PORT`, по умолчанию 11346) наружу не
публикуется вовсе: к нему обращается только сервер приложения изнутри сети
стека. Публикация свела бы на нет всю затею с закрытым списком операций.

## Веб-интерфейс: кто что отдаёт

Разделение по именам хостов, а не по путям:

| Имя хоста                                    | Что отдаётся                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `<домен>`, `mail.<домен>` (и default_server) | статика почты из `web`; `/api/*` и `/ws` — в `api`; `/.well-known/` и `/autodiscover/autodiscover.xml` — в `autoconfig` |
| `admin.<домен>`                              | статика админки из `admin`; `/api/admin/*` — в `api`, всё остальное из `/api/` отвечает 404                             |
| `autoconfig.<домен>`, `autodiscover.<домен>` | целиком в `autoconfig`                                                                                                  |

Почему по именам, а не по путям: оба приложения собраны Vite с базой «/»
(ссылки на файлы сборки абсолютные) и используют `createBrowserRouter`
без `basename`. Отдать админку по пути `/admin/` можно было бы только
правкой исходного кода обоих приложений. Разные имена дают то же самое
бесплатно и попутно разводят cookie почты (`mt_session`) и админки
(`mt_admin`), а админку позволяют закрыть отдельно от почты.

Заголовки и кэширование:

- Файлы с хешем в имени (`/assets/index-*.js`) — `Cache-Control: public,
max-age=31536000, immutable`; `index.html` — `no-cache`. Заголовки ставит
  тот nginx, что лежит внутри образа `web`/`admin`: он знает, у какого
  файла хеш в имени есть, а у какого нет.
- Сжатие статики — там же, внутри образа; фронтовый nginx передаёт уже
  сжатое тело как есть и дополнительно жмёт только ответы API.
- Заголовки безопасности (CSP, HSTS по HTTPS, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) ставит
  фронтовый nginx — `infra/nginx/templates/app.conf.template`.
- `X-Forwarded-For` фронтовый nginx **перезаписывает** значением
  `$remote_addr`, а не дописывает к присланному клиентом. Иначе первым в
  списке оставалось бы значение клиента, и подменой заголовка обходилось
  бы ограничение частоты запросов (защита от подбора пароля) и
  подделывался адрес в журнале аудита. С той же целью в API стоит
  `TRUSTED_PROXIES` — список сетей, которым верят.
- Апстримы `api`/`web`/`admin` разрешаются встроенным DNS Docker на каждом
  запросе (`resolver 127.0.0.11`), а не один раз при старте: иначе после
  пересоздания контейнеров nginx отвечал бы 502 до собственного
  перезапуска — то есть каждое обновление ломало бы почту в браузере.

## Сеть

Стек живёт в собственной подсети `${DOCKER_SUBNET}` (по умолчанию
`172.28.0.0/16`) — явная подсеть нужна, чтобы у резольвера был фиксированный
адрес `${RESOLVER_IP}` (`172.28.0.53`): docker-опция `dns:` принимает только IP.
Через этот адрес весь внешний DNS запрашивают `rspamd` и `postfix`. Имена
контейнеров резолвит встроенный DNS Docker, поэтому доставка почты не зависит
от резольвера.

## Как проходит письмо

- **Входящее**: клиент → postfix:25 → milter rspamd (антиспам, заголовки
  X-Spam*) → LMTP `dovecot:24` → Maildir `/var/mail/vhosts/<домен>/<логин>/`
  (named volume `mailtrue_vmail`).
- **Исходящее**: клиент → postfix:587 (STARTTLS обязателен, SASL через
  `dovecot:12345`) → rspamd подписывает DKIM (`d=mail.local; s=mail`) → очередь
  postfix → доставка (в dev — обратно в локальные ящики).
- Postfix проверяет домены/ящики/алиасы запросами к Postgres
  (`infra/postfix/conf/pgsql/*.template`, таблицы `virtual_domains`,
  `virtual_users`, `virtual_aliases`).
- Dovecot аутентифицирует по `virtual_users.password` — хэш в формате dovecot
  (`{SHA512-CRYPT}$6$...` или `{ARGON2ID}...`).

## Схема БД (`infra/postgres/migrations/0001_baseline.sql`)

- `virtual_domains(id, name, created_at)`
- `virtual_users(id, domain_id, email, password, display_name, quota_bytes, active, ...)`
- `virtual_aliases(id, domain_id, source, destination, active, ...)`

Вся схема — полсотни таблиц — описана одним файлом `0001_baseline.sql`,
каждая таблица в окончательном виде. Раньше она была размазана по 36
файлам-шагам, и чтобы понять состав одной таблицы, приходилось складывать
в уме несколько `ALTER TABLE` из разных файлов. Разбор свёртки — в шапке
самого файла.

Что лежит в каталоге:

| Файл | Зачем |
|---|---|
| `0000_schema_migrations.sql` | журнал применённого; обязан быть первым по имени |
| `0001_baseline.sql` | вся схема разом |
| `0002_seed_domain.sh` | основной домен и его настройки при установке с нуля |
| `legacy/` | 35 старых файлов-шагов; нужны только для сервера, пропустившего обновления |
| `0003_*.sql` и далее | новые изменения схемы — обычными миграциями |

`0001_baseline.sql` после выпуска **не правится**. На всех работающих
серверах он отмечен применённым и выполняться не будет, поэтому правка в
нём доедет только до тех, кто ставит сервер с нуля, — и схемы разойдутся
молча. Любое изменение — новый файл со следующим номером.

Каталог выполняет сам Postgres, но только при **первичной** инициализации
пустого тома `pgdata`. На уже созданной БД миграции накатывает установщик
(`apply_migrations` в `install/lib/common.sh`), и он же ведёт журнал —
см. «Журнал применённых миграций» в `docs/install.md`. Вручную одиночный
файл применяется так:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U mailserver -d mailserver < infra/postgres/migrations/000X_*.sql
```

Базовую схему руками применять не нужно: на работающей базе она ничего не
даст (всё уже создано), а на пустой её накатит установщик.

## Создание ящика

```bash
bash infra/scripts/create-mailbox.sh user@mail.local 'пароль' [SHA512-CRYPT|ARGON2ID]
```

Скрипт хэширует пароль через `doveadm pw` в контейнере dovecot и делает
идемпотентный INSERT/UPDATE в Postgres (домен создаётся при необходимости).
Веб-приложение может делать то же самое напрямую: INSERT в `virtual_users`
с хэшем `{SHA512-CRYPT}$6$...` (генерация: `crypt(3)` sha512 или libsodium argon2id).

## Секреты и конфигурация

- Все параметры — в `infra/.env` (не коммитится; образец `infra/.env.example`).
- Конфиги postfix/dovecot — шаблоны в `infra/postfix/conf/`,
  `infra/dovecot/conf/`; при старте контейнера entrypoint подставляет секреты
  (`envsubst`) и кладёт результат внутрь контейнера. После правки шаблона:
  `docker compose restart postfix` (или `dovecot`).
- Конфиги rspamd — `infra/rspamd/local.d/` (монтируются как есть); секреты
  (пароль redis, пароль UI, DKIM-селектор) и адрес резольвера entrypoint пишет
  в `override.d` внутри контейнера.
- Белые/чёрные списки антиспама — `infra/rspamd/maps.d/*.map`, примонтированы
  **на запись**: их правит админка, rspamd перечитывает карты сам (10 секунд).
  Пороги — `infra/rspamd/local.d/actions.conf`. Подробности — `docs/antispam.md`.
- Конфиг резольвера — `infra/unbound/unbound.conf` (монтируется read-only),
  часть параметров генерирует entrypoint из переменных окружения.
- TLS-сертификаты: `infra/data/certs/` (в .gitignore), генерация
  `infra/scripts/gen-certs.sh [--force]`. CN=mail.local + SAN localhost.
- DKIM-ключи: named volume `mailtrue_rspamd-data`
  (`/var/lib/rspamd/dkim/mail.local.mail.key`); готовая DNS TXT-запись — рядом
  в `mail.local.mail.dns.txt`.
- Почта: named volume `mailtrue_vmail` (Maildir, владелец vmail 5000:5000).
  Тот же том примонтирован в `api`: туда кладутся личные правила
  фильтрации (`SIEVE_TRANSPORT=local`). Поэтому процесс `api` работает
  под uid 5000 — тем же, что у Dovecot.
- Временные вложения веб-интерфейса: named volume `mailtrue_api-uploads`
  (файл живёт от загрузки до отправки письма).
- Секреты приложения (`SESSION_SECRET`, `ADMIN_SESSION_SECRET`,
  `AI_ENCRYPTION_KEY`, `EXTERNAL_ACCOUNTS_KEY`) — только в `infra/.env`;
  в compose они подставляются переменными, в открытом виде их нет нигде.
  Без `SESSION_SECRET` стек намеренно не поднимается.
- **Перевыпуск секретов из панели.** Три из них выпускаются заново кнопкой
  («Настройки сервера» → «Перевыпуск секретов»): `SESSION_SECRET`,
  `QUEUE_AGENT_TOKEN`, `RSPAMD_PASSWORD`. Значение рождается на сервере,
  уходит в `infra/.env` через посредника и не показывается никому — ни в
  ответе, ни в журнале аудита.

  Ключи шифрования кнопкой **не** перевыпускаются: `ADMIN_SESSION_SECRET`,
  `AI_ENCRYPTION_KEY`, `EXTERNAL_ACCOUNTS_KEY` закрывают уже записанное в
  базу (пароли импорта, пароли заданий переноса, ключи доступа к сервисам
  ИИ, приватный ключ DKIM при смене домена). Новый ключ не меняет замок, а
  делает содержимое нечитаемым навсегда.

  Отдельная тонкость: `ADMIN_SESSION_SECRET` — вопреки имени НЕ подпись
  сессий панели (cookie обеих частей подписаны общим `SESSION_SECRET`), а
  ключ шифрования. Если он не задан, шифрование идёт на `SESSION_SECRET`, и
  тогда перевыпуск подписи сессий отказывает — иначе он унёс бы с собой
  расшифровку данных.
- **База стран для проверки входа** (необязательная): `infra/data/geoip/`,
  смонтирована в `api` как `/srv/geoip` только на чтение. Скачивается
  отдельно — `install/fetch-geoip.sh` (DB-IP Country Lite, CC BY 4.0).
  Управляется `GEOIP_LOGIN_POLICY` (`off`/`log`/`allow`) и
  `GEOIP_ALLOWED_COUNTRIES`. Без базы вход работает как раньше.
- **Подтверждение домена для Let's Encrypt**: named volume
  `mailtrue_acme-challenge`. Файл кладёт certbot (одноразовым контейнером
  через посредника), а раздаёт nginx по `/.well-known/acme-challenge/` —
  поэтому выпуск сертификата из панели не гасит веб-вход.
- Индексы Dovecot, включая полнотекстовый индекс Xapian: named volume
  `mailtrue_mailindex` (`/var/mail/index/<домен>/<логин>/xapian-indexes`).
  Вынесены из Maildir, чтобы не попадать в подсчёт квоты; переживают
  пересоздание контейнера.

## Тестирование

`bash infra/test-fts-quota.sh` — повторяемый тест полнотекстового поиска и квот:
поиск по теме/телу/адресу/словоформе/букве ё, поиск по содержимому PDF и DOCX,
замер скорости на 120 письмах, переиндексация, сохранность индекса после
перезапуска, лимит из Postgres, IMAP GETQUOTAROOT, предупреждение о заполнении,
отказ 552 5.2.2 при переполнении и отказ Postfix на RCPT TO. Подробности —
`docs/search.md`.

`bash infra/test-antispam.sh` — повторяемая проверка антиспама: свой резольвер
и контрольные точки Spamhaus/URIBL/SURBL (с показом того, что через публичный
резольвер они отвечают отказом), реальная сработка списка в rspamd, GTUBE →
пометка спама, обычное деловое письмо → без пометки, письмо своего своему →
без обращений к внешним спискам, работа почты при остановленном резольвере,
пороги и веса, белые/чёрные списки админки, состояние антивируса, замер памяти.
Подробности — `docs/antispam.md`.

`bash infra/test-delivery.sh` — повторяемый сквозной тест:
статусы сервисов → создание `test@mail.local` → приём по SMTP:25 → доставка
LMTP в Maildir → чтение по IMAP (тема+тело) → отправка через 587 c
STARTTLS+SASL → проверка DKIM-подписи → отказ при неверном пароле.
Выход 0 = всё зелёное.

## Полезные команды

```bash
docker compose -f infra/docker-compose.yml ps            # статусы
docker compose -f infra/docker-compose.yml logs -f postfix
docker compose -f infra/docker-compose.yml exec dovecot doveadm search -u test@mail.local mailbox INBOX  # письма ящика
docker compose -f infra/docker-compose.yml exec dovecot doveadm quota get -u test@mail.local             # занятое место/лимит
bash infra/scripts/fts-reindex.sh [--purge] [ящик]                                                       # переиндексация поиска
docker compose -f infra/docker-compose.yml exec postgres psql -U mailserver mailserver                   # SQL-консоль
bash install/selfcheck.sh                                                                                # полная проверка сервера
bash install/fetch-geoip.sh                                                                              # база стран для проверки входа
docker compose -f infra/docker-compose.yml exec fail2ban fail2ban-client status                          # какие камеры работают
docker compose -f infra/docker-compose.yml exec fail2ban fail2ban-client status mailtrue-dovecot         # кто забанен
docker compose -f infra/docker-compose.yml exec fail2ban fail2ban-client unban <адрес>                   # снять бан
```

Проверить, что бан действительно действует (а не просто числится): правило
обязано стоять в цепочке `DOCKER-USER` — трафик к портам контейнеров идёт
через неё, а не через `INPUT`.

```bash
docker compose -f infra/docker-compose.yml exec fail2ban fail2ban-client set mailtrue-dovecot banip 203.0.113.7
iptables -n -L DOCKER-USER | grep f2b-
docker compose -f infra/docker-compose.yml exec fail2ban fail2ban-client unban 203.0.113.7
```

## Отличия dev от прода (что поменять на Ubuntu Server 22)

- Сертификаты: заменить самоподписанные на Let's Encrypt — при установке,
  кнопкой в панели («Сертификат» → «Выпустить Let's Encrypt») или своим
  сертификатом там же.
- `disable_plaintext_auth = yes` в dovecot (сейчас `no` для удобства dev).
- Публиковать порты на внешний интерфейс (сейчас всё на 127.0.0.1).
- Прописать DNS: MX, SPF, DMARC и DKIM TXT из `*.dns.txt`, плюс `mail.<домен>`
  и `admin.<домен>` для веб-интерфейса.
- Redis снова на стандартный 6379 (на dev-машине он был занят).
- `COOKIE_SECURE=true` (cookie сессии только по HTTPS) и отладочный порт
  сервера приложения не публикуется — `install/compose.prod.yml` делает и то,
  и другое сам.

Всё перечисленное `install/install.sh` выполняет автоматически — список
нужен тому, кто поднимает прод руками.
