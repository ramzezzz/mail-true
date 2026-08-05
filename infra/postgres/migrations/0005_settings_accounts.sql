-- Миграция 0005: настройки почтового ящика, правила фильтрации и
-- подключение чужих ящиков по IMAP.
--
-- Ничего не меняет в virtual_domains / virtual_users / virtual_aliases —
-- это контракт с Postfix и Dovecot. Добавляются только новые таблицы,
-- поэтому миграцию безопасно применять к УЖЕ РАБОТАЮЩЕЙ базе:
--
--   docker compose -f infra/docker-compose.yml exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U mailserver -d mailserver \
--     < infra/postgres/migrations/0005_settings_accounts.sql
--
-- Скрипт идемпотентен (IF NOT EXISTS везде), повторное применение безвредно.
--
-- Связь с ящиками — по адресу (account_email), а не по virtual_users.id:
-- ящик может обслуживаться алиасным доменом, а настройки должны пережить
-- пересоздание строки пользователя. Внешний ключ поэтому не ставится,
-- вместо него — удаление настроек вместе с ящиком делает админка.
--
-- ПАРОЛИ ЧУЖИХ ЯЩИКОВ хранятся ТОЛЬКО в зашифрованном виде (password_enc,
-- AES-256-GCM). Ключ шифрования берётся из переменной окружения
-- EXTERNAL_ACCOUNTS_KEY и рядом с базой не лежит: дамп базы без этой
-- переменной бесполезен. Открытого пароля в схеме нет ни одного столбца.

BEGIN;

-- ------------------------------------------------------------------
-- Общие настройки ящика (раздел «Общие» в интерфейсе настроек).
-- Строки нет — значит всё по умолчанию; это нормальное состояние,
-- а не ошибка. Настройки создаются при первом сохранении.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_user_settings (
    account_email          VARCHAR(320) PRIMARY KEY,

    -- Имя отправителя: подставляется в заголовок From.
    sender_name            VARCHAR(255),

    -- Отправка писем: включать содержимое исходного письма в ответ.
    reply_quote            BOOLEAN NOT NULL DEFAULT TRUE,

    -- Что делать после удаления письма: 'list' — вернуться к списку,
    -- 'next' — открыть следующее письмо.
    after_delete           VARCHAR(8) NOT NULL DEFAULT 'list',

    -- Уведомления: в браузере и счётчик во вкладке.
    notify_browser         BOOLEAN NOT NULL DEFAULT FALSE,
    notify_tab             BOOLEAN NOT NULL DEFAULT TRUE,

    -- Адресная книга: автоматически пополнять контакты.
    collect_contacts       BOOLEAN NOT NULL DEFAULT TRUE,

    -- Автоответчик. Срок действия — необязательный, NULL = без границы.
    autoreply_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    autoreply_subject      VARCHAR(255),
    autoreply_text         TEXT NOT NULL DEFAULT '',
    autoreply_from         TIMESTAMPTZ,
    autoreply_until        TIMESTAMPTZ,
    -- Как часто повторно отвечать одному и тому же адресату (Sieve vacation :days).
    autoreply_days         INT NOT NULL DEFAULT 7,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT mail_user_settings_after_delete_check
        CHECK (after_delete IN ('list', 'next')),
    CONSTRAINT mail_user_settings_autoreply_days_check
        CHECK (autoreply_days BETWEEN 1 AND 365)
);

