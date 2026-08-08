/**
 * Разбор выгрузки пользователей из Kerio Connect.
 *
 * Kerio Connect (Accounts → Users → выбрать домен → Export) выгружает
 * CSV-файл `users_<ИмяДомена>_<дата>.csv` с колонками
 * Name, Password, FullName, Description, MailAddress, Groups
 * (порядок произвольный, обязательна только Name). Встречаются ДВА
 * варианта разделителей, разбор поддерживает оба:
 *   1) поля через «;», несколько значений внутри поля — через «,»:
 *        Name;Password;FullName;Description;MailAddress;Groups
 *        abird;VbD66op1;Alexandra Bird;Development;abird;read,all
 *   2) поля через «,», многозначные поля — в кавычках:
 *        abird,VbD66op1,Alexandra Bird,Development,abird,"read,all"
 * Разделитель определяется по строке заголовка (см. detectDelimiter).
 *
 * ВНИМАНИЕ: пароли в выгрузке лежат ОТКРЫТЫМ ТЕКСТОМ. При создании
 * ящиков их нужно сразу перехешировать в формат Dovecot и не оставлять
 * в журналах и временных файлах. CLI по умолчанию пароли в вывод не
 * включает (флаг --with-passwords).
 *
 * MailAddress может быть указан без домена (просто `abird`) — тогда домен
 * подставляется из имени файла выгрузки или задаётся параметром.
 *
 * Дополнительно поддерживается разбор файла конфигурации users.cfg
 * (XML, каталог данных Kerio) — как запасной вариант, если у админа
 * нет доступа к консоли, но есть файлы сервера.
 */

import { parseCsvWithHeader } from './csv.js';

/** Пользователь из выгрузки Kerio. */
export interface KerioUser {
  /** Логин (колонка Name) без домена. */
  login: string;
  /** Полное имя (FullName). */
  fullName: string | null;
  /** Описание (Description). */
  description: string | null;
  /** Основной e-mail (первый из MailAddress) или null, если колонки нет. */
  email: string | null;
  /** Остальные адреса из MailAddress — станут алиасами. */
  aliases: string[];
  /** Группы (колонка Groups). */
  groups: string[];
  /**
   * Пароль из колонки Password — Kerio выгружает его ОТКРЫТЫМ ТЕКСТОМ.
   * Использовать только для немедленного хеширования в формат Dovecot;
   * не логировать и не сохранять в промежуточных файлах.
   */
  password: string | null;
}

/** Заготовка для создания ящика у нас. */
export interface MailboxToCreate {
  /** Полный e-mail нового ящика. */
  email: string;
  /** Отображаемое имя (display_name в virtual_users). */
  displayName: string | null;
  /** Алиасы, которые надо завести в virtual_aliases. */
  aliases: string[];
  /**
   * Пароль открытым текстом из выгрузки Kerio (если был). Сразу
   * перехешировать в формат Dovecot; в журналы и файлы не писать.
   */
  password?: string;
}

/** Нормализованные поля, в которые ложатся колонки выгрузки. */
type ColumnKey = 'login' | 'fullName' | 'description' | 'email' | 'groups' | 'password';

/** Синонимы имён колонок (Kerio по-английски, плюс запасные варианты). */
const COLUMN_ALIASES: Record<string, ColumnKey> = {
  name: 'login',
  alias: 'login',
  login: 'login',
  username: 'login',
  user: 'login',
  fullname: 'fullName',
  'full name': 'fullName',
  displayname: 'fullName',
  'display name': 'fullName',
  description: 'description',
  mailaddress: 'email',
  'mail address': 'email',
  email: 'email',
  'e-mail': 'email',
  'email address': 'email',
  'email addresses': 'email',
  groups: 'groups',
  group: 'groups',
  password: 'password',
};

