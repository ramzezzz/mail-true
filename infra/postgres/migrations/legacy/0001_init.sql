-- Миграция 0001: базовая схема почтового сервера.
-- Выполняется автоматически при первичной инициализации контейнера postgres
-- (docker-entrypoint-initdb.d). Для существующей БД применять вручную:
--   docker compose -f infra/docker-compose.yml exec -T postgres \
--     psql -U $POSTGRES_USER -d $POSTGRES_DB < infra/postgres/migrations/0001_init.sql

-- Виртуальные домены
CREATE TABLE IF NOT EXISTS virtual_domains (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Виртуальные ящики. password — хэш в формате dovecot ({SHA512-CRYPT}$6$... или {ARGON2ID}$argon2id$...)
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
