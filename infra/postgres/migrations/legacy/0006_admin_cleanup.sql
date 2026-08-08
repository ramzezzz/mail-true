-- Миграция 0006: уборка после удаления ящика, честное завершение
-- административных сеансов и переживающий обрыв связи импорт.
--
-- Ничего не меняет в virtual_domains / virtual_users / virtual_aliases —
-- это контракт с Postfix и Dovecot. Добавляются новые таблицы и два
-- необязательных столбца в АДМИНСКОЙ таблице admin_mailbox_access,
-- которую читает только админка.
--
--   docker compose -f infra/docker-compose.yml exec -T postgres \
--     psql -v ON_ERROR_STOP=1 -U mailserver -d mailserver \
--     < infra/postgres/migrations/0006_admin_cleanup.sql
--
-- Скрипт идемпотентен (IF NOT EXISTS везде), повторное применение безвредно.

BEGIN;

-- ------------------------------------------------------------------
-- 1. Уборка после удаления ящика.
--
-- Раньше удаление ящика убирало только строку из virtual_users. На диске
-- оставался Maildir целиком (десятки мегабайт на ящик), а в служебных
-- таблицах — настройки, подписи, правила и сотни строк состояния переноса.
-- Хуже того: при повторном создании ящика с тем же адресом новый владелец
-- видел ЧУЖУЮ старую почту — Dovecot просто открывал уцелевший каталог.
--
-- Выбранный порядок: «карантин сразу, физическое удаление — уборщиком».
--
--   * Каталог ящика переименовывается в <домен>/.deleted/<ящик>.<id>
--     ПРЯМО в обработчике запроса. Переименование мгновенно и атомарно,
--     поэтому воскресший ящик с тем же адресом гарантированно пуст —
--     а это самое опасное последствие дефекта.
--   * Физическое удаление дерева каталогов делает фоновый уборщик:
--     rm -rf на 18 МБ внутри HTTP-запроса — это ожидание на ровном месте,
--     а на большом ящике ещё и таймаут nginx.
--   * Строка здесь остаётся навсегда и после уборки: это учётная запись
--     о том, что было удалено, кем и когда, и сколько места освободилось.
--
-- Отсрочка (purge_after) настраивается: 0 — убрать при ближайшем проходе
-- уборщика, больше нуля — дать время передумать. Почта недоступна
-- с момента карантина в любом случае.
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- 2. Завершение сеанса входа администратора в чужой ящик.
--
-- Отметка о завершении ставилась ТОЛЬКО явным выходом. Истёк срок,
-- закрыл вкладку, вышел из админки — строка оставалась открытой навсегда,
-- и в журнале вход выглядел бесконечным. Владелец ящика, которому этот
-- журнал и адресован, видел «администратор всё ещё у меня в почте».
--
-- expires_at пишется при входе, поэтому уборщик закрывает просроченные
-- записи по сроку САМОГО сеанса, а не по текущей настройке: изменение
-- ADMIN_MAILBOX_TTL_SECONDS не переписывает историю задним числом.
-- ------------------------------------------------------------------
ALTER TABLE admin_mailbox_access
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE admin_mailbox_access
    ADD COLUMN IF NOT EXISTS end_reason VARCHAR(16);

COMMENT ON COLUMN admin_mailbox_access.end_reason IS
    'leave — вышел кнопкой, logout — вышел из админки, replaced — вошёл в другой ящик, expired — истёк срок';

CREATE INDEX IF NOT EXISTS idx_mailbox_access_open
    ON admin_mailbox_access (expires_at) WHERE ended_at IS NULL;

-- Уже накопленные открытые записи закрывать задним числом нечем: срока
-- у них не записано. Проставим ожидаемый срок от времени начала — час,
-- то есть значение ADMIN_MAILBOX_TTL_SECONDS по умолчанию. Дальше их
-- закроет уборщик, и «вечных» входов в журнале не останется.
UPDATE admin_mailbox_access
   SET expires_at = started_at + interval '1 hour'
 WHERE ended_at IS NULL AND expires_at IS NULL;

-- ------------------------------------------------------------------
-- 3. Импорт ящиков из CSV: результат переживает обрыв связи.
--
-- Импорт 5000 строк — это около 87 секунд при пределе ожидания nginx
-- в 120 секунд. Запаса почти нет, а сгенерированные пароли существовали
-- ТОЛЬКО в теле ответа: оборвалась связь — ящики созданы, паролей нет
-- ни у кого, и восстановить их нельзя (в базе лежит хэш).
--
-- Теперь импорт — задание: строка создаётся до начала работы, результат
-- дописывается по мере создания ящиков, и его можно забрать отдельным
-- запросом сколько угодно раз, пока задание не просрочено.
--
-- Пароли лежат ТОЛЬКО в зашифрованном виде (result_enc, AES-256-GCM,
-- ключ выводится из ADMIN_SESSION_SECRET/SESSION_SECRET и в базе не лежит).
-- Открытого пароля в схеме нет ни одного столбца — как и в остальных
-- таблицах этого сервера.
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- 4. Настройки помощника ИИ для доменов, заведённых после миграции 0004.
--
-- Строку настроек создавала только сама миграция 0004 — для доменов,
-- существовавших на момент её применения. Домен, добавленный позже,
-- строки не получал, а список настроек ИИ фильтровал именно по её
-- наличию: помощника нельзя было настроить ни для одного нового домена.
-- Читающие запросы теперь идут от virtual_domains (см. apps/api/src/ai/db.ts),
-- поэтому строка перестала быть обязательной, но существующие пробелы
-- закроем — так в базе видно, что раздел есть у каждого домена.
-- ------------------------------------------------------------------
INSERT INTO ai_domain_settings (domain_id)
SELECT d.id FROM virtual_domains d
WHERE NOT EXISTS (SELECT 1 FROM ai_domain_settings s WHERE s.domain_id = d.id);

COMMIT;