/** Разбить многозначное поле Kerio (значения разделены запятыми). */
function splitMulti(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Разобрать CSV-выгрузку пользователей Kerio Connect.
 * Бросает ошибку, если в файле нет колонки логина (Name).
 */
export function parseKerioUsersCsv(text: string): KerioUser[] {
  const rows = parseCsvWithHeader(text);
  if (rows.length === 0) return [];

  // Колонка логина должна существовать в заголовке (значения могут быть пустыми)
  const firstRow = rows[0];
  const hasLoginColumn =
    firstRow !== undefined && Object.keys(firstRow).some((key) => COLUMN_ALIASES[key] === 'login');
  if (!hasLoginColumn) {
    throw new Error(
      'в CSV не найдена колонка логина (Name/Login/Username) — это не выгрузка пользователей Kerio?',
    );
  }

  const users: KerioUser[] = [];
  for (const row of rows) {
    // Переносим известные колонки в нормализованные поля
    const fields: Partial<Record<ColumnKey, string>> = {};
    for (const [rawKey, value] of Object.entries(row)) {
      const mapped = COLUMN_ALIASES[rawKey];
      if (mapped && value.length > 0 && fields[mapped] === undefined) {
        fields[mapped] = value;
      }
    }
    const login = fields.login?.trim() ?? '';
    if (login.length === 0) continue; // пустая строка выгрузки

    const addresses = fields.email !== undefined ? splitMulti(fields.email) : [];
    users.push({
      login,
      fullName: fields.fullName ?? null,
      description: fields.description ?? null,
      email: addresses[0] ?? null,
      aliases: addresses.slice(1),
      groups: fields.groups !== undefined ? splitMulti(fields.groups) : [],
      password: fields.password ?? null,
    });
  }
  return users;
}

/**
 * Best-effort разбор users.cfg (XML из каталога данных Kerio Connect).
 * Извлекаются <listitem> внутри списков пользователей и их <variable>-поля
 * Name / FullName / Description / EmailAddress. Полноценный XML-парсер
 * в зависимостях монорепозитория отсутствует, поэтому используется
 * упрощённый разбор, достаточный для типичного users.cfg.
 */
export function parseKerioUsersCfg(xml: string): KerioUser[] {
  const users: KerioUser[] = [];
  const itemRe = /<listitem>([\s\S]*?)<\/listitem>/gi;
  const varRe = /<variable\s+name="([^"]+)">([\s\S]*?)<\/variable>/gi;

  for (const item of xml.matchAll(itemRe)) {
    const body = item[1] ?? '';
    const vars = new Map<string, string>();
    for (const v of body.matchAll(varRe)) {
      const name = (v[1] ?? '').trim().toLowerCase();
      const value = decodeXmlEntities((v[2] ?? '').trim());
      if (!vars.has(name)) vars.set(name, value);
    }
    const login = vars.get('name');
    if (!login) continue;
    const addresses = splitMulti(vars.get('emailaddress') ?? vars.get('mailaddress') ?? '');
    users.push({
      login,
      fullName: vars.get('fullname') ?? null,
      description: vars.get('description') ?? null,
      email: addresses[0] ?? null,
      aliases: addresses.slice(1),
      groups: [],
      password: vars.get('password') ?? null,
    });
  }
  return users;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/**
 * Извлечь домен из имени файла выгрузки Kerio
 * (`users_<ИмяДомена>_<дата>.csv`), например
 * `users_example.com_2026-08-05.csv` → `example.com`.
 */
export function domainFromKerioFilename(filename: string): string | null {
  const base = filename.replace(/\\/g, '/').split('/').at(-1) ?? filename;
  const match = /^users_(.+)_[^_]+\.csv$/i.exec(base);
  return match?.[1] ?? null;
}

/**
 * Подготовить список ящиков для создания у нас.
 *
 * @param users  пользователи из выгрузки Kerio
 * @param domain домен новых ящиков (например, 'mail.local'); адреса из
 *               MailAddress без домена дополняются этим доменом
 * @param withPasswords включить в список пароли открытым текстом из
 *               выгрузки (только для немедленного создания ящиков!)
 */
export function toMailboxList(
  users: KerioUser[],
  domain: string,
  withPasswords = false,
): MailboxToCreate[] {
  const withDomain = (addr: string): string => (addr.includes('@') ? addr : `${addr}@${domain}`);
  return users.map((u) => ({
    email: withDomain(u.email ?? u.login),
    displayName: u.fullName,
    aliases: u.aliases.map(withDomain),
    ...(withPasswords && u.password !== null && u.password.length > 0
      ? { password: u.password }
      : {}),
  }));
}
