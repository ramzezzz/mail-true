-- Миграция 0011: перенос почты с чужого сервера как ЗАДАНИЕ панели.
--
--   docker compose -f infra/docker-compose.yml exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U mailserver -d mailserver \
--     < infra/postgres/migrations/0011_migration_jobs.sql
--
-- Скрипт идемпотентен (IF NOT EXISTS везде), повторное применение безвредно.
--
-- ------------------------------------------------------------------
-- ЗАЧЕМ ЭТО ТАБЛИЦЫ, А НЕ ПАМЯТЬ ПРОЦЕССА
--
-- Перенос ящика с Kerio Connect идёт часами, а сотни ящиков — сутками.
-- Задание, живущее в памяти сервера приложения, исчезает при обновлении
-- образа, при перезапуске контейнера и при любом падении: администратор
-- возвращается к пустому экрану и не знает даже, что успело переехать.
-- Поэтому задание — строка в базе, а сервер приложения её ПОДХВАТЫВАЕТ
-- при старте (см. apps/api/src/admin/migrate-runner.ts). Тот же приём
-- уже применён для отложенной отправки (файлы на постоянном томе) и для
-- импорта ящиков из CSV (таблица user_import_jobs) — третьего способа
-- здесь не заводится.
--
-- Докачка после обрыва обеспечивается НЕ этими таблицами, а состоянием
-- переноса (migrate_messages / migrate_cursors). Они объявлены в
-- 0021_code_created_tables.sql; пакет packages/migrate дополнительно
-- создаёт их сам, потому что его можно направить и на чужую базу.
-- Здесь — только само задание: что переносим, куда, чем закончилось.
--
-- ------------------------------------------------------------------
-- ПАРОЛИ
--
-- Пароли исходных ящиков нужны на ВСЁ время переноса: сервер обязан
-- уметь переподключиться после обрыва в три часа ночи, и спросить их
-- в этот момент не у кого. Поэтому они лежат в secret_enc — одним
-- зашифрованным свёртком (SecretBox, AES-256-GCM, ключ выводится из
-- ADMIN_SESSION_SECRET/SESSION_SECRET и в базе не лежит). Это тот же
-- ящик, под которым лежит пароль в почтовой сессии и в очереди
-- отложенной отправки.
--
-- Столбца с открытым паролем в этой схеме нет ни одного. secret_enc
-- обнуляется В ТОЙ ЖЕ транзакции, которая переводит задание в конечное
-- состояние: пароль живёт ровно столько, сколько живёт задание.
--
-- Лучший режим — служебный доступ (master user): один пароль на весь
-- перенос вместо пароля каждого владельца. Имя служебного пользователя
-- секретом не является и лежит открытым столбцом — по нему видно, каким
-- доступом пользовались.
-- ------------------------------------------------------------------

BEGIN;

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
-- Работник ищет незавершённые задания — по этому индексу и ищет.
CREATE INDEX IF NOT EXISTS idx_migration_jobs_live
    ON mail_migration_jobs (heartbeat_at) WHERE state IN ('queued', 'running');

-- ------------------------------------------------------------------
-- Строка на ящик. Отдельная таблица, а не JSON в задании, по одной
-- причине: числа в ней меняются ПО ХОДУ переноса (раз в несколько
-- секунд, часами). Переписывать ради этого один большой документ —
-- значит переписывать и отчёты уже завершённых ящиков.
--
-- И главное, ради чего эта таблица существует: «повторить только
-- неудавшиеся». Без построчного итога после суток переноса известно
-- лишь «часть ящиков не доехала», и повторять приходится всё.
-- ------------------------------------------------------------------
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

    CONSTRAINT mail_migration_items_state_check
        CHECK (state IN ('queued', 'running', 'ok', 'partial', 'failed', 'stopped')),
    CONSTRAINT mail_migration_items_position_uniq UNIQUE (job_id, position)
);
CREATE INDEX IF NOT EXISTS idx_migration_items_job
    ON mail_migration_items (job_id, position);

COMMIT;
