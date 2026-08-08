-- Миграция 0004: помощник на основе ИИ.
--
-- Три уровня настройки из docs/ai-spec.md:
--   администратор -> ai_domain_settings (разрешён ли ИИ по домену, какой
--                    сервис, ключ доступа, модель, предел расходов)
--   пользователь  -> ai_user_settings   (согласие и набор включённых
--                    возможностей лично у него)
--   действие      -> решается в коде при вызове конкретного маршрута
--
-- Главный принцип: помощник ВЫКЛЮЧЕН по умолчанию. Значения по умолчанию
-- в схеме выбраны так, что свежесозданная строка означает «ИИ запрещён».
--
-- Ключ доступа хранится ТОЛЬКО в зашифрованном виде (api_key_enc).
-- Ключ шифрования берётся из переменной окружения AI_ENCRYPTION_KEY и
-- рядом с базой не лежит: дамп базы без переменной окружения бесполезен.
-- api_key_hint — последние символы ключа для опознания в админке,
-- по ним ключ восстановить нельзя.
--
--   docker compose -f infra/docker-compose.yml exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U mailserver -d mailserver \
--     < infra/postgres/migrations/0004_ai.sql
--
-- Скрипт идемпотентен (IF NOT EXISTS везде), повторное применение безвредно.

BEGIN;

-- ------------------------------------------------------------------
-- Уровень «администратор»: настройки ИИ по домену.
-- Один-к-одному с virtual_domains, каскадно удаляется вместе с доменом.
--
-- Пока enabled = FALSE, пользователи этого домена не увидят ни одной
-- кнопки ИИ — не «увидят и получат отказ», а именно не увидят.
-- ------------------------------------------------------------------
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

-- Строки для уже существующих доменов создаём сразу: админка должна
-- показывать раздел ИИ, а не пустоту. enabled = FALSE, то есть выключено.
INSERT INTO ai_domain_settings (domain_id)
SELECT d.id FROM virtual_domains d
WHERE NOT EXISTS (SELECT 1 FROM ai_domain_settings s WHERE s.domain_id = d.id);

-- ------------------------------------------------------------------
-- Уровень «пользователь»: согласие и набор возможностей.
--
-- Строки нет => согласия нет. Согласие фиксируется вместе с тем, НА ЧТО
-- пользователь соглашался: адрес сервиса и модель на момент нажатия.
-- Если администратор сменит сервис, старое согласие перестанет
-- соответствовать текущему, и его нужно будет спросить заново —
-- человек соглашался отправлять письма конкретному адресату.
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- Журнал обращений к ИИ.
--
-- Требование спецификации: всё, что уходит наружу, пишется в журнал —
-- когда, какое письмо, сколько токенов, — чтобы администратор мог
-- проверить и посчитать. Записи из кэша тоже попадают сюда,
-- но с cached = TRUE: наружу они не уходили, и это должно быть видно.
--
-- Тела писем в журнал НЕ попадают — только длина отправленного текста.
-- ------------------------------------------------------------------
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

COMMIT;
