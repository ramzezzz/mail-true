-- Миграция 0001: базовая схема Mail.True целиком.
--
-- ==================================================================
-- ЧТО ЗДЕСЬ ПРОИЗОШЛО
-- ==================================================================
-- Раньше каталог миграций состоял из 36 файлов: 0001_init, 0003_admin,
-- 0004_ai, … 0037_admin_login_by_ip. Каждый из них — шаг разработки:
-- завели таблицу, через день дописали в неё колонку, ещё через день
-- добавили индекс. Для истории это правильно, для чтения — нет:
-- чтобы ответить на вопрос «как выглядит таблица mail_user_settings»,
-- приходилось открывать шесть файлов и складывать их в уме
-- (0005 завёл таблицу, 0010 добавил тему и обои, 0012 — логотипы
-- отправителей, 0016 — отмену отправки, 0019 — показ цепочками,
-- 0025 — срок хранения удалённого).
--
-- Все 36 файлов свёрнуты в этот один. Здесь каждая таблица описана
-- ОДИН раз и сразу в окончательном виде — тем, чем она стала после
-- всех доработок. Ни одного ALTER TABLE: колонка, добавленная
-- когда-то отдельной миграцией, стоит в своём CREATE TABLE.
--
-- Порядок столбцов в таблицах сохранён ровно тот, что получался при
-- последовательном накате старых миграций (поздние колонки — в конце
-- таблицы, а не там, где им место по смыслу). Это не небрежность:
-- благодаря этому схема сервера, поставленного с нуля сегодня, и
-- схема сервера, доехавшего сюда через все 36 миграций, совпадают
-- побайтно в выводе pg_dump. Разошедшийся порядок столбцов не ломает
-- ничего в коде (везде явные имена), но превращает сравнение дампов —
-- главный способ проверить «а одинаковые ли у нас базы» — в мусор.
--
-- ==================================================================
-- ЧТО СТАЛО С ИСТОРИЕЙ
-- ==================================================================
-- История не выброшена. Старые файлы лежат в каталоге
-- infra/postgres/migrations/legacy/ и нужны ровно для одного случая —
-- «доезда» сервера, который пропустил обновления и остановился где-то
-- на середине списка (см. apply_migrations в install/lib/common.sh).
-- Кто и зачем менял схему, по-прежнему видно в git: файлы не удалены,
-- а перемещены, и `git log --follow` по ним работает.
--
-- Записи о старых файлах в журнале schema_migrations работающих
-- серверов НЕ удаляются и не переписываются. Строка
-- «0021_code_created_tables.sql применена 6 августа» — это факт, и
-- стирать факты ради красоты таблицы нельзя: именно по ним потом
-- разбирают, откуда на сервере взялась та или иная колонка.
--
-- ==================================================================
-- ЧТО ПРОИСХОДИТ ПРИ ОБНОВЛЕНИИ РАБОТАЮЩЕГО СЕРВЕРА
-- ==================================================================
-- НИЧЕГО. Этот файл там не выполняется.
--
-- База на таком сервере уже содержит всё, что здесь написано. Выполнить
-- файл заново было бы безвредно (везде IF NOT EXISTS), но бессмысленно,
-- а на больших таблицах — ещё и заметно: полсотни CREATE TABLE и семь
-- десятков CREATE INDEX на живой базе это блокировки каталога и минуты
-- ожидания на ровном месте.
--
-- Поэтому установщик поступает так (подробности — в apply_migrations):
--
--   база пустая (нет virtual_users)  — выполнить файл, записать в журнал;
--   база не пустая                   — НЕ выполнять, но отметить в журнале
--                                      применённым, предварительно доведя
--                                      схему старыми файлами из legacy/,
--                                      если сервер отстал.
--
-- Со следующего обновления база считается «стоящей на базовой схеме», и
-- применяются только миграции, появившиеся ПОСЛЕ неё (0003 и далее).
--
-- ==================================================================
-- ПОЧЕМУ СЮДА НЕ ПЕРЕНЕСЕНЫ МИГРАЦИИ ДАННЫХ
-- ==================================================================
-- Среди 36 файлов было четыре, которые меняли не схему, а ДАННЫЕ:
--
--   0006 — UPDATE admin_mailbox_access SET expires_at = started_at + 1 час
--          для открытых сеансов доступа к чужому ящику: колонка появилась
--          позже самих сеансов, и без этой правки они висели бы вечно;
--   0008 — UPDATE mail_flow_events: восстановление направления письма
--          ('in'/'out') у записей, разобранных до того, как разбор научился
--          его определять;
--   0003, 0004, 0006 — INSERT недостающих строк domain_settings и
--          ai_domain_settings для доменов, заведённых до появления этих
--          таблиц.
--
-- Ни одна из них здесь не воспроизводится, и это не упущение.
--
-- Миграция данных — это разовая починка того, что уже лежит в базе.
-- На пустой базе чинить нечего: таблицы пусты, UPDATE тронет ноль строк,
-- INSERT ... SELECT FROM virtual_domains вставит ноль строк. То есть
-- на новой установке эти файлы не делают ничего по определению.
--
-- А на существующей базе они УЖЕ отработали, и повторять их не просто
-- лишнее, а вредно: 0008 переписывает историю доставки проходом по всей
-- таблице (на боевом сервере это миллионы строк и долгая блокировка),
-- а её результат к этому моменту давно на месте. Именно ради того,
-- чтобы такие файлы не выполнялись по второму кругу, и заводился журнал
-- schema_migrations.
--
-- Единственная «данные при первом запуске» вещь, которая обязана
-- случиться на новой установке, — заведение основного домена и его
-- строк настроек. Она живёт там, где ей и место: в 0002_seed_domain.sh,
-- который знает имя домена из окружения (MAIL_DOMAIN).
--
-- ==================================================================
-- ПРАВИЛО НА БУДУЩЕЕ
-- ==================================================================
-- Этот файл БОЛЬШЕ НЕ ПРАВИТСЯ. Никогда. Любое изменение схемы —
-- новый файл 0003_*.sql, 0004_*.sql и так далее. Причина простая:
-- на всех работающих серверах базовая схема отмечена применённой и
-- выполняться не будет, поэтому правка в ней доедет ровно до тех, кто
-- поставит сервер с нуля, — и схемы разойдутся молча.
--
-- Скрипт идемпотентен: повторное применение безвредно.

BEGIN;