-- ------------------------------------------------------------------
-- Подписи. Их несколько, одна помечена как подпись по умолчанию.
-- Единственность «по умолчанию» держится частичным уникальным индексом,
-- а не проверкой в коде: два умолчания — состояние, которое интерфейс
-- показать не сможет.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_signatures (
    id             BIGSERIAL PRIMARY KEY,
    account_email  VARCHAR(320) NOT NULL,
    name           VARCHAR(255) NOT NULL DEFAULT '',
    body_html      TEXT NOT NULL DEFAULT '',
    is_default     BOOLEAN NOT NULL DEFAULT FALSE,
    position       INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mail_signatures_account
    ON mail_signatures (lower(account_email), position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_signatures_default
    ON mail_signatures (lower(account_email)) WHERE is_default;

-- ------------------------------------------------------------------
-- Правила фильтрации. Транслируются в Sieve и кладутся в личный файл
-- правил пользователя (см. apps/api/src/settings/sieve.ts и store.ts).
-- База — источник истины, файл Sieve — производное от неё представление:
-- при любом изменении файл переписывается целиком.
--
-- conditions: [{"field":"from","op":"contains","value":"boss@x"}]
-- actions:    {"folder":"Работа","markRead":true,"flag":false,
--              "forwardTo":["a@b"],"autoReply":{...},
--              "applyToSpam":false,"continueFiltering":true}
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_filters (
    id             BIGSERIAL PRIMARY KEY,
    account_email  VARCHAR(320) NOT NULL,
    name           VARCHAR(255) NOT NULL DEFAULT '',
    -- Порядок применения: меньше — раньше. Меняется стрелками в интерфейсе.
    position       INT NOT NULL DEFAULT 0,
    -- Выключенное правило остаётся в списке, но в Sieve не попадает.
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    -- Автофильтр, заведённый сервисом (флажок «Показывать автофильтры»).
    is_auto        BOOLEAN NOT NULL DEFAULT FALSE,
    -- Как соединять условия: все ('all') или любое ('any').
    match_mode     VARCHAR(4) NOT NULL DEFAULT 'all',
    conditions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    actions        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT mail_filters_match_mode_check CHECK (match_mode IN ('all', 'any'))
);
CREATE INDEX IF NOT EXISTS idx_mail_filters_account
    ON mail_filters (lower(account_email), position, id);

-- ------------------------------------------------------------------
-- Свои ящики, связанные с этим: переключение в шапке без повторного
-- ввода пароля и общий счётчик непрочитанных.
--
-- Пароль связанного ящика проверяется настоящим IMAP-логином в момент
-- связывания (пользователь доказывает владение) и дальше хранится
-- зашифрованным. Связь односторонняя и симметричная: заводится в обе
-- стороны только явным действием пользователя в каждом из ящиков.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS linked_accounts (
    id             BIGSERIAL PRIMARY KEY,
    owner_email    VARCHAR(320) NOT NULL,
    linked_email   VARCHAR(320) NOT NULL,
    label          VARCHAR(255),
    -- AES-256-GCM, ключ — из EXTERNAL_ACCOUNTS_KEY. Открытого пароля нет.
    password_enc   TEXT NOT NULL,
    position       INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_linked_accounts
    ON linked_accounts (lower(owner_email), lower(linked_email));

-- ------------------------------------------------------------------
-- Чужие ящики на других серверах. Два режима (docs/plan.md, этап 9):
--
--   collector — сборщик: периодически забирает почту к нам в папку.
--               Письма доступны офлайн, попадают в поиск и под фильтры.
--   direct    — прямое подключение: отдельное дерево папок, письма
--               читаются с чужого сервера на лету, ничего не дублируется.
--
-- Состояние сборщика (когда забирал, сколько писем, ошибки) хранится
-- здесь же: пользователь должен видеть, работает подключение или нет.
-- Точка докачки и ключи дедупликации живут в migrate_messages /
-- migrate_cursors (их заводит @mail-true/migrate).
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS external_accounts (
    id                BIGSERIAL PRIMARY KEY,
    owner_email       VARCHAR(320) NOT NULL,
    -- Адрес чужого ящика (он же обычно логин).
    address           VARCHAR(320) NOT NULL,
    label             VARCHAR(255),
    mode              VARCHAR(16) NOT NULL DEFAULT 'collector',

    imap_host         VARCHAR(255) NOT NULL,
    imap_port         INT NOT NULL DEFAULT 993,
    imap_secure       BOOLEAN NOT NULL DEFAULT TRUE,
    imap_user         VARCHAR(320) NOT NULL,
    -- AES-256-GCM, ключ — из EXTERNAL_ACCOUNTS_KEY. Открытого пароля нет.
    password_enc      TEXT NOT NULL,
    -- Не проверять сертификат чужого сервера (внутренние сервера
    -- с самоподписанными сертификатами). Включается осознанно.
    allow_insecure_tls BOOLEAN NOT NULL DEFAULT FALSE,

    -- Отправка «от имени» внешнего адреса через его же SMTP.
    smtp_host         VARCHAR(255),
    smtp_port         INT,
    smtp_secure       BOOLEAN NOT NULL DEFAULT FALSE,
    smtp_user         VARCHAR(320),

    -- Куда складывать собранное (полный путь папки в нашем ящике).
    target_folder     VARCHAR(255) NOT NULL DEFAULT 'INBOX',
    -- Забирать только «Входящие» источника ('inbox') или все папки ('all').
    collect_scope     VARCHAR(8) NOT NULL DEFAULT 'inbox',
    -- Как часто запускать сборщик, минут. 0 — только вручную.
    interval_minutes  INT NOT NULL DEFAULT 15,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,

    -- Состояние сборщика.
    last_run_at       TIMESTAMPTZ,
    last_ok_at        TIMESTAMPTZ,
    -- never | running | ok | partial | error
    last_status       VARCHAR(16) NOT NULL DEFAULT 'never',
    last_error        TEXT,
    last_copied       INT NOT NULL DEFAULT 0,
    last_skipped      INT NOT NULL DEFAULT 0,
    last_failed       INT NOT NULL DEFAULT 0,
    last_duration_ms  INT NOT NULL DEFAULT 0,
    total_copied      BIGINT NOT NULL DEFAULT 0,
    runs              INT NOT NULL DEFAULT 0,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT external_accounts_mode_check CHECK (mode IN ('collector', 'direct')),
    CONSTRAINT external_accounts_scope_check CHECK (collect_scope IN ('inbox', 'all')),
    CONSTRAINT external_accounts_interval_check CHECK (interval_minutes BETWEEN 0 AND 1440),
    CONSTRAINT external_accounts_status_check
        CHECK (last_status IN ('never', 'running', 'ok', 'partial', 'error'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_accounts
    ON external_accounts (lower(owner_email), lower(address));
CREATE INDEX IF NOT EXISTS idx_external_accounts_due
    ON external_accounts (enabled, mode, last_run_at);

COMMIT;
