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

| Сервис   | Образ                | Назначение                                             |
|----------|----------------------|--------------------------------------------------------|
| unbound  | сборка `infra/unbound` (alpine) | Свой рекурсивный DNS-резольвер (`172.28.0.53`). Без него бесплатные списки Spamhaus/URIBL отказываются отвечать — см. `docs/antispam.md` |
| postgres | postgres:16-alpine   | Виртуальные домены/ящики/алиасы (схема в `infra/postgres/migrations/`) |
| redis    | redis:7-alpine       | Сессии, кэш, очереди веб-приложения; статистика rspamd |
| dovecot  | сборка `infra/dovecot` (debian bookworm) | IMAP 143/993, LMTP :24, SASL-auth :12345, quota-status :12340, Maildir, полнотекстовый поиск (FTS Xapian) и квоты — см. `docs/search.md` |
| postfix  | сборка `infra/postfix` (debian bookworm) | SMTP :25 (приём), submission :587 (STARTTLS+SASL) |
| rspamd   | сборка `infra/rspamd` (rspamd/rspamd)    | Антиспам (milter :11332), DKIM-подпись, веб-UI :11334 |
| autoconfig | сборка `apps/autoconfig/Dockerfile` (node:24-alpine) | Автоопределение настроек клиентов: Mozilla Autoconfig, MS Autodiscover, .mobileconfig, DNS-записи (см. `docs/autoconfig.md`) |
| api      | сборка `apps/api/Dockerfile` (alpine + node) | Сервер приложения: HTTP API `/api/*` и WebSocket `/ws`. Ходит в Dovecot по IMAP от имени пользователя, отправляет через submission Postfix, сессии в Redis, настройки в Postgres |
| web      | сборка `apps/web/Dockerfile` (nginx:1.27-alpine) | Собранный Vite веб-интерфейс почты (статика) |
| admin    | сборка `apps/admin/Dockerfile` (nginx:1.27-alpine) | Собранная Vite админка (статика) |
| nginx    | nginx:1.27-alpine    | Единственный вход HTTP/HTTPS: почта (`<домен>`, `mail.<домен>`), админка (`admin.<домен>`), автонастройка (`autoconfig.<домен>`, `autodiscover.<домен>`, `/.well-known/`) |
| clamav   | clamav/clamav:1.4_base | Антивирус. **Выключен по умолчанию** (профиль `clamav`): с базами занимает ~1 ГБ памяти. Включение — `CLAMAV_ENABLED=true` + `--profile clamav`, см. `docs/antispam.md` |

## Порты на хосте (все на 127.0.0.1)

| Порт | Сервис  | Протокол                                   |
|------|---------|--------------------------------------------|
| 25   | postfix | SMTP (приём входящей почты)                |
| 587  | postfix | Submission: STARTTLS + SASL (PLAIN/LOGIN)  |
| 143  | dovecot | IMAP (STARTTLS; в dev разрешён PLAIN)      |
| 993  | dovecot | IMAPS                                      |
| 110  | dovecot | POP3 (STARTTLS; в dev разрешён PLAIN)      |
| 995  | dovecot | POP3S                                      |
| 8025 | autoconfig | Сервис автонастройки напрямую (отладка) |
| 3000 | api     | Сервер приложения напрямую (отладка). На боевом сервере не публикуется вовсе |
| 8080 | nginx   | HTTP: почта, админка, autoconfig/autodiscover/.well-known |
| 8443 | nginx   | HTTPS (self-signed dev-сертификат)         |
| 5432 | postgres| PostgreSQL (для веб-приложения)            |
| 6380 | redis   | Redis (**6380**, т.к. 6379 на dev-машине занят чужим Redis; внутри docker-сети — `redis:6379`) |
| 11334| rspamd  | Веб-интерфейс/API rspamd (пароль `RSPAMD_PASSWORD`) |

## Веб-интерфейс: кто что отдаёт

Разделение по именам хостов, а не по путям:

| Имя хоста | Что отдаётся |
|---|---|
| `<домен>`, `mail.<домен>` (и default_server) | статика почты из `web`; `/api/*` и `/ws` — в `api`; `/.well-known/` и `/autodiscover/autodiscover.xml` — в `autoconfig` |
| `admin.<домен>` | статика админки из `admin`; `/api/admin/*` — в `api`, всё остальное из `/api/` отвечает 404 |
| `autoconfig.<домен>`, `autodiscover.<домен>` | целиком в `autoconfig` |

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

## Схема БД (`infra/postgres/migrations/0001_init.sql`)

- `virtual_domains(id, name, created_at)`
- `virtual_users(id, domain_id, email, password, display_name, quota_bytes, active, ...)`
- `virtual_aliases(id, domain_id, source, destination, active, ...)`

Миграции применяются автоматически только при **первичной** инициализации
пустого тома `pgdata`. Для уже созданной БД — вручную:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U mailserver -d mailserver < infra/postgres/migrations/000X_*.sql
```

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
```

## Отличия dev от прода (что поменять на Ubuntu Server 22)

- Сертификаты: заменить самоподписанные на Let's Encrypt.
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
