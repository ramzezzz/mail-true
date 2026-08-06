/**
 * Формат резервной копии НАСТРОЕК и разбор чужого файла копии.
 *
 * ------------------------------------------------------------------
 * Чем это НЕ является
 * ------------------------------------------------------------------
 * Это не копия почты. Письма, очередь, ключи DKIM, обучение антиспама и
 * сама база целиком — всё это делает install/backup.sh, и повторять его
 * здесь незачем: там копия снимается снаружи, с томов и через pg_dump,
 * и восстанавливается install/restore.sh.
 *
 * Здесь другая задача, ровно из требования: «создавать и восстанавливать
 * копии НАСТРОЕК». Настройки — это то, что администратор набивал руками:
 * домены и ключи подписи, ящики, алиасы, администраторы, правила и
 * подписи пользователей, настройки помощника ИИ, своё оформление входа.
 * Такая копия весит килобайты, снимается из браузера за секунду и —
 * главное — переносится на другую установку. Копия писем этого не умеет
 * и уметь не должна.
 *
 * ------------------------------------------------------------------
 * Почему в файле есть версия формата
 * ------------------------------------------------------------------
 * Копию восстанавливают тогда, когда всё уже плохо, и часто НЕ ТОЙ версией
 * продукта, которой её снимали. Файл без номера формата в этот момент —
 * это лотерея: часть полей молча не доедет, часть встанет не туда, и
 * узнают об этом по странному поведению почты через неделю. Поэтому номер
 * лежит внутри файла, проверяется первым делом, и копия из будущего
 * отвергается с прямым текстом, а не «читается как получится».
 *
 * ------------------------------------------------------------------
 * Секреты внутри копии: что и почему
 * ------------------------------------------------------------------
 * ЕСТЬ (осознанно): хэши паролей ящиков (формат Dovecot) и хэши паролей
 *   администраторов (scrypt). Копия настроек без них бесполезна: восстановив
 *   её, получаешь список ящиков, в которые никто не может войти, и «резервная
 *   копия» превращается в массовый сброс паролей всей организации. Хэш —
 *   не пароль: обратно он не разворачивается. Но файл от этого становится
 *   ценным, поэтому он отдаётся только по админской сессии с правом
 *   `backup.export`, каждая выгрузка попадает в журнал аудита, а в самом
 *   файле стоит признак `containsSecrets` — чтобы тот, кто его нашёл на
 *   диске, понимал, что держит в руках.
 *
 * НЕТ (тоже осознанно):
 *   - ключ доступа к сервису ИИ (ai_domain_settings.api_key_enc). Он
 *     зашифрован ключом AI_ENCRYPTION_KEY из infra/.env, а .env в эту
 *     копию не входит. На другой установке такой шифротекст не
 *     расшифровывается ничем — приехал бы «ключ, который есть, но не
 *     работает». Вместо него едет признак `apiKeyPresent`, и восстановление
 *     прямо говорит: ключ нужно ввести заново.
 *   - пароли чужих и связанных ящиков пользователей (linked_accounts,
 *     external_accounts) — по той же причине: EXTERNAL_ACCOUNTS_KEY тоже
 *     остаётся в .env.
 *   - секрет TOTP администраторов: двухфакторная проверка ещё не включена,
 *     а секрет — это второй фактор, и возить его файлом нельзя.
 *   - НИ ОДНОЙ переменной окружения. И это не забывчивость: POSTGRES_USER,
 *     POSTGRES_PASSWORD и POSTGRES_DB привязаны к ТОМУ базы, а не к данным
 *     (см. MT_VOLUME_BOUND_ENV_KEYS в install/lib/common.sh: Postgres
 *     принимает пароль только при инициализации пустого тома). Копия
 *     настроек, которая кладёт чужой .env поверх работающей установки,
 *     оставляет базу живой, а api, postfix и dovecot — без доступа к ней.
 *     Здесь этого не может случиться в принципе: восстанавливать нечего.
 */
import { z } from 'zod';
import { BadRequestError } from '../errors.js';
import type { BrandingSnapshot } from './branding.js';

/** Опознавательная строка файла. Проверяется до всего остального. */
export const SETTINGS_BACKUP_KIND = 'mail.true/settings-backup';

/**
 * Версия формата. Увеличивается при ЛЮБОМ несовместимом изменении состава
 * полей. Читаем ровно свою: копию новее отвергаем (мы не знаем, что в ней),
 * копию старее — тоже, но с подсказкой, чем её восстанавливать.
 */
