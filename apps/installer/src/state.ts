/**
 * Состояние сервера: установлен ли он уже и не стоит ли на нём что-то живое.
 *
 * ------------------------------------------------------------------
 * ДВЕ РАЗНЫЕ ЗАЩИТЫ, А НЕ ОДНА
 * ------------------------------------------------------------------
 * 1. ОТМЕТКА «установлено» (INSTALL_COMPLETED_AT в infra/.env и строка в
 *    таблице install_state). Ставит её последним шагом install/install.sh —
 *    и консольная установка, и браузерная. Есть отметка — установщик не
 *    работает вовсе, никаких «продолжить всё равно».
 *
 * 2. ПРИЗНАКИ ЖИВОГО СЕРВЕРА без отметки. Так выглядит установка, сделанная
 *    старой версией продукта (когда отметки ещё не было), или сервер, у
 *    которого потеряли infra/.env вместе с отметкой, но сохранили тома.
 *    Здесь запрещать нельзя — иначе доустановить такой сервер станет
 *    невозможно. Но и молчать нельзя: мастер показывает, ЧТО именно он
 *    нашёл, и требует явного согласия. «Не молча» — это и есть требование.
 *
 * Почему отметки две и почему хватает любой — см. install/lib/common.sh,
 * раздел «Отметка „сервер установлен“», и миграцию 0031.
 */
import { readFile, access } from 'node:fs/promises';
import { run } from './shell.js';
import { PORT_FIELDS } from './validate.js';

export interface EnvMap {
  readonly values: ReadonlyMap<string, string>;
  readonly exists: boolean;
}

/**
 * Разбор infra/.env.
 *
 * «\r» вычищается намеренно: файл-образец однажды уже уехал в репозиторий
 * с концами строк Windows, и тогда POSTGRES_USER превращался в «mailserver»
 * с невидимым хвостом — psql отвечал «role does not exist» при исправной базе.
 */
export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r/g, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values.set(key, line.slice(eq + 1));
  }
  return values;
}

export async function readEnvFile(path: string): Promise<EnvMap> {
  try {
    await access(path);
  } catch {
    return { values: new Map(), exists: false };
  }
  const text = await readFile(path, 'utf8');
  return { values: parseEnv(text), exists: true };
}

export interface InstallMark {
  /** Время из infra/.env, если есть. */
  readonly fromEnv: string | null;
  /** Время из таблицы install_state, если база отвечает. */
  readonly fromDb: string | null;
  readonly installed: boolean;
  /** Что именно установлено — для экрана отказа. */
  readonly domain: string;
  readonly hostname: string;
  readonly adminLogin: string;
  readonly installedBy: string;
}

export interface ServerTraces {
  /** Признаки, найденные без отметки: каждый — строкой для человека. */
  readonly traces: readonly string[];
  readonly looksConfigured: boolean;
}

interface DbContext {
  readonly composeFile: string;
  readonly projectName: string;
  readonly user: string;
  readonly db: string;
}

/** Один запрос к базе через контейнер стека. Пусто — база не ответила. */
async function psql(ctx: DbContext, sql: string): Promise<string | null> {
  if (ctx.user === '' || ctx.db === '') return null;
  const out = await run(
    'docker',
    [
      'compose',
      '-p',
      ctx.projectName,
      '-f',
      ctx.composeFile,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      ctx.user,
      '-d',
      ctx.db,
      '-qtA',
      '-c',
      sql,
    ],
    { timeoutMs: 20_000 },
  );
  if (out.code !== 0) return null;
  return out.stdout.replace(/\r/g, '').trim();
}

export interface StateContext {
  readonly repoDir: string;
  readonly projectName: string;
  /** Отметка, переданная compose в окружение при старте контейнера. */
  readonly envSnapshot: string;
}

function dbContext(ctx: StateContext, env: EnvMap): DbContext {
  return {
    composeFile: `${ctx.repoDir}/infra/docker-compose.yml`,
    projectName: ctx.projectName,
    user: env.values.get('POSTGRES_USER') ?? '',
    db: env.values.get('POSTGRES_DB') ?? '',
  };
}

export async function readInstallMark(ctx: StateContext, env: EnvMap): Promise<InstallMark> {
  const fromEnvRaw = env.values.get('INSTALL_COMPLETED_AT') ?? ctx.envSnapshot;
  const fromEnv = fromEnvRaw.trim() === '' ? null : fromEnvRaw.trim();

  const row = await psql(
    dbContext(ctx, env),
    "SELECT completed_at || '|' || installed_by || '|' || mail_domain || '|' || mail_hostname || '|' || admin_login FROM install_state WHERE id",
  );
  const parts = row === null || row === '' ? [] : row.split('|');
  const fromDb = parts[0] !== undefined && parts[0] !== '' ? parts[0] : null;

  return {
    fromEnv,
    fromDb,
    installed: fromEnv !== null || fromDb !== null,
    installedBy: parts[1] ?? '',
    domain: parts[2] ?? env.values.get('MAIL_DOMAIN') ?? '',
    hostname: parts[3] ?? env.values.get('MAIL_HOSTNAME') ?? '',
    adminLogin: parts[4] ?? '',
  };
}

