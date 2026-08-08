-- Миграция 0003: схема админки Mail.True.
--
-- Ничего не меняет в virtual_domains / virtual_users / virtual_aliases —
-- это контракт с Postfix и Dovecot. Добавляются только новые таблицы,
-- поэтому миграцию безопасно применять к УЖЕ РАБОТАЮЩЕЙ базе:
--
--   docker compose -f infra/docker-compose.yml exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U mailserver -d mailserver \
--     < infra/postgres/migrations/0003_admin.sql
--
-- Скрипт идемпотентен (IF NOT EXISTS везде), повторное применение безвредно.

BEGIN;

-- ------------------------------------------------------------------
-- Администраторы. Полностью отдельно от почтовых ящиков: свой логин,
-- свой пароль, свои сессии. Владелец ящика никогда не входит в админку
-- почтовыми учётными данными.
--
-- Роль:
--   owner        — полный доступ, включая управление администраторами
--   user_manager — пользователи, алиасы, вход в ящик; домены только чтение
--   readonly     — только чтение, ни одного изменяющего действия
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
    id             SERIAL PRIMARY KEY,
    login          VARCHAR(128) NOT NULL UNIQUE,
    -- Хэш формата scrypt$N$r$p$<salt b64url>$<hash b64url> (см. apps/api/src/admin/passwords.ts).
    -- Намеренно НЕ формат Dovecot: это не почтовый пароль, Dovecot его не читает.
    password_hash  VARCHAR(512) NOT NULL,
    display_name   VARCHAR(255),
    role           VARCHAR(32)  NOT NULL DEFAULT 'readonly',
    -- Двухфакторная аутентификация (TOTP): секрет и признак включения.
    -- Схема готова заранее, проверка кода появится следующим этапом.
    totp_secret    VARCHAR(128),
    totp_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at  TIMESTAMPTZ,
    last_login_ip  VARCHAR(64),
    -- Защита от перебора пароля: счётчик неудач и блокировка до момента времени
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_users_role_check
        CHECK (role IN ('owner', 'user_manager', 'readonly'))
);

-- ------------------------------------------------------------------
-- Журнал аудита. Пишется на каждое изменяющее действие.
-- Из интерфейса не удаляется и не правится — только читается.
-- admin_id ON DELETE SET NULL, но admin_login хранится строкой,
-- чтобы запись оставалась читаемой после удаления администратора.
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- Вход администратора в чужой ящик. Отдельная запись на каждый вход:
-- кто вошёл, в чей ящик, когда, зачем. Причина обязательна —
-- на уровне схемы (NOT NULL + CHECK на непустую строку).
-- ------------------------------------------------------------------
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
    CONSTRAINT admin_mailbox_access_reason_check
        CHECK (length(btrim(reason)) >= 3)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_access_mailbox ON admin_mailbox_access (mailbox_email, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_access_admin   ON admin_mailbox_access (admin_login, started_at DESC);

-- ------------------------------------------------------------------
-- Настройки домена: DKIM и состояние проверки DNS.
-- Один-к-одному с virtual_domains, каскадно удаляется вместе с доменом.
-- dns_status — снимок последней проверки в JSON (по одной записи на
-- проверку: MX, SPF, DKIM, DMARC, PTR, autoconfig, autodiscover).
-- ------------------------------------------------------------------
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

-- Настройки для уже существующих доменов создаём сразу,
-- чтобы админка не показывала пустоту на живой базе.
INSERT INTO domain_settings (domain_id)
SELECT d.id FROM virtual_domains d
WHERE NOT EXISTS (SELECT 1 FROM domain_settings s WHERE s.domain_id = d.id);

COMMIT;