export const SETTINGS_BACKUP_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Разделы                                                              */
/* ------------------------------------------------------------------ */

export const BACKUP_SECTIONS = [
  'domains',
  'mailboxes',
  'aliases',
  'admins',
  'userSettings',
  'ai',
  'branding',
] as const;
export type BackupSection = (typeof BACKUP_SECTIONS)[number];

export const SECTION_TITLES: Readonly<Record<BackupSection, string>> = {
  domains: 'Домены и ключи подписи',
  mailboxes: 'Ящики',
  aliases: 'Алиасы',
  admins: 'Администраторы',
  userSettings: 'Настройки и правила пользователей',
  ai: 'Помощник ИИ',
  branding: 'Оформление входа',
};

export function isBackupSection(value: string): value is BackupSection {
  return (BACKUP_SECTIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Схема файла                                                          */
/* ------------------------------------------------------------------ */

const domainEntry = z.object({
  name: z.string().min(1),
  dkimSelector: z.string().nullable().default(null),
  dkimPublicKey: z.string().nullable().default(null),
  dkimDnsRecord: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});

const mailboxEntry = z.object({
  email: z.string().min(3),
  displayName: z.string().nullable().default(null),
  quotaBytes: z.number().int().nonnegative(),
  active: z.boolean(),
  /** Хэш формата Dovecot ({SHA512-CRYPT}$6$… / {ARGON2ID}…), не пароль. */
  passwordHash: z.string().min(1),
});

const aliasEntry = z.object({
  source: z.string().min(3),
  destination: z.string().min(3),
  active: z.boolean(),
});

const adminEntry = z.object({
  login: z.string().min(1),
  displayName: z.string().nullable().default(null),
  role: z.string().min(1),
  active: z.boolean(),
  /** Хэш scrypt из admin_users.password_hash. Секрета TOTP здесь нет. */
  passwordHash: z.string().min(1),
});

const filterEntry = z.object({
  name: z.string().default(''),
  position: z.number().int().default(0),
  enabled: z.boolean().default(true),
  isAuto: z.boolean().default(false),
  matchMode: z.enum(['all', 'any']).default('all'),
  conditions: z.unknown().default([]),
  actions: z.unknown().default({}),
});

const signatureEntry = z.object({
  name: z.string().default(''),
  bodyHtml: z.string().default(''),
  isDefault: z.boolean().default(false),
  position: z.number().int().default(0),
});

const userSettingsEntry = z.object({
  accountEmail: z.string().min(3),
  /** Строка mail_user_settings как есть; null — настроек нет, всё по умолчанию. */
  settings: z.record(z.unknown()).nullable().default(null),
  signatures: z.array(signatureEntry).default([]),
  filters: z.array(filterEntry).default([]),
});

const aiEntry = z.object({
  domain: z.string().min(1),
  enabled: z.boolean(),
  baseUrl: z.string().nullable().default(null),
  chatPath: z.string().default('/chat/completions'),
  model: z.string().nullable().default(null),
  providerLabel: z.string().default('Сервис ИИ'),
  isLocal: z.boolean().default(false),
  maxBodyChars: z.number().int().default(8000),
  timeoutMs: z.number().int().default(30000),
  maxOutputTokens: z.number().int().default(1024),
  /**
   * Ключ доступа НЕ едет (см. шапку файла). Здесь только признак, что он
   * был, — чтобы восстановление сказало «ключ введите заново», а не
   * оставило человека гадать, почему помощник молчит.
   */
  apiKeyPresent: z.boolean().default(false),
});

const brandingLogo = z.object({
  format: z.string(),
  mime: z.string(),
  ext: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number(),
  version: z.string(),
  updatedAt: z.string(),
});

const brandingEntry = z.object({
  companyName: z.string().nullable().default(null),
  productName: z.string().nullable().default(null),
  logo: brandingLogo.nullable().default(null),
  logoBase64: z.string().nullable().default(null),
});

const backupFile = z.object({
  kind: z.literal(SETTINGS_BACKUP_KIND),
  version: z.number().int(),
  createdAt: z.string(),
  source: z.object({
    hostname: z.string().default(''),
    domain: z.string().default(''),
  }),
  containsSecrets: z.boolean().default(true),
  data: z.object({
    domains: z.array(domainEntry).default([]),
    mailboxes: z.array(mailboxEntry).default([]),
    aliases: z.array(aliasEntry).default([]),
    admins: z.array(adminEntry).default([]),
    userSettings: z.array(userSettingsEntry).default([]),
    ai: z.array(aiEntry).default([]),
    branding: brandingEntry.nullable().default(null),
  }),
});

export type DomainEntry = z.infer<typeof domainEntry>;
export type MailboxEntry = z.infer<typeof mailboxEntry>;
export type AliasEntry = z.infer<typeof aliasEntry>;
export type AdminEntry = z.infer<typeof adminEntry>;
export type FilterEntry = z.infer<typeof filterEntry>;
export type SignatureEntry = z.infer<typeof signatureEntry>;
export type UserSettingsEntry = z.infer<typeof userSettingsEntry>;
export type AiEntry = z.infer<typeof aiEntry>;
export type SettingsBackupFile = z.infer<typeof backupFile>;
export type SettingsBackupData = SettingsBackupFile['data'];

/* ------------------------------------------------------------------ */
/* Сборка и разбор                                                      */
/* ------------------------------------------------------------------ */

export interface BuildBackupInput {
  source: { hostname: string; domain: string };
  data: {
    domains: DomainEntry[];
    mailboxes: MailboxEntry[];
    aliases: AliasEntry[];
    admins: AdminEntry[];
    userSettings: UserSettingsEntry[];
    ai: AiEntry[];
    branding: BrandingSnapshot | null;
  };
  now?: Date;
}

/** Собирает файл копии. Единственное место, где рождается его структура. */
export function buildSettingsBackup(input: BuildBackupInput): SettingsBackupFile {
  return {
    kind: SETTINGS_BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    createdAt: (input.now ?? new Date()).toISOString(),
    source: input.source,
    // Хэши паролей внутри — файл нужно хранить как секрет.
    containsSecrets: true,
    data: {
      ...input.data,
      branding: input.data.branding ?? null,
    },
  } as SettingsBackupFile;
}

/**
 * Разбирает принесённый файл.
 *
 * Каждый отказ называет причину словами: «некорректный запрос» на файле
 * копии — худший из возможных ответов, потому что второго файла у человека,
 * скорее всего, нет.
 */
export function parseSettingsBackup(text: string): SettingsBackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError(
      'Файл не читается как JSON. Копия настроек — это файл .json, который создаёт ' +
        'сама панель управления; архив копии писем (install/backup.sh) сюда не подходит.',
    );
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new BadRequestError('В файле не объект JSON — это не копия настроек.');
  }

  const head = raw as { kind?: unknown; version?: unknown };
  if (head.kind !== SETTINGS_BACKUP_KIND) {
    throw new BadRequestError(
      `Это не копия настроек Mail.True: в файле нет метки «${SETTINGS_BACKUP_KIND}». ` +
        'Проверьте, что выбран файл, созданный кнопкой «Скачать копию настроек».',
    );
  }

  // Версию проверяем ДО схемы: иначе человек получил бы список
  // непонятных полей вместо простого «копия от другой версии».
  if (typeof head.version !== 'number' || !Number.isInteger(head.version)) {
    throw new BadRequestError('В копии нет номера версии формата — восстанавливать её нельзя.');
  }
  if (head.version > SETTINGS_BACKUP_VERSION) {
    throw new BadRequestError(
      `Копия сделана более новой версией продукта (формат ${head.version}, здесь ` +
        `${SETTINGS_BACKUP_VERSION}). Восстановить её здесь нельзя: часть настроек молча не ` +
        'доехала бы. Обновите Mail.True до версии, которой снята копия.',
    );
  }
  if (head.version < SETTINGS_BACKUP_VERSION) {
    throw new BadRequestError(
      `Копия сделана в устаревшем формате ${head.version}, здесь читается ` +
        `${SETTINGS_BACKUP_VERSION}. Восстановите её на той версии продукта, где она снята, ` +
        'и снимите копию заново.',
    );
  }

  const parsed = backupFile.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') ?? 'файл';
    throw new BadRequestError(
      `Копия повреждена: поле «${where}» — ${first?.message ?? 'неизвестная ошибка'}. ` +
        'Файл правили руками или он докачался не полностью.',
    );
  }
  return parsed.data;
}

