/**
 * Задание смены домена: строка в базе, шаги и их состояния.
 *
 * Отдельный файл от `domain-change-store.ts` намеренно: там переписывание
 * адресов — то, что делается с ПОЧТОЙ, здесь — учёт самой операции. Смешав
 * их, легко однажды поправить учёт и заодно задеть переезд.
 */
import type { AdminDb } from './db.js';
import type { DomainChangePlan } from './domain-change.js';

export type DomainChangeState = 'planned' | 'running' | 'done' | 'failed' | 'cancelled';

/** Один шаг выполнения — то, что видно в интерфейсе строкой хода работ. */
export interface DomainChangeStep {
  id: string;
  title: string;
  state: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  /** Что получилось: числа, пути, причина пропуска. */
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Шаги в том порядке, в котором идут.
 *
 * Порядок — не украшение. Резервная копия снимается ПЕРВОЙ, до любого
 * изменения: копия, снятая после начала переезда, содержала бы уже
 * наполовину переписанные адреса, то есть была бы бесполезна ровно в том
 * случае, ради которого её снимают. Проверки повторяются ВТОРЫМИ, после
 * копии и перед первым изменением: между показом плана и нажатием кнопки
 * проходит время, за которое кто-то мог запустить перенос почты.
 *
 * `pointOfNoReturn` отмечает шаг, начиная с которого отменить нельзя.
 */
export const DOMAIN_CHANGE_STEPS: readonly {
  id: string;
  title: string;
  pointOfNoReturn?: true;
}[] = [
  { id: 'backup', title: 'Резервная копия настроек' },
  { id: 'checks', title: 'Повторная проверка условий' },
  { id: 'domain', title: 'Новый домен и ключ DKIM' },
  { id: 'files', title: 'Перенос писем и индексов', pointOfNoReturn: true },
  { id: 'database', title: 'Адреса ящиков, алиасов и настроек' },
  { id: 'verify', title: 'Проверка, что почта на месте' },
];

/** Первоначальный список шагов для нового задания. */
export function initialSteps(): DomainChangeStep[] {
  return DOMAIN_CHANGE_STEPS.map((s) => ({ id: s.id, title: s.title, state: 'pending' }));
}

export interface DomainChangeJobRow {
  id: number;
  adminId: number | null;
  adminLogin: string;
  oldDomain: string;
  newDomain: string;
  oldHostname: string;
  newHostname: string;
  dkimSelector: string;
  dkimPublicKey: string | null;
  state: DomainChangeState;
  pointOfNoReturnAt: string | null;
  plan: DomainChangePlan | null;
  steps: DomainChangeStep[];
  mailboxes: number;
  aliases: number;
  messages: number;
  bytes: number;
  backupPath: string | null;
  backupBytes: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Столбцы для чтения.
 *
 * `dkim_private_enc` здесь НЕТ и быть не должно: приватный ключ не
 * покидает базу через маршруты панели ни в каком виде. Его забирает
 * скрипт на сервере отдельным запросом (см. domainChangePrivateKey) —
 * ровно как секреты заданий переноса, которые тоже читаются отдельным
 * методом, а не общим списком.
 */
const COLUMNS = `
  id::text AS id, admin_id, admin_login, old_domain, new_domain,
  old_hostname, new_hostname, dkim_selector, dkim_public_key,
  state, point_of_no_return_at, plan, steps,
  mailboxes, aliases, messages::text AS messages, bytes::text AS bytes,
  backup_path, backup_bytes::text AS backup_bytes, error,
  created_at, updated_at, started_at, finished_at`;

interface RawRow {
  id: string;
  admin_id: number | null;
  admin_login: string;
  old_domain: string;
  new_domain: string;
  old_hostname: string;
  new_hostname: string;
  dkim_selector: string;
  dkim_public_key: string | null;
  state: string;
  point_of_no_return_at: Date | null;
  plan: DomainChangePlan | null;
  steps: DomainChangeStep[] | null;
  mailboxes: number;
  aliases: number;
  messages: string;
  bytes: string;
  backup_path: string | null;
  backup_bytes: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function toRow(r: RawRow): DomainChangeJobRow {
  return {
    id: Number(r.id),
    adminId: r.admin_id,
    adminLogin: r.admin_login,
    oldDomain: r.old_domain,
    newDomain: r.new_domain,
    oldHostname: r.old_hostname,
    newHostname: r.new_hostname,
    dkimSelector: r.dkim_selector,
    dkimPublicKey: r.dkim_public_key,
    state: r.state as DomainChangeState,
    pointOfNoReturnAt: r.point_of_no_return_at?.toISOString() ?? null,
    plan: r.plan,
    steps: r.steps ?? [],
    mailboxes: r.mailboxes,
    aliases: r.aliases,
    messages: Number(r.messages),
    bytes: Number(r.bytes),
    backupPath: r.backup_path,
    backupBytes: Number(r.backup_bytes),
    error: r.error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** Применена ли миграция 0033. Без неё раздел честно отвечает «недоступен». */
export async function domainChangeSchemaReady(db: AdminDb): Promise<boolean> {
  const row = await db.one<{ ok: boolean }>(
    `SELECT to_regclass('public.domain_change_jobs') IS NOT NULL AS ok`,
  );
  return row?.ok === true;
}

export async function createDomainChangeJob(
  db: AdminDb,
  input: {
    adminId: number;
    adminLogin: string;
    oldDomain: string;
    newDomain: string;
    oldHostname: string;
    newHostname: string;
    dkimSelector: string;
    dkimPublicKey: string;
    dkimPrivateEnc: string | null;
    plan: DomainChangePlan;
  },
): Promise<DomainChangeJobRow> {
  const rows = await db.query<RawRow>(
    `INSERT INTO domain_change_jobs
        (admin_id, admin_login, old_domain, new_domain, old_hostname, new_hostname,
         dkim_selector, dkim_public_key, dkim_private_enc, plan, steps)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.adminId,
      input.adminLogin,
      input.oldDomain,
      input.newDomain,
      input.oldHostname,
      input.newHostname,
      input.dkimSelector,
      input.dkimPublicKey,
      input.dkimPrivateEnc,
      JSON.stringify(input.plan),
      JSON.stringify(initialSteps()),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('Не удалось создать задание смены домена');
  return toRow(row);
}

/** Незавершённое задание, если оно есть. Их не может быть больше одного. */
export async function findLiveJob(db: AdminDb): Promise<DomainChangeJobRow | null> {
  const row = await db.one<RawRow>(
    `SELECT ${COLUMNS} FROM domain_change_jobs
      WHERE state IN ('planned','running') ORDER BY id DESC LIMIT 1`,
  );
  return row ? toRow(row) : null;
}

export async function findJob(db: AdminDb, id: number): Promise<DomainChangeJobRow | null> {
  const row = await db.one<RawRow>(`SELECT ${COLUMNS} FROM domain_change_jobs WHERE id = $1`, [id]);
  return row ? toRow(row) : null;
}

export async function listJobs(db: AdminDb, limit: number): Promise<DomainChangeJobRow[]> {
  const rows = await db.query<RawRow>(
    `SELECT ${COLUMNS} FROM domain_change_jobs ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toRow);
}

/**
 * Приватный ключ DKIM — отдельным методом и только по идентификатору.
 *
 * Тот же приём, что у паролей заданий переноса (`findMigrationJobWithSecret`
 * в db.ts): секрет не должен уезжать вместе с обычным чтением списка,
 * иначе однажды он окажется в ответе, который кто-то решил показать на
 * экране.
 */
export async function domainChangePrivateKey(db: AdminDb, id: number): Promise<string | null> {
  const row = await db.one<{ dkim_private_enc: string | null }>(
    `SELECT dkim_private_enc FROM domain_change_jobs WHERE id = $1`,
    [id],
  );
  return row?.dkim_private_enc ?? null;
}

/**
 * Захват задания работником.
 *
 * Атомарный `UPDATE … RETURNING` вместо «прочитать и записать»: два
 * процесса api (перезапуск с наложением, две реплики) не должны начать
 * переименовывать один каталог. Условие `state = 'planned'` означает, что
 * второй захват просто ничего не вернёт.
 */
export async function claimJob(
  db: AdminDb,
  id: number,
  runner: string,
): Promise<DomainChangeJobRow | null> {
  const row = await db.one<RawRow>(
    `UPDATE domain_change_jobs
        SET state = 'running', runner = $2, heartbeat_at = now(),
            started_at = coalesce(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'planned'
      RETURNING ${COLUMNS}`,
    [id, runner],
  );
  return row ? toRow(row) : null;
}

export async function touchJob(db: AdminDb, id: number, runner: string): Promise<void> {
  await db.query(
    `UPDATE domain_change_jobs SET heartbeat_at = now(), updated_at = now()
      WHERE id = $1 AND runner = $2`,
    [id, runner],
  );
}

export async function saveSteps(
  db: AdminDb,
  id: number,
  steps: readonly DomainChangeStep[],
): Promise<void> {
  await db.query(
    `UPDATE domain_change_jobs SET steps = $2::jsonb, updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(steps)],
  );
}

export async function markPointOfNoReturn(db: AdminDb, id: number): Promise<void> {
  await db.query(
    `UPDATE domain_change_jobs
        SET point_of_no_return_at = coalesce(point_of_no_return_at, now()), updated_at = now()
      WHERE id = $1`,
    [id],
  );
}

/**
 * Снимает отметку точки невозврата.
 *
 * Нужна ровно в одном случае — и случай этот не теоретический, он был
 * найден живой проверкой. Отметка ставится ПЕРЕД переименованием
 * каталогов, потому что снаружи не видно, успело ли оно пройти. Но если
 * следом сорвалась запись в базу, каталоги возвращаются на место, и
 * сервер остаётся ровно таким, каким был. Оставленная отметка означала
 * бы, что панель пишет «точка невозврата пройдена» про переезд, которого
 * не случилось, — то есть врёт в самом страшном месте экрана.
 */
export async function clearPointOfNoReturn(db: AdminDb, id: number): Promise<void> {
  await db.query(
    `UPDATE domain_change_jobs SET point_of_no_return_at = NULL, updated_at = now()
      WHERE id = $1`,
    [id],
  );
}

export async function saveBackup(
  db: AdminDb,
  id: number,
  path: string,
  bytes: number,
): Promise<void> {
  await db.query(
    `UPDATE domain_change_jobs SET backup_path = $2, backup_bytes = $3, updated_at = now()
      WHERE id = $1`,
    [id, path, bytes],
  );
}

export async function finishJob(
  db: AdminDb,
  id: number,
  input: {
    state: DomainChangeState;
    error?: string | null;
    steps?: readonly DomainChangeStep[];
    counts?: { mailboxes: number; aliases: number; messages: number; bytes: number };
  },
): Promise<void> {
  await db.query(
    `UPDATE domain_change_jobs
        SET state = $2,
            error = $3,
            steps = coalesce($4::jsonb, steps),
            mailboxes = coalesce($5, mailboxes),
            aliases   = coalesce($6, aliases),
            messages  = coalesce($7, messages),
            bytes     = coalesce($8, bytes),
            runner = NULL,
            finished_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.state,
      input.error ?? null,
      input.steps ? JSON.stringify(input.steps) : null,
      input.counts?.mailboxes ?? null,
      input.counts?.aliases ?? null,
      input.counts?.messages ?? null,
      input.counts?.bytes ?? null,
    ],
  );
}

/**
 * Отмена до точки невозврата.
 *
 * Условие `point_of_no_return_at IS NULL` стоит в самом запросе, а не в
 * коде перед ним: между проверкой и записью проходит время, и именно в
 * него работник успевает переименовать каталог. База такой гонки не знает.
 */
export async function cancelJob(db: AdminDb, id: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE domain_change_jobs
        SET state = 'cancelled', runner = NULL, finished_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'planned' AND point_of_no_return_at IS NULL
      RETURNING id::text AS id`,
    [id],
  );
  return rows.length > 0;
}