/**
 * Признаки уже настроенного сервера при отсутствующей отметке.
 *
 * Проверяем то, что установщик способен испортить: настроенный домен,
 * сгенерированные секреты, работающие службы, заведённые ящики.
 */
export async function readServerTraces(ctx: StateContext, env: EnvMap): Promise<ServerTraces> {
  const traces: string[] = [];

  const domain = env.values.get('MAIL_DOMAIN') ?? '';
  if (env.exists && domain !== '' && domain !== 'mail.local') {
    traces.push(`В infra/.env уже записан почтовый домен ${domain}.`);
  }
  const pgPassword = env.values.get('POSTGRES_PASSWORD') ?? '';
  if (
    pgPassword !== '' &&
    !pgPassword.startsWith('change-me') &&
    !pgPassword.startsWith('смените')
  ) {
    traces.push(
      'Пароль Postgres в infra/.env уже сгенерирован. Том базы принимает пароль только ' +
        'при создании: новый пароль в файле разошёлся бы с паролем внутри базы, и доступ ' +
        'потеряли бы разом api, postfix и dovecot — при полностью исправной базе.',
    );
  }

  const running = await run(
    'docker',
    [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${ctx.projectName}`,
      '--format',
      '{{.Label "com.docker.compose.service"}}',
    ],
    { timeoutMs: 15_000 },
  );
  const services = running.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== 'installer');
  if (services.length > 0) {
    traces.push(`Уже работают службы стека: ${services.sort().join(', ')}.`);
  }

  const db = dbContext(ctx, env);
  const counts = await psql(
    db,
    "SELECT (SELECT count(*) FROM virtual_domains) || '|' || (SELECT count(*) FROM virtual_users) || '|' || (SELECT count(*) FROM admin_users)",
  );
  if (counts !== null && counts !== '') {
    const [domains, users, admins] = counts.split('|');
    if (Number(users) > 0 || Number(admins) > 0) {
      traces.push(
        `В базе уже есть данные: доменов ${domains ?? '?'}, ящиков ${users ?? '?'}, ` +
          `учётных записей админки ${admins ?? '?'}. Письма этих ящиков лежат в томах docker.`,
      );
    }
  }

  return { traces, looksConfigured: traces.length > 0 };
}

/**
 * ОТВЕТЫ, КОТОРЫЕ УЖЕ ДАНЫ.
 *
 * Домен и имя сервера могли спросить до мастера: `install.sh --prepare-only`
 * задаёт те же вопросы и пишет ответы в infra/.env. Мастер об этом не знал и
 * спрашивал всё заново — человек вводил домен, хост и адрес администратора
 * по второму разу, гадая, какой из двух ответов победит.
 *
 * Что реально задано, а что осталось заглушкой из образца, различаем
 * сравнением с самим образцом: совпало — значит никто этого не менял.
 * Так не нужен список «настоящих» значений, который всё равно устарел бы.
 *
 * Секреты сюда не попадают: пароли, ключи и токены в форму не
 * возвращаются никогда.
 */
export function answersFromEnv(
  env: EnvMap,
  example: EnvMap,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!env.exists) return out;

  const changed = (key: string): string | null => {
    const value = env.values.get(key);
    if (value === undefined || value === '') return null;
    if (value === example.values.get(key)) return null;
    if (/^change-me/i.test(value)) return null;
    return value;
  };

  const text: ReadonlyArray<readonly [string, string]> = [
    ['MAIL_DOMAIN', 'domain'],
    ['MAIL_HOSTNAME', 'hostname'],
    ['BIND_ADDRESS', 'bindAddress'],
    ['DOCKER_SUBNET', 'subnet'],
    ['RESOLVER_IP', 'resolverIp'],
    ['DOVECOT_IP', 'dovecotIp'],
  ];
  for (const [key, field] of text) {
    const value = changed(key);
    if (value !== null) out[field] = value;
  }

  const numbers: ReadonlyArray<readonly [string, string]> = [
    ['MESSAGE_MAX_BYTES', 'messageMaxBytes'],
    ['UPLOAD_MAX_BYTES', 'uploadMaxBytes'],
    ['COMPOSE_BODY_MAX_BYTES', 'composeBodyMaxBytes'],
  ];
  for (const [key, field] of numbers) {
    const value = changed(key);
    if (value !== null && /^\d+$/.test(value)) out[field] = Number(value);
  }

  const flags: ReadonlyArray<readonly [string, string]> = [
    ['CLAMAV_ENABLED', 'clamav'],
    ['AI_ENABLED', 'aiEnabled'],
  ];
  for (const [key, field] of flags) {
    const value = changed(key);
    if (value !== null) out[field] = /^(true|yes|1|on)$/i.test(value);
  }

  // Порты: ключи в .env те же, что мастер отдаёт установщику.
  for (const field of PORT_FIELDS) {
    const value = changed(field.envKey);
    if (value !== null && /^\d+$/.test(value)) out[field.key] = Number(value);
  }

  return out;
}