/** Сколько объектов в каждом разделе — для описи копии в интерфейсе. */
export function countSections(file: SettingsBackupFile): Record<BackupSection, number> {
  const d = file.data;
  return {
    domains: d.domains.length,
    mailboxes: d.mailboxes.length,
    aliases: d.aliases.length,
    admins: d.admins.length,
    userSettings: d.userSettings.length,
    ai: d.ai.length,
    branding: d.branding ? 1 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* План восстановления                                                  */
/* ------------------------------------------------------------------ */

/**
 * Что сейчас есть в установке — ровно столько, сколько нужно, чтобы
 * посчитать план. Пароли сюда НЕ попадают: план их не показывает.
 */
export interface CurrentSnapshot {
  domains: string[];
  mailboxes: string[];
  aliases: string[];
  admins: string[];
  /** Адрес ящика -> сколько у него сейчас правил и подписей. */
  userSettings: Map<string, { filters: number; signatures: number }>;
  ai: string[];
  brandingLogo: boolean;
}

export interface SectionPlan {
  id: BackupSection;
  title: string;
  /** Появится заново. */
  create: string[];
  /** Перезапишется поверх существующего — то самое «что именно». */
  overwrite: string[];
  /** Есть здесь, но в копии нет: восстановление это НЕ трогает. */
  untouched: number;
  warnings: string[];
}

export interface RestorePlan {
  version: number;
  createdAt: string;
  source: { hostname: string; domain: string };
  sections: SectionPlan[];
  /** Предупреждения обо всей операции, а не об одном разделе. */
  warnings: string[];
}

export interface PlanOptions {
  /** Логин администратора, который восстанавливает: его пароль особый случай. */
  currentAdminLogin: string;
  /** Имя хоста действующей установки — для предупреждения о переносе. */
  hostname: string;
  /** Разделы, которые человек выбрал. Пусто — все. */
  sections?: readonly BackupSection[];
}

const aliasKey = (a: AliasEntry): string => `${a.source} → ${a.destination}`;

/**
 * Считает, что именно сделает восстановление.
 *
 * Главное свойство: восстановление НИЧЕГО НЕ УДАЛЯЕТ. Объекты, которых в
 * копии нет, остаются как есть, и в плане их видно строкой «не тронуто».
 * Иначе «восстановить настройки месячной давности» означало бы стереть
 * все ящики, заведённые за месяц, — а это ровно тот случай, когда молчание
 * дороже всего.
 */
export function buildRestorePlan(
  file: SettingsBackupFile,
  current: CurrentSnapshot,
  options: PlanOptions,
): RestorePlan {
  const wanted = new Set<BackupSection>(options.sections ?? BACKUP_SECTIONS);
  const sections: SectionPlan[] = [];
  const warnings: string[] = [];

  const lower = (list: readonly string[]): Set<string> =>
    new Set(list.map((s) => s.toLowerCase()));

  const split = <T>(
    id: BackupSection,
    items: readonly T[],
    key: (item: T) => string,
    existing: Set<string>,
    extra: string[] = [],
  ): void => {
    if (!wanted.has(id)) return;
    const create: string[] = [];
    const overwrite: string[] = [];
    for (const item of items) {
      const name = key(item);
      if (existing.has(name.toLowerCase())) overwrite.push(name);
      else create.push(name);
    }
    const incoming = new Set(items.map((i) => key(i).toLowerCase()));
    let untouched = 0;
    for (const name of existing) if (!incoming.has(name)) untouched += 1;
    sections.push({ id, title: SECTION_TITLES[id], create, overwrite, untouched, warnings: extra });
  };

  split('domains', file.data.domains, (d) => d.name, lower(current.domains));

  split(
    'mailboxes',
    file.data.mailboxes,
    (m) => m.email,
    lower(current.mailboxes),
    file.data.mailboxes.length > 0
      ? [
          'У перезаписанных ящиков сменится пароль на тот, что был в момент снятия копии: ' +
            'в копии лежат хэши паролей. Пароли, выданные после снятия копии, перестанут подходить.',
        ]
      : [],
  );

  // Домены ящиков, которых нет ни здесь, ни в копии: ящик без домена не создать
  if (wanted.has('mailboxes')) {
    const known = new Set([
      ...current.domains.map((d) => d.toLowerCase()),
      ...file.data.domains.map((d) => d.name.toLowerCase()),
    ]);
    const orphans = new Set<string>();
    for (const box of file.data.mailboxes) {
      const domain = box.email.split('@')[1]?.toLowerCase() ?? '';
      if (domain !== '' && !known.has(domain)) orphans.add(domain);
    }
    if (orphans.size > 0) {
      warnings.push(
        `Ящики из копии ссылаются на домены, которых нет ни здесь, ни в копии: ` +
          `${[...orphans].join(', ')}. Домены будут созданы автоматически, иначе ящики некуда класть.`,
      );
    }
  }

  split('aliases', file.data.aliases, aliasKey, lower(current.aliases));

  const adminWarnings: string[] = [];
  const meInBackup = file.data.admins.find(
    (a) => a.login.toLowerCase() === options.currentAdminLogin.toLowerCase(),
  );
  if (meInBackup) {
    adminWarnings.push(
      `Среди администраторов есть вы (${meInBackup.login}). Ваш пароль и роль будут заменены ` +
        'на те, что были в момент снятия копии, — вход по нынешнему паролю перестанет работать. ' +
        'Если пароль с тех пор менялся, войти после восстановления получится только старым.',
    );
  }
  const owners = file.data.admins.filter((a) => a.role === 'owner' && a.active);
  if (file.data.admins.length > 0 && owners.length === 0) {
    adminWarnings.push(
      'В копии нет ни одного действующего администратора с полным доступом. ' +
        'Существующие здесь администраторы не удаляются, поэтому доступ не потеряется.',
    );
  }
  adminWarnings.push('Секреты двухфакторной проверки в копию не входят и не восстанавливаются.');
  split('admins', file.data.admins, (a) => a.login, lower(current.admins), adminWarnings);

  if (wanted.has('userSettings')) {
    const create: string[] = [];
    const overwrite: string[] = [];
    for (const entry of file.data.userSettings) {
      const key = entry.accountEmail.toLowerCase();
      const now = current.userSettings.get(key);
      if (now && (now.filters > 0 || now.signatures > 0)) {
        overwrite.push(
          `${entry.accountEmail}: правил ${now.filters} → ${entry.filters.length}, ` +
            `подписей ${now.signatures} → ${entry.signatures.length}`,
        );
      } else {
        create.push(entry.accountEmail);
      }
    }
    const incoming = new Set(file.data.userSettings.map((e) => e.accountEmail.toLowerCase()));
    let untouched = 0;
    for (const key of current.userSettings.keys()) if (!incoming.has(key)) untouched += 1;
    sections.push({
      id: 'userSettings',
      title: SECTION_TITLES.userSettings,
      create,
      overwrite,
      untouched,
      warnings:
        overwrite.length > 0
          ? [
              'Правила и подписи ящика заменяются целиком, а не дополняются: правило, ' +
                'заведённое пользователем после снятия копии, исчезнет. Файл правил Sieve ' +
                'будет пересобран, иначе база и Dovecot разойдутся.',
            ]
          : [],
    });
  }

  const aiWarnings: string[] = [];
  if (file.data.ai.some((a) => a.apiKeyPresent)) {
    aiWarnings.push(
      'Ключи доступа к сервису ИИ в копию не входят (они зашифрованы ключом из infra/.env, ' +
        'а .env в копии настроек нет). После восстановления ключ нужно ввести заново, ' +
        'иначе помощник будет выключен.',
    );
  }
  split('ai', file.data.ai, (a) => a.domain, lower(current.ai), aiWarnings);

  if (wanted.has('branding')) {
    const branding = file.data.branding;
    const has = branding !== null && (branding.logoBase64 !== null || branding.companyName !== null);
    sections.push({
      id: 'branding',
      title: SECTION_TITLES.branding,
      create: has && !current.brandingLogo ? ['логотип и подписи страницы входа'] : [],
      overwrite: has && current.brandingLogo ? ['логотип и подписи страницы входа'] : [],
      untouched: 0,
      warnings:
        branding !== null && branding.logoBase64 === null && current.brandingLogo
          ? ['В копии логотипа нет — действующий логотип будет заменён стандартным.']
          : [],
    });
  }

  if (file.source.hostname !== '' && file.source.hostname !== options.hostname) {
    warnings.push(
      `Копия снята на сервере ${file.source.hostname}, а восстанавливается на ` +
        `${options.hostname}. Это допустимо (формат переносим), но проверьте домены: ` +
        'записи DNS и ключи подписи привязаны к именам из копии.',
    );
  }
  warnings.push(
    'Восстановление ничего не удаляет: объекты, которых в копии нет, остаются на месте.',
  );
  warnings.push(
    'Параметры подключения к базе и содержимое infra/.env в копию не входят и не ' +
      'восстанавливаются — иначе пароль Postgres в файле разошёлся бы с паролем внутри тома базы.',
  );

  return {
    version: file.version,
    createdAt: file.createdAt,
    source: file.source,
    sections,
    warnings,
  };
}