-- ==================================================================
-- 1. ПОЧТА: домены, ящики, алиасы
-- ==================================================================
-- Три таблицы, ради которых существует всё остальное. Их читают не
-- только мы: Postfix и Dovecot ходят в них своими запросами (см.
-- infra/postfix/sql/*.cf и infra/dovecot/dovecot-sql.conf.ext), поэтому
-- имена столбцов здесь — часть договора с чужими программами, а не
-- наше внутреннее дело.

CREATE TABLE IF NOT EXISTS virtual_domains (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Виртуальные ящики. password — хэш в формате dovecot
-- ({SHA512-CRYPT}$6$... или {ARGON2ID}$argon2id$...).
CREATE TABLE IF NOT EXISTS virtual_users (
    id           SERIAL PRIMARY KEY,
    domain_id    INT NOT NULL REFERENCES virtual_domains(id) ON DELETE CASCADE,
    email        VARCHAR(255) NOT NULL UNIQUE,
    password     VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    quota_bytes  BIGINT  NOT NULL DEFAULT 1073741824, -- 1 GiB по умолчанию
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_virtual_users_domain ON virtual_users(domain_id);

-- Алиасы: source (полный адрес) -> destination (полный адрес, можно внешний)
CREATE TABLE IF NOT EXISTS virtual_aliases (
    id          SERIAL PRIMARY KEY,
    domain_id   INT NOT NULL REFERENCES virtual_domains(id) ON DELETE CASCADE,
    source      VARCHAR(255) NOT NULL,
    destination VARCHAR(255) NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, destination)
);
CREATE INDEX IF NOT EXISTS idx_virtual_aliases_source ON virtual_aliases(source);

-- ==================================================================
-- 2. АДМИНКА: учётные записи, журнал действий, доступ к чужим ящикам
-- ==================================================================

CREATE TABLE IF NOT EXISTS admin_users (
    id             SERIAL PRIMARY KEY,
    login          VARCHAR(128) NOT NULL UNIQUE,
    -- Хэш формата scrypt$N$r$p$<salt b64url>$<hash b64url>
    -- (см. apps/api/src/admin/passwords.ts). Намеренно НЕ формат Dovecot:
    -- это не почтовый пароль, Dovecot его не читает.
    password_hash  VARCHAR(512) NOT NULL,
    display_name   VARCHAR(255),
    role           VARCHAR(32)  NOT NULL DEFAULT 'readonly',
    -- Двухфакторная аутентификация (TOTP): секрет и признак включения.
    totp_secret    VARCHAR(128),
    totp_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at  TIMESTAMPTZ,
    last_login_ip  VARCHAR(64),
    -- Защита от перебора пароля: счётчик неудач и блокировка до момента времени.
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Оформление панели у этого администратора. Стоит в конце таблицы,
    -- а не рядом с display_name, потому что появилось позже (см. шапку).
    theme          VARCHAR(32),
    CONSTRAINT admin_users_role_check
        CHECK (role IN ('owner', 'user_manager', 'readonly'))
);
COMMENT ON COLUMN admin_users.theme IS
    'Тема оформления панели у этого администратора; NULL — тема по умолчанию';

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id           BIGSERIAL PRIMARY KEY,
    admin_id     INT REFERENCES admin_users(id) ON DELETE SET NULL,
    admin_login  VARCHAR(128) NOT NULL,
    -- Машинное имя действия: user.create, user.block, alias.delete, domain.add, ...
    action       VARCHAR(64)  NOT NULL,
    -- Над чем действие: user | alias | domain | admin | mailbox | settings
    target_type  VARCHAR(32)  NOT NULL,
    -- Идентификатор объекта в его таблице (может отсутствовать, если объект удалён)
    target_id    INT,
    -- Человекочитаемая метка объекта: адрес ящика, имя домена и т. п.
    target_label VARCHAR(255),
    ip           VARCHAR(64),
    user_agent   VARCHAR(512),
    -- Состояние до и после. Пароли и секреты сюда не попадают —
    -- вместо значения пишется маркер '***'.
    old_value    JSONB,
    new_value    JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created  ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin    ON admin_audit_log (admin_login);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target   ON admin_audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action   ON admin_audit_log (action);

-- Вход администратора в чужой ящик. Всегда с причиной и всегда на срок:
-- бессрочный доступ к чужой переписке — это не доступ, а полномочие.
CREATE TABLE IF NOT EXISTS admin_mailbox_access (
    id           BIGSERIAL PRIMARY KEY,
    admin_id     INT REFERENCES admin_users(id) ON DELETE SET NULL,
    admin_login  VARCHAR(128) NOT NULL,
    mailbox_email VARCHAR(255) NOT NULL,
    reason       TEXT NOT NULL,
    ip           VARCHAR(64),
    user_agent   VARCHAR(512),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at     TIMESTAMPTZ,
    -- Срок и причина закрытия появились позже самих сеансов — отсюда
    -- их место в конце таблицы (см. шапку).
    expires_at   TIMESTAMPTZ,
    end_reason   VARCHAR(16),
    CONSTRAINT admin_mailbox_access_reason_check
        CHECK (length(btrim(reason)) >= 3)
);
COMMENT ON COLUMN admin_mailbox_access.end_reason IS
    'leave — вышел кнопкой, logout — вышел из админки, replaced — вошёл в другой ящик, expired — истёк срок';
CREATE INDEX IF NOT EXISTS idx_mailbox_access_mailbox ON admin_mailbox_access (mailbox_email, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_access_admin   ON admin_mailbox_access (admin_login, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_access_open
    ON admin_mailbox_access (expires_at) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_login_failures (
    -- Логин строкой, а не ссылкой на admin_users: перебирают и
    -- несуществующие имена, и такие попытки тоже надо считать — иначе
    -- перебор логинов ничем не ограничен.
    login        text        NOT NULL,
    ip           text        NOT NULL,
    attempts     integer     NOT NULL DEFAULT 0,
    -- Пока не наступило — с этого адреса вход в эту учётку не принимается.
    locked_until timestamptz,
    first_at     timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (login, ip)
);
COMMENT ON TABLE admin_login_failures IS
    'Неудачные входы в панель по паре «учётная запись + адрес». Блокируется адрес, а не учётка.';
CREATE INDEX IF NOT EXISTS idx_admin_login_failures_updated
    ON admin_login_failures (updated_at);

CREATE TABLE IF NOT EXISTS admin_known_ips (
    admin_id     integer     NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    ip           text        NOT NULL,
    last_success timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (admin_id, ip)
);
COMMENT ON TABLE admin_known_ips IS
    'Адреса, с которых администратор успешно входил. Им не мешает блокировка учётной записи.';
CREATE INDEX IF NOT EXISTS idx_admin_known_ips_seen
    ON admin_known_ips (last_success DESC);

-- ==================================================================
-- 3. ДОМЕН: подписи DKIM, проверка DNS
-- ==================================================================

CREATE TABLE IF NOT EXISTS domain_settings (
    domain_id        INT PRIMARY KEY REFERENCES virtual_domains(id) ON DELETE CASCADE,
    dkim_selector    VARCHAR(64)  NOT NULL DEFAULT 'mail',
    -- Публичная часть ключа DKIM (base64 из rspamd) и готовая TXT-запись
    dkim_public_key  TEXT,
    dkim_dns_record  TEXT,
    -- Ожидаемые значения для подсказок в интерфейсе
    expected_mx      VARCHAR(255),
    expected_spf     TEXT,
    expected_dmarc   TEXT,
    dns_status       JSONB,
    dns_checked_at   TIMESTAMPTZ,
    -- Итог последней проверки: ok | warn | fail | unknown
    dns_overall      VARCHAR(16) NOT NULL DEFAULT 'unknown',
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT domain_settings_overall_check
        CHECK (dns_overall IN ('ok', 'warn', 'fail', 'unknown'))
);

-- ==================================================================
-- 4. ПОМОЩНИК (ИИ): настройки по домену, согласие человека, расход
-- ==================================================================

CREATE TABLE IF NOT EXISTS ai_domain_settings (
    domain_id        INT PRIMARY KEY REFERENCES virtual_domains(id) ON DELETE CASCADE,
    -- Разрешён ли помощник по домену. По умолчанию НЕТ.
    enabled          BOOLEAN NOT NULL DEFAULT FALSE,
    -- Адрес совместимого API без хвостового пути. Для локальной модели
    -- указывает внутрь своей сети, и тогда переписка не выходит за периметр.
    base_url         VARCHAR(512),
    chat_path        VARCHAR(255) NOT NULL DEFAULT '/chat/completions',
    -- Ключ доступа: AES-256-GCM, ключ шифрования — из AI_ENCRYPTION_KEY.
    -- NULL — ключа нет (обычный случай для локальной модели).
    api_key_enc      TEXT,
    -- Хвост ключа для опознания в админке (например '…a3f9'). Не секрет.
    api_key_hint     VARCHAR(32),
    model            VARCHAR(255),
    -- Человекочитаемое название сервиса: показывается пользователю в описи.
    provider_label   VARCHAR(255) NOT NULL DEFAULT 'Сервис ИИ',
    -- Модель поднята внутри периметра: письма не покидают сервер.
    is_local         BOOLEAN NOT NULL DEFAULT FALSE,
    -- Предельная длина тела письма, уходящего наружу.
    max_body_chars   INT NOT NULL DEFAULT 8000,
    timeout_ms       INT NOT NULL DEFAULT 30000,
    max_output_tokens INT NOT NULL DEFAULT 1024,
    -- Ограничение расходов. NULL — без предела.
    period_ms                INT    NOT NULL DEFAULT 86400000,
    max_tokens_per_period    BIGINT,
    max_requests_per_period  INT,
    max_tokens_per_request   INT,
    -- Какие возможности разрешены по домену: массив имён из
    -- apps/api/src/ai/features.ts. NULL — разрешены все.
    features_allowed JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_domain_settings_body_chars_check
        CHECK (max_body_chars BETWEEN 200 AND 200000),
    CONSTRAINT ai_domain_settings_timeout_check
        CHECK (timeout_ms BETWEEN 1000 AND 600000),
    CONSTRAINT ai_domain_settings_output_check
        CHECK (max_output_tokens BETWEEN 64 AND 32000),
    CONSTRAINT ai_domain_settings_period_check
        CHECK (period_ms BETWEEN 60000 AND 2592000000),
    -- Включить помощника без адреса и модели нельзя: настройки, которых
    -- не хватает для вызова, не должны выглядеть работающими.
    CONSTRAINT ai_domain_settings_enabled_needs_provider
        CHECK (NOT enabled OR (base_url IS NOT NULL AND model IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ai_user_settings (
    id               BIGSERIAL PRIMARY KEY,
    -- Адрес ящика в нижнем регистре. Не FK на virtual_users: настройки
    -- переживают пересоздание ящика и не мешают контракту с Dovecot.
    account_email    VARCHAR(255) NOT NULL UNIQUE,
    consent_at       TIMESTAMPTZ,
    -- Чему именно пользователь сказал «да».
    consent_endpoint VARCHAR(512),
    consent_model    VARCHAR(255),
    -- Включённые лично у него возможности: массив имён.
    -- NULL — набор по умолчанию (см. apps/api/src/ai/features.ts).
    features         JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_user_settings_email
    ON ai_user_settings (lower(account_email));

CREATE TABLE IF NOT EXISTS ai_audit_log (
    id                BIGSERIAL PRIMARY KEY,
    at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_id        VARCHAR(255) NOT NULL,
    -- Идентификатор письма или цепочки; NULL — обращение без письма
    -- (правка текста, разбор поискового запроса).
    message_id        VARCHAR(255),
    feature           VARCHAR(32)  NOT NULL,
    prompt_version    VARCHAR(32)  NOT NULL,
    endpoint          VARCHAR(512) NOT NULL,
    model             VARCHAR(255) NOT NULL,
    is_local          BOOLEAN NOT NULL DEFAULT FALSE,
    prompt_tokens     INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens      INT NOT NULL DEFAULT 0,
    -- Счётчики оценены по длине текста, сервис их не вернул.
    estimated         BOOLEAN NOT NULL DEFAULT TRUE,
    cached            BOOLEAN NOT NULL DEFAULT FALSE,
    outbound_chars    INT NOT NULL DEFAULT 0,
    duration_ms       INT NOT NULL DEFAULT 0,
    ok                BOOLEAN NOT NULL DEFAULT TRUE,
    error_kind        VARCHAR(32)
);
CREATE INDEX IF NOT EXISTS idx_ai_audit_at      ON ai_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_account ON ai_audit_log (account_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_feature ON ai_audit_log (feature, at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_audit_message ON ai_audit_log (message_id);

-- ==================================================================
-- 5. НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ
-- ==================================================================

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
    -- --- Всё, что ниже, добавлялось отдельными миграциями поверх уже
    -- --- работавшей таблицы, поэтому стоит в конце (см. шапку файла).
    --
    -- Выбор темы: 'system' | идентификатор темы из реестра
    -- (packages/shared/src/appearance.ts). Список тем проверяет API,
    -- а не база: новая тема не должна требовать миграции.
    theme                  VARCHAR(16) NOT NULL DEFAULT 'system',
    -- Выбор фона «обойной» темы: 'preset:<id>' | 'custom' | '' (не выбирали).
    wallpaper              VARCHAR(64) NOT NULL DEFAULT '',
    -- Показывать логотипы отправителей в списке писем.
    sender_logos           BOOLEAN NOT NULL DEFAULT false,
    -- Сколько секунд после нажатия «Отправить» письмо можно вернуть.
    undo_send_seconds      INTEGER NOT NULL DEFAULT 5,
    -- Показывать список письмами или цепочками.
    threaded_list          BOOLEAN NOT NULL DEFAULT true,
    -- Сколько суток удалённое письмо ещё можно вернуть после очистки корзины.
    trash_recovery_days    INT NOT NULL DEFAULT 7,
    CONSTRAINT mail_user_settings_after_delete_check
        CHECK (after_delete IN ('list', 'next')),
    CONSTRAINT mail_user_settings_autoreply_days_check
        CHECK (autoreply_days BETWEEN 1 AND 365)
);

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

-- Свои же ящики, привязанные к одной сессии («переключиться на ящик»).
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

-- Чужие ящики: сбор почты по IMAP и отправка «от имени» через чужой SMTP.
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

-- ==================================================================
-- 6. УБОРКА ЯЩИКОВ И МАССОВОЕ ЗАВЕДЕНИЕ
-- ==================================================================

CREATE TABLE IF NOT EXISTS mailbox_deletions (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(320) NOT NULL,
    domain          VARCHAR(255) NOT NULL,
    -- Кто удалил и почему (причина берётся из запроса, может быть пустой).
    admin_login     VARCHAR(128),
    reason          TEXT,
    -- Куда переехал каталог ящика. NULL — переименовать не удалось
    -- (тома нет или прав нет), тогда в error написано, что именно.
    quarantine_path TEXT,
    -- Исходный путь — чтобы было видно, что именно убирали.
    maildir_path    TEXT,
    -- pending — карантин сделан, дерево ещё на диске
    -- purged  — дерево удалено
    -- failed  — уборка не удалась, см. error и attempts
    state           VARCHAR(16) NOT NULL DEFAULT 'pending',
    -- Удалось ли перед удалением очистить ящик средствами Dovecot
    -- (удаление папок + очистка INBOX). Это то, что убирает индексы
    -- полнотекстового поиска: они лежат в томе Dovecot, куда API не имеет
    -- доступа, и снаружи их удалить нечем.
    imap_purged     BOOLEAN NOT NULL DEFAULT FALSE,
    -- Сколько строк служебных таблиц ушло вместе с ящиком.
    db_rows_removed INT NOT NULL DEFAULT 0,
    bytes_freed     BIGINT NOT NULL DEFAULT 0,
    attempts        INT NOT NULL DEFAULT 0,
    error           TEXT,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    purge_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
    purged_at       TIMESTAMPTZ,
    CONSTRAINT mailbox_deletions_state_check
        CHECK (state IN ('pending', 'purged', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_mailbox_deletions_pending
    ON mailbox_deletions (purge_after) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_mailbox_deletions_email
    ON mailbox_deletions (lower(email), requested_at DESC);

CREATE TABLE IF NOT EXISTS user_import_jobs (
    id              BIGSERIAL PRIMARY KEY,
    admin_id        INT,
    admin_login     VARCHAR(128) NOT NULL,
    -- running — идёт, done — закончено, failed — упало целиком
    state           VARCHAR(16) NOT NULL DEFAULT 'running',
    total           INT NOT NULL DEFAULT 0,
    processed       INT NOT NULL DEFAULT 0,
    created_count   INT NOT NULL DEFAULT 0,
    failed_count    INT NOT NULL DEFAULT 0,
    -- {"created":[{"email","generatedPassword"}],"failed":[{...}]} в шифротексте
    result_enc      TEXT,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    -- После этого срока задание вместе с паролями удаляется уборщиком:
    -- сгенерированный пароль не должен лежать вечно.
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    CONSTRAINT user_import_jobs_state_check
        CHECK (state IN ('running', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_user_import_jobs_admin
    ON user_import_jobs (admin_login, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_import_jobs_expires
    ON user_import_jobs (expires_at);

-- ==================================================================
-- 7. ПОЧТОВЫЙ ПОТОК: разобранный журнал Postfix
-- ==================================================================

CREATE TABLE IF NOT EXISTS mail_flow_events (
    id            BIGSERIAL PRIMARY KEY,
    -- Время из строки журнала, а не время вставки: разбор может отстать
    -- от журнала на секунды, а при первом запуске — на часы.
    occurred_at   TIMESTAMPTZ NOT NULL,
    -- Идентификатор в очереди. NULL у отказов на приёме: письму, отбитому
    -- на команде RCPT, очередь не заводится вовсе (в журнале — NOQUEUE).
    queue_id      TEXT,
    -- 'in'  — доставка в наши ящики (транспорт lmtp в Dovecot);
    -- 'out' — отправка наружу (транспорт smtp);
    -- 'unknown' — определить не удалось, лучше сказать честно.
    direction     TEXT NOT NULL DEFAULT 'unknown',
    -- sent | deferred | bounced | expired | rejected | held
    status        TEXT NOT NULL,
    sender        TEXT,
    recipient     TEXT,
    relay         TEXT,
    -- Задержка от приёма до этой попытки, секунды (из delay= в журнале).
    delay_seconds NUMERIC(12, 2),
    size_bytes    BIGINT,
    -- Код DSN (2.0.0, 4.4.1, 5.1.1) — по нему видно, временный отказ
    -- или постоянный, без разбора текста.
    dsn           TEXT,
    -- Текст причины: то, что ответила принимающая сторона. Именно его
    -- ищет человек, когда спрашивает «почему письмо не дошло».
    reason        TEXT,
    -- Какой процесс Postfix это сказал (smtp, lmtp, smtpd, bounce, qmgr).
    component     TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_flow_time ON mail_flow_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mail_flow_status ON mail_flow_events (status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_flow_queue ON mail_flow_events (queue_id) WHERE queue_id IS NOT NULL;

-- Покрывающий индекс под агрегаты дашборда: сводка за сутки читается
-- по нему одним проходом, не заглядывая в таблицу.
--
-- В старой миграции 0011 он строился CREATE INDEX CONCURRENTLY через
-- \gexec, и это было правильно: индекс добавляли к таблице, в которую
-- непрерывно пишет сборщик журнала Postfix, а обычный CREATE INDEX
-- держал бы запись до конца построения. Здесь так делать не нужно и
-- нельзя: базовая схема выполняется только на ПУСТОЙ базе (блокировать
-- нечего и некого), а CONCURRENTLY вдобавок запрещён внутри транзакции,
-- в которую завёрнут весь этот файл.
CREATE INDEX IF NOT EXISTS idx_mail_flow_agg
    ON mail_flow_events (occurred_at)
    INCLUDE (direction, status, sender, recipient, size_bytes);

-- Поиск по адресу подстрокой. Расширение может быть недоступно
-- (урезанная сборка Postgres) — тогда поиск идёт перебором, и это
-- лучше, чем отказ всей схемы из-за необязательного ускорения.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm недоступно (%): поиск по адресу пойдёт перебором', SQLERRM;
END
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS idx_mail_flow_recipient_trgm
            ON mail_flow_events USING gin (lower(recipient) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_mail_flow_sender_trgm
            ON mail_flow_events USING gin (lower(sender) gin_trgm_ops);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS mail_flow_cursor (
    source      TEXT PRIMARY KEY,
    file_id     TEXT NOT NULL,
    byte_offset BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Когда разбор увидел первую строку. Ровно это показывается в админке
    -- как «история ведётся с …»: обещать больше, чем есть, нельзя.
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================================================================
-- 8. ПОКАЗАТЕЛИ СЕРВЕРА И СПАМА
-- ==================================================================

CREATE TABLE IF NOT EXISTS server_metric_samples (
    id                  BIGSERIAL PRIMARY KEY,
    taken_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Загрузка процессора ВСЕГО УЗЛА, проценты (0..100). Считается
    -- разностью счётчиков /proc/stat между этим снимком и предыдущим —
    -- отсюда и NULL в самом первом снимке после запуска: разности ещё нет.
    cpu_node_percent    NUMERIC(5, 2),
    -- Загрузка процессора КОНТЕЙНЕРОМ api, проценты одного ядра
    -- (/sys/fs/cgroup/cpu.stat, usage_usec). На восьми ядрах законно
    -- бывает больше 100, поэтому разрядность с запасом.
    cpu_api_percent     NUMERIC(7, 2),
    -- Средняя длина очереди готовых к исполнению за минуту (/proc/loadavg).
    -- Не проценты: показывает перегрузку там, где CPU уже упёрся в 100 %
    -- и по нему разницы между «впритык» и «вдвое больше, чем тянем» нет.
    load1               NUMERIC(7, 2),
    mem_node_total      BIGINT,
    -- Занято = total - available. Именно available, а не free: страницы
    -- под кэшем считаются свободными, и по free сервер с исправным кэшем
    -- выглядит как сервер на грани нехватки памяти.
    mem_node_used       BIGINT,
    -- Память контейнера api (/sys/fs/cgroup/memory.current).
    mem_api_bytes       BIGINT,
    -- Том, на котором лежат письма: размер и свободное место (statfs).
    disk_total          BIGINT,
    disk_free           BIGINT,
    -- Разрез занятого места по тому, что важно почтовику. Общее «занято
    -- 60 ГБ» бесполезно, когда надо понять, ЧТО именно съело диск.
    vmail_bytes         BIGINT,
    mailindex_bytes     BIGINT,
    logs_bytes          BIGINT,
    db_bytes            BIGINT,
    db_index_bytes      BIGINT,
    -- Очередь Postfix — через посредника в его контейнере (сокет Docker
    -- не подключаем, см. queue-agent.ts). NULL — посредник не ответил.
    queue_total         INTEGER,
    queue_deferred      INTEGER,
    -- Возраст самого старого письма очереди, секунды. Именно возраст, а не
    -- «сколько лежит»: очередь из тысячи писем возрастом в минуту — это
    -- всплеск, а одно письмо возрастом в сутки — это сломанный адресат.
    queue_oldest_seconds INTEGER
);
-- Про отсутствие CONCURRENTLY — см. пояснение у idx_mail_flow_agg.
CREATE INDEX IF NOT EXISTS idx_metric_samples_time
    ON server_metric_samples (taken_at DESC);

CREATE TABLE IF NOT EXISTS rspamd_stat_samples (
    id                  BIGSERIAL PRIMARY KEY,
    taken_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Сколько секунд работает процесс rspamd: по уменьшению этого числа
    -- опознаётся перезапуск, после которого счётчики начинаются с нуля.
    uptime_seconds      BIGINT NOT NULL,
    -- Проверено писем всего. Знаменатель для доли спама.
    scanned             BIGINT NOT NULL DEFAULT 0,
    -- Разбивка по решениям. Имена — как их зовёт сам rspamd, только
    -- пробелы заменены подчёркиванием.
    act_reject          BIGINT NOT NULL DEFAULT 0,
    act_add_header      BIGINT NOT NULL DEFAULT 0,
    act_rewrite_subject BIGINT NOT NULL DEFAULT 0,
    act_greylist        BIGINT NOT NULL DEFAULT 0,
    act_soft_reject     BIGINT NOT NULL DEFAULT 0,
    act_no_action       BIGINT NOT NULL DEFAULT 0,
    -- Обучение байесова классификатора. Считает ВСЁ обучение, включая
    -- автоматическое (autolearn = true в local.d/classifier-bayes.conf).
    -- Ручное обучение из панели считается отдельно — по журналу аудита,
    -- потому что только там видно, кто и когда это сделал.
    learned             BIGINT NOT NULL DEFAULT 0,
    spam_count          BIGINT NOT NULL DEFAULT 0,
    ham_count           BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rspamd_stat_time
    ON rspamd_stat_samples (taken_at);

-- ==================================================================
-- 9. ПЕРЕНОС ПОЧТЫ С ЧУЖОГО СЕРВЕРА
-- ==================================================================

CREATE TABLE IF NOT EXISTS mail_migration_jobs (
    id              BIGSERIAL PRIMARY KEY,
    admin_id        INT,
    admin_login     VARCHAR(128) NOT NULL,
    -- queued  — принято, работник ещё не взял
    -- running — идёт
    -- done    — закончено (в том числе с ошибками отдельных писем)
    -- failed  — упало целиком (не достучались до сервера и т. п.)
    -- stopped — остановлено человеком
    state           VARCHAR(16) NOT NULL DEFAULT 'queued',
    -- Нажали «Остановить». Работник читает флаг между письмами и папками:
    -- обрывать APPEND на середине нельзя, приёмник получил бы полписьма.
    stop_requested  BOOLEAN NOT NULL DEFAULT FALSE,
    -- Откуда переносим. Секретов здесь нет: адрес и порт — не тайна, а
    -- видеть их в списке заданий необходимо, иначе два задания к разным
    -- серверам неразличимы.
    source_host             VARCHAR(255) NOT NULL,
    source_port             INT NOT NULL,
    source_secure           BOOLEAN NOT NULL DEFAULT TRUE,
    source_insecure_tls     BOOLEAN NOT NULL DEFAULT TRUE,
    -- Служебный пользователь источника (пусто — вход паролем каждого ящика)
    source_master_user      VARCHAR(255),
    source_master_separator VARCHAR(4),
    -- Пароли: ТОЛЬКО шифротекст, ТОЛЬКО на время работы задания.
    secret_enc      TEXT,
    total           INT NOT NULL DEFAULT 0,
    done_count      INT NOT NULL DEFAULT 0,
    copied          BIGINT NOT NULL DEFAULT 0,
    skipped         BIGINT NOT NULL DEFAULT 0,
    failed          BIGINT NOT NULL DEFAULT 0,
    error           TEXT,
    -- Кто ведёт задание СЕЙЧАС. После перезапуска контейнера у нового
    -- процесса другой идентификатор, а heartbeat_at старого перестаёт
    -- обновляться — по этому задание и подхватывается (см. migrate-runner.ts).
    runner          VARCHAR(64),
    heartbeat_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    CONSTRAINT mail_migration_jobs_state_check
        CHECK (state IN ('queued', 'running', 'done', 'failed', 'stopped'))
);
CREATE INDEX IF NOT EXISTS idx_migration_jobs_created
    ON mail_migration_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_migration_jobs_live
    ON mail_migration_jobs (heartbeat_at) WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS mail_migration_items (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL
                    REFERENCES mail_migration_jobs (id) ON DELETE CASCADE,
    -- Порядковый номер в задании: он же ключ к паролю внутри secret_enc
    position        INT NOT NULL,
    source_user     VARCHAR(320) NOT NULL,
    dest_user       VARCHAR(320) NOT NULL,
    -- queued | running | ok | partial | failed | stopped
    state           VARCHAR(16) NOT NULL DEFAULT 'queued',
    total           INT NOT NULL DEFAULT 0,
    copied          INT NOT NULL DEFAULT 0,
    skipped         INT NOT NULL DEFAULT 0,
    failed          INT NOT NULL DEFAULT 0,
    -- Какую папку переносим прямо сейчас. Ради этого поля половина
    -- смысла раздела: без него часовой перенос выглядит как зависание.
    current_folder  TEXT,
    -- JSON-массив строк с объяснениями отказов (без паролей — в них
    -- попадают только ответы сервера, разобранные describeImapError).
    errors          TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Ящик-приёмник ссылкой, а не только адресом строкой (dest_user):
    -- адрес мог быть переименован. Добавлено позже, отсюда место в конце.
    dest_user_id    INTEGER,
    -- Имя связи задано явно и совпадает с тем, что было выдано старой
    -- миграцией 0020. Автоматическое имя вышло бы другим
    -- (…_dest_user_id_fkey), и схема сервера, поставленного с нуля,
    -- разошлась бы с обновлённым ровно в одну строку дампа — из тех,
    -- что потом ищут полдня.
    CONSTRAINT mail_migration_items_dest_user_fkey
        FOREIGN KEY (dest_user_id) REFERENCES virtual_users(id) ON DELETE SET NULL,
    CONSTRAINT mail_migration_items_state_check
        CHECK (state IN ('queued', 'running', 'ok', 'partial', 'failed', 'stopped')),
    CONSTRAINT mail_migration_items_position_uniq UNIQUE (job_id, position)
);
CREATE INDEX IF NOT EXISTS idx_migration_items_job
    ON mail_migration_items (job_id, position);
CREATE INDEX IF NOT EXISTS idx_migration_items_dest_user
    ON mail_migration_items (dest_user_id);

-- Что уже перенесено: защита от повторной заливки тех же писем при
-- повторном запуске переноса.
CREATE TABLE IF NOT EXISTS migrate_messages (
    account     text NOT NULL,
    dest_folder text NOT NULL,
    dedup_key   text NOT NULL,
    -- Сколько копий письма с этим ключом уже перенесено. Ключ
    -- дедупликации не уникален (повторный Message-ID, письма без
    -- Message-ID с одинаковыми заголовками), поэтому храним число.
    copies      integer NOT NULL DEFAULT 1,
    migrated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account, dest_folder, dedup_key)
);

CREATE TABLE IF NOT EXISTS migrate_cursors (
    account       text NOT NULL,
    source_folder text NOT NULL,
    uid_validity  text NOT NULL,
    last_uid      bigint NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account, source_folder)
);

-- ==================================================================
-- 10. УВЕДОМЛЕНИЯ В БРАУЗЕР
-- ==================================================================

CREATE TABLE IF NOT EXISTS push_vapid_keys (
    -- Одна строка на установку. Ограничение проверкой, а не «договорённостью»:
    -- вторая пара ключей означала бы, что часть подписок перестала работать,
    -- и выяснилось бы это через неделю по жалобам.
    id          SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- Несжатая точка P-256 (65 байт) в base64url — то, что уходит в браузер.
    public_key  TEXT         NOT NULL,
    -- Скаляр 32 байта в base64url. Секрет: с ним можно слать уведомления
    -- от имени этого сервера в любую подписку, выданную под этот ключ.
    private_key TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            BIGSERIAL    PRIMARY KEY,
    account_email VARCHAR(320) NOT NULL,
    -- Адрес службы доставки. Он же секрет: кто его знает, тот может слать
    -- в этот браузер уведомления. Поэтому наружу он не отдаётся никогда —
    -- в настройках показывается только название браузера и дата.
    endpoint      TEXT         NOT NULL,
    -- Открытый ключ браузера и общий секрет подписки: из них выводится
    -- ключ шифрования тела (RFC 8291). Без них служба доставки доставит
    -- сообщение, а браузер молча его выбросит.
    p256dh        TEXT         NOT NULL,
    auth          TEXT         NOT NULL,
    -- Отпечаток браузера. Тот же самый присылается при подключении к /ws,
    -- и благодаря этому push НЕ уходит туда, где вкладка сейчас открыта:
    -- иначе на одно письмо человек получал бы два одинаковых окна.
    client_id     VARCHAR(64)  NOT NULL,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_error_at TIMESTAMPTZ,
    last_error    TEXT,
    -- Один адрес службы доставки — одна строка. Браузер выдаёт на подписку
    -- ровно один адрес; повторная подписка того же браузера должна обновлять
    -- запись, а не плодить копии, иначе одно письмо давало бы N уведомлений.
    CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);
CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx
    ON push_subscriptions (lower(account_email));

CREATE TABLE IF NOT EXISTS mail_notification_prefs (
    account_email  VARCHAR(320) PRIMARY KEY,
    -- 'minimal' | 'sender-subject' | 'preview' | 'ai-summary'.
    -- Список проверяет API, а не база: новый уровень не должен требовать
    -- миграции, а неизвестное значение приводится к безопасному.
    level          VARCHAR(32)  NOT NULL DEFAULT 'sender-subject',
    -- Доставлять ли уведомления при ЗАКРЫТОЙ вкладке (Web Push).
    -- Выключено по умолчанию: включение означает, что сервер начнёт
    -- обращаться к службе доставки браузера (Google, Mozilla, Apple), и
    -- ей станут видны адрес подписки, время и частота писем. Это решение
    -- человека, а не наше за него.
    push_enabled   BOOLEAN      NOT NULL DEFAULT false,
    -- Класть ли содержимое письма в тело push-сообщения.
    -- НЕТ по умолчанию, и это главное решение всего раздела: тело push
    -- проходит через чужой сервер. Оно зашифровано (RFC 8291) и прочесть
    -- его посредник не может, но шифротекст у него остаётся, а содержимое
    -- в нём — это снимок прошлого: письмо могли уже прочитать с другого
    -- устройства. По умолчанию наружу уходит только «есть новости», а
    -- содержимое Service Worker забирает с нашего сервера при показе.
    push_payload   BOOLEAN      NOT NULL DEFAULT false,
    -- Не уведомлять о письмах, которые фильтр пометил прочитанными.
    skip_filtered  BOOLEAN      NOT NULL DEFAULT true,
    quiet_enabled  BOOLEAN      NOT NULL DEFAULT false,
    -- Границы «тихих часов» в минутах от полуночи ПО ПОЯСУ ЧЕЛОВЕКА.
    -- Минуты, а не время: часовой пояс к колонке TIME не прилагается, и
    -- «23:00» в базе означало бы «23:00 у сервера», то есть не то.
    quiet_from     SMALLINT     NOT NULL DEFAULT 1380 CHECK (quiet_from BETWEEN 0 AND 1439),
    quiet_to       SMALLINT     NOT NULL DEFAULT 420  CHECK (quiet_to   BETWEEN 0 AND 1439),
    -- Пояс в виде имени IANA («Europe/Moscow»). Приходит от браузера.
    time_zone      VARCHAR(64),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ==================================================================
-- 11. РАБОТА С ПИСЬМАМИ: отложенные, корзина, метки, шаблоны, поиск
-- ==================================================================

CREATE TABLE IF NOT EXISTS snoozed_messages (
    id                 BIGSERIAL    PRIMARY KEY,
    account_email      VARCHAR(320) NOT NULL,
    -- Где письмо лежит СЕЙЧАС: папка «Отложенные» этого ящика.
    -- Путь хранится явно, потому что имя служебной папки в IMAP может
    -- отличаться от нашего умолчания (ящик мог приехать с чужого сервера).
    snooze_path        TEXT         NOT NULL,
    snooze_uid         BIGINT       NOT NULL,
    -- UIDVALIDITY папки на момент переноса. Расходится с текущим —
    -- значит, UID выше уже ничего не значит, и письмо ищется по Message-ID.
    snooze_uidvalidity BIGINT       NOT NULL DEFAULT 0,
    -- Куда возвращать. Путь IMAP, а не наш идентификатор папки:
    -- идентификатор `f-<base64url(путь)>` — это форма показа, и завязывать
    -- на неё хранение значило бы, что переименование правил показа ломает
    -- возврат. Папки может уже не быть — тогда письмо вернётся во «Входящие».
    origin_path        TEXT         NOT NULL,
    -- Заголовок Message-ID без угловых скобок. Запасной ключ поиска,
    -- см. пояснение выше. Пусто — письмо пришло без Message-ID (бывает
    -- у писем, собранных кривыми отправителями): тогда остаётся только UID.
    message_id         TEXT,
    -- Только для строки списка «Отложенных» и журнала.
    subject            TEXT         NOT NULL DEFAULT '',
    from_address       TEXT         NOT NULL DEFAULT '',
    -- Когда вернуть. Момент времени, а не «дата и время»: «завтра утром» —
    -- это утро ЧЕЛОВЕКА, и превращение его в момент происходит один раз,
    -- при постановке срока, по поясу браузера (см. mail/snooze-schedule.ts).
    -- Хранить «08:00» без пояса означало бы «08:00 у сервера», то есть не то.
    wake_at            TIMESTAMPTZ  NOT NULL,
    -- Пояс, в котором срок назначали (IANA, «Europe/Moscow»). Нужен, чтобы
    -- показать срок теми же словами, какими его назначили.
    time_zone          VARCHAR(64),
    -- Каким сроком его назначили: 'tomorrow-morning' | 'monday' |
    -- 'next-week' | 'custom'. Проверяет API, а не база: новый готовый срок
    -- не должен требовать миграции.
    preset             VARCHAR(32)  NOT NULL DEFAULT 'custom',
    -- 'pending'   — ждёт срока (единственное живое состояние);
    -- 'returned'  — вернулось в папку;
    -- 'cancelled' — человек вернул его сам, не дожидаясь срока;
    -- 'gone'      — письма в «Отложенных» больше нет (унесли или удалили).
    state              VARCHAR(16)  NOT NULL DEFAULT 'pending',
    -- Сколько раз возврат срывался. НЕ повод сдаться: срыв возврата — это
    -- почти всегда недоступный Dovecot, а недоступность проходит сама.
    -- Число нужно журналу и разделу состояния: по нему видно, что письма
    -- копятся, ещё до того, как о них спросит человек.
    attempts           INT          NOT NULL DEFAULT 0,
    last_error         TEXT,
    last_attempt_at    TIMESTAMPTZ,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Когда письмо вернулось (или когда запись закрылась иначе).
    closed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS snoozed_messages_due_idx
    ON snoozed_messages (wake_at)
    WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS snoozed_messages_account_idx
    ON snoozed_messages (lower(account_email), wake_at)
    WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS snoozed_messages_live_key
    ON snoozed_messages (lower(account_email), snooze_path, snooze_uidvalidity, snooze_uid)
    WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS trash_recovery_items (
    id                   BIGSERIAL    PRIMARY KEY,
    account_email        VARCHAR(320) NOT NULL,
    -- Где письмо лежит СЕЙЧАС. Путь хранится явно: имя служебной папки
    -- в IMAP может отличаться от нашего умолчания (ящик мог приехать
    -- с чужого сервера).
    recovery_path        TEXT         NOT NULL,
    recovery_uid         BIGINT       NOT NULL,
    recovery_uidvalidity BIGINT       NOT NULL DEFAULT 0,
    -- Куда вернуть. Путь IMAP, а не наш идентификатор папки — по той же
    -- причине, что у отложенных писем. Обычно это «Trash»: человек
    -- восстанавливает в корзину, а уже оттуда решает, куда положить.
    origin_path          TEXT         NOT NULL,
    -- Запасной ключ поиска, см. пояснение выше. Пусто — письмо пришло
    -- без Message-ID; тогда остаётся только UID.
    message_id           TEXT,
    -- Только ради строки списка: показать, что именно можно вернуть,
    -- не открывая каждое письмо по IMAP.
    subject              TEXT         NOT NULL DEFAULT '',
    from_address         TEXT         NOT NULL DEFAULT '',
    sent_at              TIMESTAMPTZ,
    -- Размер письма. Нужен, чтобы честно показать, сколько квоты занято
    -- уже выброшенным.
    size_bytes           BIGINT       NOT NULL DEFAULT 0,
    -- Когда человек очистил корзину и когда письмо исчезнет по-настоящему.
    -- Срок считается ОДИН РАЗ, при очистке, по действовавшей тогда
    -- настройке: уменьшив срок с семи дней до одного, человек не должен
    -- задним числом потерять то, что уже лежит.
    deleted_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    purge_at             TIMESTAMPTZ  NOT NULL,
    -- 'pending'  — лежит и ждёт (единственное живое состояние);
    -- 'restored' — человек вернул письмо;
    -- 'purged'   — срок вышел, письмо удалено по-настоящему;
    -- 'gone'     — письма в «Recovery» больше нет (убрали мимо нас).
    state                VARCHAR(16)  NOT NULL DEFAULT 'pending',
    -- Сколько раз удаление срывалось. Не повод сдаться: срыв — это почти
    -- всегда недоступный Dovecot, и он проходит сам.
    attempts             INT          NOT NULL DEFAULT 0,
    last_error           TEXT,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    closed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trash_recovery_due_idx
    ON trash_recovery_items (purge_at)
    WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS trash_recovery_account_idx
    ON trash_recovery_items (lower(account_email), deleted_at DESC, id DESC)
    WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS trash_recovery_live_key
    ON trash_recovery_items (lower(account_email), recovery_path, recovery_uidvalidity, recovery_uid)
    WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS muted_threads (
    id                 BIGSERIAL    PRIMARY KEY,
    account_email      VARCHAR(320) NOT NULL,
    -- Ключ переписки для показа и снятия: Message-ID самого раннего письма
    -- из тех, что были видны в момент заглушения (без угловых скобок).
    -- Это НЕ «корень» цепочки в строгом смысле — корень мог быть удалён
    -- или вовсе не приходить, — а устойчивое имя записи, по которому
    -- человек снимает заглушку.
    thread_key         TEXT         NOT NULL,
    -- Message-ID писем переписки (без угловых скобок). Именно этот список
    -- превращается в условие Sieve.
    message_ids        TEXT[]       NOT NULL DEFAULT '{}',
    -- Только для строки подборки «Заглушённые»: показать человеку, что
    -- именно он заглушил, не открывая переписку.
    subject            TEXT         NOT NULL DEFAULT '',
    -- Кто писал последним на момент заглушения.
    from_address       TEXT         NOT NULL DEFAULT '',
    -- 'muted'  — заглушено (единственное живое состояние);
    -- 'lifted' — человек вернул переписку во «Входящие».
    -- Снятые записи не удаляются: по ним видно, что заглушку снимали,
    -- и повторное заглушение той же переписки не заводит дубль.
    state              VARCHAR(16)  NOT NULL DEFAULT 'muted',
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    lifted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS muted_threads_account_idx
    ON muted_threads (lower(account_email), created_at DESC)
    WHERE state = 'muted';
CREATE UNIQUE INDEX IF NOT EXISTS muted_threads_key
    ON muted_threads (lower(account_email), thread_key);

CREATE TABLE IF NOT EXISTS awaiting_replies (
    id                 BIGSERIAL    PRIMARY KEY,
    account_email      VARCHAR(320) NOT NULL,
    -- Где лежит отправленное письмо. Путь IMAP, а не наш идентификатор
    -- папки: идентификатор `f-<base64url(путь)>` — это форма показа, и
    -- завязывать на неё хранение значило бы, что правила показа ломают
    -- напоминание.
    sent_path          TEXT         NOT NULL,
    sent_uid           BIGINT       NOT NULL,
    -- UIDVALIDITY папки на момент постановки срока. Разошёлся — номер выше
    -- ничего не значит, и письмо ищется по Message-ID.
    sent_uidvalidity   BIGINT       NOT NULL DEFAULT 0,
    -- Message-ID отправленного письма БЕЗ угловых скобок. Обязателен:
    -- без него ждать ответа не по чему (см. пояснение выше), поэтому
    -- маршрут отказывает сразу и внятно, а не заводит запись, которая
    -- потом напомнит впустую.
    message_id         TEXT         NOT NULL,
    -- Для строки подборки «Ждут ответа» и для запасной проверки.
    subject            TEXT         NOT NULL DEFAULT '',
    -- Адреса из поля «Кому», через запятую. Именно «Кому», а не «Копия»:
    -- ответа ждут от того, кому написали, а не от тех, кто читает.
    to_addresses       TEXT         NOT NULL DEFAULT '',
    -- Когда письмо было отправлено: запасная проверка смотрит только на
    -- письма, пришедшие ПОСЛЕ этого момента.
    sent_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Когда напоминать, если ответа не будет. Момент времени, а не «дата
    -- и время»: «через три дня» — это три дня ЧЕЛОВЕКА, и превращение
    -- в момент происходит один раз, по поясу браузера.
    due_at             TIMESTAMPTZ  NOT NULL,
    time_zone          VARCHAR(64),
    preset             VARCHAR(32)  NOT NULL DEFAULT 'custom',
    -- 'waiting'   — ждём ответа (единственное живое состояние);
    -- 'answered'  — ответ пришёл, напоминать не о чем;
    -- 'reminded'  — срок вышел, ответа нет, письмо поднято на глаза;
    -- 'cancelled' — человек нажал «больше не ждать»;
    -- 'gone'      — отправленного письма в ящике больше нет.
    state              VARCHAR(16)  NOT NULL DEFAULT 'waiting',
    -- Чем именно опознан ответ: 'references' | 'subject'. Пусто — ответа
    -- не было. Хранится ради разбора жалоб «оно напомнило зря»: по этому
    -- полю видно, какая из двух проверок сработала.
    answer_kind        VARCHAR(16),
    answered_at        TIMESTAMPTZ,
    reminded_at        TIMESTAMPTZ,
    -- Сколько раз проверка срывалась. НЕ повод сдаться: срыв — это почти
    -- всегда недоступный Dovecot, а недоступность проходит сама.
    attempts           INT          NOT NULL DEFAULT 0,
    last_error         TEXT,
    last_attempt_at    TIMESTAMPTZ,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    closed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS awaiting_replies_due_idx
    ON awaiting_replies (due_at)
    WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS awaiting_replies_account_idx
    ON awaiting_replies (lower(account_email), due_at)
    WHERE state = 'waiting';
CREATE UNIQUE INDEX IF NOT EXISTS awaiting_replies_live_key
    ON awaiting_replies (lower(account_email), message_id)
    WHERE state = 'waiting';

CREATE TABLE IF NOT EXISTS mail_labels (
    id            BIGSERIAL    PRIMARY KEY,
    account_email VARCHAR(320) NOT NULL,
    -- Ключевое слово IMAP, лежащее в письмах. Всегда с приставкой `mt-`:
    -- она отделяет метки человека от служебных слов продукта, которые
    -- продукт может завести ЗАВТРА (см. RESERVED_KEYWORDS в mail/labels.ts).
    label_key     VARCHAR(64)  NOT NULL,
    -- Имя для человека: кириллица, пробелы, что угодно.
    name          VARCHAR(64)  NOT NULL,
    -- Идентификатор цвета из закрытого набора ('red', 'blue', …), а НЕ
    -- строка вида '#ff0000': цвет попадает в разметку интерфейса, и
    -- произвольное значение из базы означало бы, что туда доезжает ввод
    -- пользователя. Набор проверяет API, а не база: новый цвет не должен
    -- требовать миграции.
    color         VARCHAR(16)  NOT NULL DEFAULT 'blue',
    -- Порядок в справочнике и в пилюлях на письме.
    position      INT          NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_labels_key_idx
    ON mail_labels (lower(account_email), label_key);
CREATE INDEX IF NOT EXISTS mail_labels_account_idx
    ON mail_labels (lower(account_email), position, id);

CREATE TABLE IF NOT EXISTS mail_templates (
    id            BIGSERIAL    PRIMARY KEY,
    account_email VARCHAR(320) NOT NULL,
    -- Название — то, что человек видит в меню «Шаблоны». Обязательно:
    -- шаблон без имени в списке из пятнадцати штук не найти.
    name          VARCHAR(120) NOT NULL,
    -- Тема письма. Пустая допустима: бывает шаблон одного лишь текста
    -- («реквизиты»), который вставляют в уже начатое письмо.
    subject       VARCHAR(512) NOT NULL DEFAULT '',
    -- Тело письма разметкой — ровно тем, что лежит в окне написания.
    -- Приходит уже вычищенной (см. apps/api/src/templates/sanitize.ts):
    -- в базе не должно оказаться ничего, что нельзя вставить в письмо.
    body_html     TEXT         NOT NULL DEFAULT '',
    -- Порядок в меню и в настройках. Задаёт человек, а не дата создания:
    -- три ходовых шаблона обязаны стоять сверху, даже если заведены давно.
    position      INT          NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_templates_name_idx
    ON mail_templates (lower(account_email), lower(name));
CREATE INDEX IF NOT EXISTS mail_templates_account_idx
    ON mail_templates (lower(account_email), position, id);

CREATE TABLE IF NOT EXISTS mail_template_attachments (
    id           BIGSERIAL    PRIMARY KEY,
    -- Вложение без шаблона не существует: ON DELETE CASCADE, а не уборка
    -- кодом. Уборка кодом означала бы, что оборванное удаление оставляет
    -- в базе байты, на которые никто уже не сошлётся, — и найти их нечем.
    template_id  BIGINT       NOT NULL
                 REFERENCES mail_templates (id) ON DELETE CASCADE,
    filename     VARCHAR(255) NOT NULL,
    mime_type    VARCHAR(160) NOT NULL DEFAULT 'application/octet-stream',
    -- Размер хранится отдельно от содержимого нарочно: список шаблонов
    -- показывает «прайс.pdf, 240 КБ», и тянуть ради этого сами байты из
    -- базы (а их могут быть мегабайты на каждый шаблон) незачем.
    size         INT          NOT NULL DEFAULT 0,
    content      BYTEA        NOT NULL,
    position     INT          NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_template_attachments_template_idx
    ON mail_template_attachments (template_id, position, id);

CREATE TABLE IF NOT EXISTS mail_saved_searches (
    id            BIGSERIAL    PRIMARY KEY,
    account_email VARCHAR(320) NOT NULL,
    -- Имя, которое человек дал запросу: «Счета от Волковой».
    name          VARCHAR(64)  NOT NULL,
    -- Сама строка поиска со всеми операторами, как её набрали.
    -- Предел тот же, что у параметра `search` в API (500 символов):
    -- сохранить нельзя то, что нельзя выполнить.
    query         VARCHAR(500) NOT NULL,
    -- Искать ли в Спаме и Корзине. Единственное, что НЕ выражается
    -- строкой запроса: это не условие отбора писем, а выбор области,
    -- куда поиск вообще заглядывает (в фоне эти папки не индексируются,
    -- см. docs/search.md).
    include_junk  BOOLEAN      NOT NULL DEFAULT FALSE,
    -- Порядок показа в левой колонке.
    position      INT          NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_saved_searches_name_idx
    ON mail_saved_searches (lower(account_email), lower(name));
CREATE INDEX IF NOT EXISTS mail_saved_searches_account_idx
    ON mail_saved_searches (lower(account_email), position, id);

-- ==================================================================
-- 12. АДРЕСНАЯ КНИГА
-- ==================================================================

CREATE TABLE IF NOT EXISTS mail_contacts (
    -- Владелец. Хранится приведённым к нижнему регистру — приводит API
    -- (нормализация одна на всех, см. contacts/tokens.ts), поэтому в
    -- запросах не нужен lower() и работает индекс первичного ключа.
    account_email VARCHAR(320) NOT NULL,
    -- Адрес корреспондента, тоже в нижнем регистре. Регистр локальной
    -- части по RFC значим, но на практике его не различает ни один
    -- почтовый сервер, а различение здесь дало бы две записи об одном
    -- человеке и два одинаковых пункта в подсказке.
    address       VARCHAR(320) NOT NULL,
    -- Имя из последнего письма. Именно последнего, а не первого: люди
    -- меняют фамилию и подпись, и подсказка обязана показывать то, как
    -- человек называет себя сейчас.
    display_name  TEXT,
    -- Строка поиска: слова имени, адрес целиком и его части, всё в нижнем
    -- регистре через пробел. Считается при записи, а не при поиске.
    --
    -- Почему отдельным столбцом, а не выражением в WHERE: поиск идёт по
    -- НАЧАЛУ слова («иван», «петров», «iva» — три разных способа вспомнить
    -- одного человека), и без готовой строки каждый запрос заново собирал
    -- бы её из имени и адреса для каждой строки таблицы.
    tokens        TEXT         NOT NULL,
    -- Сколько раз человек писал ЭТОМУ адресу сам.
    sent_count    INTEGER      NOT NULL DEFAULT 0,
    -- Сколько писем пришло С этого адреса.
    --
    -- Два счётчика, а не один, потому что вес у них разный: тому, кому
    -- писали сами, ошибиться адресом почти невозможно, а среди приходящей
    -- почты полно рассылок, роботов и «no-reply». Их складывает
    -- contacts/rank.ts с разными коэффициентами.
    recv_count    INTEGER      NOT NULL DEFAULT 0,
    first_seen_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Дата последнего письма в любую сторону. Порядок подсказок не
    -- алфавитный: сверху те, с кем переписывались чаще и недавнее.
    last_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Убран из подсказок человеком.
    --
    -- ПОЧЕМУ ПРИЗНАК, А НЕ УДАЛЕНИЕ СТРОКИ. Указатель — производная от
    -- содержимого ящика: письмо, из которого адрес взят, никуда не делось,
    -- и следующий же проход сборщика вернул бы удалённую строку обратно.
    -- Человек, убравший опечатку «ivan@exmaple.com», увидел бы её снова
    -- через минуту и решил бы, что удаление не работает. Признак переживает
    -- повторный сбор: сборщик обновляет счётчики и имя, но hidden не трогает.
    hidden        BOOLEAN      NOT NULL DEFAULT false,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (account_email, address)
);
CREATE INDEX IF NOT EXISTS mail_contacts_suggest_idx
    ON mail_contacts (account_email, last_seen_at DESC)
    WHERE NOT hidden;

CREATE TABLE IF NOT EXISTS mail_contact_cursors (
    account_email VARCHAR(320) NOT NULL,
    -- 'inbox' — отправители полученных писем, 'sent' — получатели
    -- отправленных. Роль, а не путь папки: путь у «Отправленных» зависит
    -- от языка и настроек клиента, роль же вычисляется по флагу \Sent
    -- (см. mail/folders.ts) и не меняется от переименования папки.
    folder_role   VARCHAR(16)  NOT NULL,
    -- UIDVALIDITY папки. Смена значения по RFC 3501 означает «прежние
    -- номера ничего не значат»; тогда сбор начинается заново, иначе
    -- сборщик пропустил бы всю папку, приняв чужие номера за свои.
    uid_validity  BIGINT       NOT NULL DEFAULT 0,
    top_uid       BIGINT       NOT NULL DEFAULT 0,
    bottom_uid    BIGINT       NOT NULL DEFAULT 0,
    backfill_done BOOLEAN      NOT NULL DEFAULT false,
    -- Сколько писем разобрано всего. Нужно не для отчётности, а для
    -- честного ответа интерфейсу: пока указатель неполон, об этом можно
    -- сказать, а не делать вид, что подсказка знает всё.
    scanned       BIGINT       NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (account_email, folder_role)
);

-- ==================================================================
-- 13. ОДНОРАЗОВЫЕ АДРЕСА
-- ==================================================================

CREATE TABLE IF NOT EXISTS disposable_aliases (
    -- Ключ и он же связь: одна строка на один алиас.
    -- ON DELETE CASCADE — чтобы удаление алиаса администратором не
    -- оставляло здесь висящую строку про несуществующий адрес.
    alias_id    INT PRIMARY KEY REFERENCES virtual_aliases(id) ON DELETE CASCADE,
    -- Чей это адрес. Дублирует destination алиаса намеренно: по нему идёт
    -- отбор списка, и он не должен зависеть от того, не переписал ли кто-то
    -- destination в обход раздела. Если эти два значения разойдутся,
    -- владельцем считается тот, кто здесь, а адрес показывается как
    -- испорченный — молча отдать чужой адрес нельзя.
    owner_email VARCHAR(320) NOT NULL,
    -- Кому выдан: «Магазин обуви», «форум по рыбалке». Личная пометка
    -- владельца ящика, чтобы через год понять, кто продал адрес.
    -- Администратору НЕ показывается: для разбора жалоб нужен маршрут
    -- (кто→куда), а не заметки человека о своей жизни.
    note        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Когда выключен. NULL — работает. Хранится ради одной фразы в
    -- интерфейсе: «выключен 3 марта» отвечает на вопрос «я его точно
    -- выключил или забыл?» лучше, чем серый переключатель.
    disabled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_disposable_owner
    ON disposable_aliases (owner_email, created_at DESC);

-- ==================================================================
-- 14. ЛОГОТИПЫ ОТПРАВИТЕЛЕЙ
-- ==================================================================

CREATE TABLE IF NOT EXISTS sender_logo_cache (
    domain      VARCHAR(255) PRIMARY KEY,
    -- Откуда взялась картинка: bimi | favicon | NULL (не нашли)
    source      VARCHAR(16),
    mime        VARCHAR(64),
    image       BYTEA,
    width       INTEGER,
    height      INTEGER,
    -- Отпечаток содержимого: попадает в адрес картинки и делает кэш
    -- браузера честным — сменилась картинка, сменился адрес.
    version     VARCHAR(32)  NOT NULL,
    fetched_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Срок годности записи. Просроченную показываем и обновляем в фоне,
    -- чтобы открытие папки не ждало сети.
    expires_at  TIMESTAMPTZ  NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sender_logo_cache_last_used
    ON sender_logo_cache (last_used_at);

CREATE TABLE IF NOT EXISTS sender_logo_overrides (
    domain      VARCHAR(255) PRIMARY KEY,
    -- Логотипа у домена не будет ни при каких источниках.
    blocked     BOOLEAN      NOT NULL DEFAULT false,
    mime        VARCHAR(64),
    image       BYTEA,
    width       INTEGER,
    height      INTEGER,
    -- Отпечаток картинки: попадает в адрес, поэтому кэш браузера не врёт.
    version     VARCHAR(32)  NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Кто изменил: для списка в панели и для разбора «кто это поставил».
    updated_by  VARCHAR(255)
);

-- ==================================================================
-- 15. ЖУРНАЛ ВХОДОВ ВЛАДЕЛЬЦА ЯЩИКА И ВЫГРУЗКА ПОЧТЫ
-- ==================================================================

CREATE TABLE IF NOT EXISTS mailbox_access_log (
    id            BIGSERIAL    PRIMARY KEY,
    -- Чей ящик. Ключ отбора и единственная защита от чужих глаз: маршрут
    -- берёт адрес из сессии, передать чужой негде.
    account_email VARCHAR(320) NOT NULL,
    at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Что произошло: 'login' | 'login.failed' | 'logout' | 'settings' |
    -- 'filters' | 'folders' | 'trash' | 'export'. Набор проверяет API,
    -- а не база: новое действие не должно требовать миграции.
    kind          VARCHAR(32)  NOT NULL,
    -- Каким способом. Здесь всегда 'web': всё остальное ('imap', 'pop3',
    -- 'smtp') приходит из журналов Dovecot и Postfix и в базе не оседает.
    -- Колонка всё равно нужна: без неё показ не отличит свою запись от
    -- журнальной, а строки в таблице на экране стоят вперемешку.
    channel       VARCHAR(16)  NOT NULL DEFAULT 'web',
    -- Удачно или нет. Неудачные входы — половина смысла раздела: три
    -- отказа подряд из чужой страны человек обязан увидеть.
    success       BOOLEAN      NOT NULL DEFAULT TRUE,
    -- Адрес того, кто это сделал. Настоящий адрес человека, а не адрес
    -- контейнера: он берётся из X-Forwarded-For, которому Fastify верит
    -- только от своего обратного прокси (TRUSTED_PROXIES, см. app.ts).
    ip            VARCHAR(64),
    -- Строка браузера или почтовой программы. Обрезается до 512 в коде.
    user_agent    VARCHAR(512),
    -- Короткое пояснение по-русски: «Изменены общие настройки»,
    -- «Очищена папка Корзина (14 писем)». Пишет код, не пользователь.
    detail        TEXT
);
CREATE INDEX IF NOT EXISTS mailbox_access_log_account_idx
    ON mailbox_access_log (lower(account_email), at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mailbox_access_log_at_idx
    ON mailbox_access_log (at);

CREATE TABLE IF NOT EXISTS mailbox_export_jobs (
    id              BIGSERIAL    PRIMARY KEY,
    account_email   VARCHAR(320) NOT NULL,
    -- 'queued'   — стоит в очереди, работник до неё ещё не дошёл;
    -- 'running'  — идёт прямо сейчас;
    -- 'ready'    — файл готов и лежит на диске;
    -- 'failed'   — сорвалось, причина в last_error;
    -- 'cancelled'— человек отменил;
    -- 'expired'  — срок хранения файла вышел, файл удалён.
    -- Набор проверяет API, а не база: новое состояние не должно требовать
    -- миграции.
    state           VARCHAR(16)  NOT NULL DEFAULT 'queued',
    -- Что берём. Спам и корзину человек включает отдельно и осознанно:
    -- в спаме бывает половина объёма ящика, а в корзине — то, что человек
    -- уже решил выбросить.
    include_spam    BOOLEAN      NOT NULL DEFAULT FALSE,
    include_trash   BOOLEAN      NOT NULL DEFAULT FALSE,
    -- Ход работы. Всего писем становится известно после обхода папок —
    -- до этого 0, и интерфейс честно показывает «считаем письма», а не
    -- полоску на нуле процентов.
    total_messages  INT          NOT NULL DEFAULT 0,
    done_messages   INT          NOT NULL DEFAULT 0,
    total_bytes     BIGINT       NOT NULL DEFAULT 0,
    done_bytes      BIGINT       NOT NULL DEFAULT 0,
    -- Письма, которых не удалось прочитать (битое письмо в ящике —
    -- редкость, но встречается). Выгрузку они не останавливают: потерять
    -- весь архив из-за одного письма было бы хуже, чем отдать архив без
    -- него. Число показывается человеку.
    skipped         INT          NOT NULL DEFAULT 0,
    -- Где лежит готовый файл и сколько он весит. Путь внутри контейнера
    -- (том api-uploads); наружу он не отдаётся никогда, скачивание идёт
    -- отдельным маршрутом с проверкой сессии.
    file_path       TEXT,
    file_bytes      BIGINT       NOT NULL DEFAULT 0,
    last_error      TEXT,
    -- Отметка живости работника. Нужна ровно из-за перезапуска: состояние
    -- 'running' переживает падение процесса, и без срока давности задание
    -- залипало бы навсегда — так же, как залипал бы сбор почты с чужих
    -- ящиков без COLLECTOR_STALE_MINUTES.
    heartbeat_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    -- Когда файл будет удалён. Хранить архив с чужой перепиской вечно
    -- нельзя: это копия всего ящика в открытом виде на диске сервера.
    expires_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mailbox_export_jobs_queue_idx
    ON mailbox_export_jobs (created_at, id)
    WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS mailbox_export_jobs_account_idx
    ON mailbox_export_jobs (lower(account_email), created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_export_jobs_live_key
    ON mailbox_export_jobs (lower(account_email))
    WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS mailbox_export_jobs_expiry_idx
    ON mailbox_export_jobs (expires_at)
    WHERE state = 'ready';

-- ==================================================================
-- 16. СОСТОЯНИЕ САМОЙ УСТАНОВКИ: отметка, настройки, перезапуски
-- ==================================================================

CREATE TABLE IF NOT EXISTS install_state (
    -- Единственная допустимая строка таблицы.
    id            boolean     PRIMARY KEY DEFAULT true CHECK (id),
    -- Когда установка завершилась успешно. Именно завершилась: строка
    -- пишется последним шагом, после того как стек поднялся, схема
    -- применилась, а ящик и учётная запись администратора созданы.
    completed_at  timestamptz NOT NULL DEFAULT now(),
    -- Чем ставили: install.sh (консоль) или installer (браузер).
    -- Пригождается в одном разговоре — «как этот сервер вообще ставили».
    installed_by  text        NOT NULL DEFAULT 'install.sh',
    -- Что именно установлено. Веб-установщик показывает это на экране
    -- отказа: человеку нужно понять, что за сервер он чуть не переписал.
    mail_domain   text        NOT NULL DEFAULT '',
    mail_hostname text        NOT NULL DEFAULT '',
    admin_login   text        NOT NULL DEFAULT ''
);
COMMENT ON TABLE install_state IS
    'Отметка «сервер установлен». Ставит install/install.sh, читает apps/installer; снимает install/allow-reinstall.sh.';

CREATE TABLE IF NOT EXISTS server_settings (
    -- Имя переменной окружения — то же, что в infra/.env.example.
    -- Второго имени у настройки нет намеренно: два имени для одного
    -- значения это прямая дорога к «настроил, а не работает».
    key         VARCHAR(128) PRIMARY KEY,
    -- Значение ВСЕГДА строкой, как в окружении. Не JSON и не типизованные
    -- столбцы: разбирает его та же схема, что разбирает переменную
    -- окружения, и другого разбора у настройки быть не должно — иначе
    -- значение из панели и значение из файла проходят разные проверки
    -- и однажды разойдутся.
    value       TEXT         NOT NULL,
    -- Кто и когда поменял. Полный след — в admin_audit_log (там же старое
    -- значение); здесь ровно столько, чтобы панель могла показать
    -- «изменено 5 августа, snimki» рядом с самим полем, не поднимая журнал.
    updated_by  VARCHAR(128),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE server_settings IS
    'Настройки сервера, заданные из панели. Побеждают переменные окружения; '
    'пустая таблица = поведение целиком по infra/.env.';

CREATE TABLE IF NOT EXISTS service_restarts (
    id           BIGSERIAL    PRIMARY KEY,
    -- Имя службы из закрытого списка (api, postfix, dovecot, nginx,
    -- rspamd, unbound, autoconfig). Не имя контейнера: оно зависит от
    -- имени проекта Docker Compose и на разных стендах разное.
    service      VARCHAR(64)  NOT NULL,
    -- Что делали:
    --   restart   — перезапуск процесса в том же контейнере;
    --   recreate  — пересоздание контейнера (нужно, когда служба читает
    --               настройку из окружения: окружение задаётся при
    --               СОЗДАНИИ контейнера, и перезапуск его не меняет);
    --   boot      — отметка «процесс сервера приложения запустился».
    --               Её ставит сам процесс при старте, администратора у
    --               неё нет. Нужна для защиты от петли перезапусков.
    action       VARCHAR(16)  NOT NULL,
    -- Логин администратора. NULL у отметок boot: их никто не заказывал.
    requested_by VARCHAR(128),
    requested_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Когда стало известно, чем кончилось. NULL, пока идёт.
    finished_at  TIMESTAMPTZ,
    -- pending — идёт (или процесс умер, не успев дописать);
    -- ok      — служба поднялась;
    -- failed  — не поднялась, причина в detail.
    status       VARCHAR(16)  NOT NULL DEFAULT 'pending',
    -- Что ответила служба или посредник. Показывается человеку как есть,
    -- поэтому здесь текст, а не код: «код 137» не объясняет ничего.
    detail       TEXT
);
CREATE INDEX IF NOT EXISTS service_restarts_service_time_idx
    ON service_restarts (service, requested_at DESC);
CREATE INDEX IF NOT EXISTS service_restarts_time_idx
    ON service_restarts (requested_at DESC);
COMMENT ON TABLE service_restarts IS
    'Рабочее состояние перезапусков служб из панели: что применяли, чем кончилось, '
    'когда служба применялась в последний раз. След «кто это сделал» — в admin_audit_log.';

CREATE TABLE IF NOT EXISTS api_service_addresses (
    -- Адрес в том же виде, в каком он попадает в журнал Dovecot (`rip=`):
    -- IPv4 точками, IPv6 без обёртки `::ffff:`.
    ip          VARCHAR(64)  PRIMARY KEY,
    -- Когда этот адрес впервые оказался нашим. Показывать пока негде,
    -- но без него нельзя ответить на вопрос «с каких пор это мы».
    first_seen  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Когда процесс в последний раз видел адрес своим. По нему и стареет
    -- строка: пересобранный контейнер перестаёт обновлять старый адрес.
    last_seen   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_service_addresses_last_seen_idx
    ON api_service_addresses (last_seen);
COMMENT ON TABLE api_service_addresses IS
    'Адреса самого сервера приложения: по ним раздел «Вход и действия» отличает '
    'служебные подключения веб-интерфейса от входов человека. Заполняет процесс сам.';

-- ==================================================================
-- 17. СМЕНА ОСНОВНОГО ДОМЕНА
-- ==================================================================

CREATE TABLE IF NOT EXISTS domain_change_jobs (
    id              BIGSERIAL PRIMARY KEY,
    -- Кто затеял. admin_id может обнулиться при удалении администратора,
    -- поэтому логин хранится строкой рядом: через год важно не «кто из
    -- существующих», а «кто это сделал тогда».
    admin_id        INT,
    admin_login     VARCHAR(128) NOT NULL,
    -- Что на что меняем. old_domain пишется в момент составления плана,
    -- а не берётся из настроек при выполнении: между планом и запуском
    -- основной домен теоретически может успеть измениться, и тогда план
    -- относится уже не к тому серверу.
    old_domain      VARCHAR(255) NOT NULL,
    new_domain      VARCHAR(255) NOT NULL,
    old_hostname    VARCHAR(255) NOT NULL,
    new_hostname    VARCHAR(255) NOT NULL,
    -- Ключ DKIM нового домена. Выпускается на шаге плана, ДО любых
    -- изменений: запись в DNS расходится по интернету часами, и человек
    -- должен опубликовать её заранее, иначе первые письма с нового адреса
    -- уйдут без подписи.
    --
    -- Приватная часть — ТОЛЬКО шифротекстом (AES-256-GCM тем же секретом,
    -- что и пароли заданий переноса). Наружу она не отдаётся ни одним
    -- маршрутом панели: её забирает скрипт infra/scripts/change-domain.sh,
    -- который кладёт ключ в том rspamd. Без секрета шифрования ключ не
    -- сохраняется вовсе — лучше отказать в смене домена, чем положить
    -- приватный ключ в базу открытым.
    dkim_selector   VARCHAR(64)  NOT NULL DEFAULT 'mail',
    dkim_public_key TEXT,
    dkim_private_enc TEXT,
    -- planned   — план составлен, сервер не тронут, отмена бесплатна
    -- running   — идёт выполнение
    -- done      — выполнено
    -- failed    — сорвалось; в error написано, на каком шаге и что делать
    -- cancelled — человек отказался до точки невозврата
    state           VARCHAR(16)  NOT NULL DEFAULT 'planned',
    -- Точка невозврата: момент, когда письма и адреса уже переехали.
    -- NULL означает «ещё можно отменить бесплатно», и именно по этому
    -- полю интерфейс решает, показывать кнопку отмены или объяснение,
    -- почему её больше нет.
    point_of_no_return_at TIMESTAMPTZ,
    -- Снимок плана, который человек видел перед запуском. Хранится целиком
    -- и намеренно: через полгода вопрос «а сколько там было ящиков и что
    -- обещали» решается этой строкой, а не догадками.
    plan            JSONB,
    -- Шаги выполнения со своими состояниями — то, что видно полосой хода
    -- работ. Массив, а не отдельная таблица: шагов десяток, они всегда
    -- читаются целиком и только вместе со своим заданием.
    steps           JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Итоги переноса числами: сколько ящиков, алиасов, писем и байт.
    mailboxes       INT          NOT NULL DEFAULT 0,
    aliases         INT          NOT NULL DEFAULT 0,
    messages        BIGINT       NOT NULL DEFAULT 0,
    bytes           BIGINT       NOT NULL DEFAULT 0,
    -- Где лежит резервная копия настроек, снятая перед началом.
    -- Путь внутри контейнера (том api-uploads); наружу не отдаётся.
    backup_path     TEXT,
    backup_bytes    BIGINT       NOT NULL DEFAULT 0,
    error           TEXT,
    -- Кто ведёт задание СЕЙЧАС и когда подавал признаки жизни. После
    -- перезапуска контейнера идентификатор другой, а биение старого
    -- перестаёт обновляться — по этому брошенное задание и опознаётся.
    runner          VARCHAR(64),
    heartbeat_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    CONSTRAINT domain_change_jobs_state_check
        CHECK (state IN ('planned', 'running', 'done', 'failed', 'cancelled')),
    -- Смена домена «на самого себя» — не смена, а способ сломать сервер
    -- переименованием каталога в самого себя. Проверка стоит и в коде,
    -- и здесь: в коде — чтобы объяснить по-русски, здесь — чтобы такая
    -- строка не появилась вообще никаким путём.
    CONSTRAINT domain_change_jobs_distinct_check
        CHECK (lower(old_domain) <> lower(new_domain))
);
CREATE UNIQUE INDEX IF NOT EXISTS domain_change_jobs_single_live_idx
    ON domain_change_jobs ((1))
    WHERE state IN ('planned', 'running');
CREATE INDEX IF NOT EXISTS domain_change_jobs_created_idx
    ON domain_change_jobs (created_at DESC);

-- ==================================================================
-- 18. ОТМЕТКА О САМОЙ СЕБЕ
-- ==================================================================
-- Единственный INSERT во всём файле, и он служебный.
--
-- Зачем. При установке с нуля каталог миграций выполняет сам Postgres
-- (том смонтирован в /docker-entrypoint-initdb.d), и он ничего не знает
-- про журнал: схема появляется, а записи о ней нет. Установщик, запущенный
-- следом, увидел бы полную схему при пустом журнале — то есть картину
-- «сервер обновляется с версии, где миграции лежали россыпью», — и полез
-- бы доводить свежайшую базу старыми файлами из legacy/. Безвредно, но
-- нелепо: три десятка лишних прогонов и три десятка ложных строк в
-- журнале новорождённого сервера.
--
-- Контрольная сумма здесь заведомо неверная ('initdb' вместо sha256):
-- файл не может посчитать сумму самого себя. Установщик увидит
-- расхождение и перезапишет отметку настоящей суммой, НЕ выполняя файл
-- (см. _mig_baseline в install/lib/common.sh).
--
-- DO-блок, а не голый INSERT: журнал заводится миграцией 0000, и если
-- эту схему применяют руками к базе, где 0000 ещё не выполнялась, отказ
-- всей схемы из-за служебной отметки был бы худшим из исходов.
DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        INSERT INTO schema_migrations (filename, version, name, checksum, applied_by)
        VALUES ('0001_baseline.sql', '0001', 'baseline', 'initdb', 'initdb')
        ON CONFLICT (filename) DO NOTHING;
    END IF;
END
$$;

COMMIT;
