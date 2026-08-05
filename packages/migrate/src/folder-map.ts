/**
 * Сопоставление папок источника с папками нашего сервера.
 *
 * Порядок принятия решения для каждой папки источника:
 *   1. Явное переопределение из настроек (`overrides`) — всегда побеждает.
 *   2. SPECIAL-USE атрибут, который отдал сервер-источник (RFC 6154 / XLIST).
 *   3. Известные имена спец-папок разных серверов (Kerio «Sent Items»,
 *      «Deleted Items», «Junk E-mail»; русские «Отправленные», «Корзина» …).
 *   4. Обычная папка: путь переносится как есть, только разделитель
 *      иерархии источника заменяется на разделитель приёмника, а служебный
 *      префикс «INBOX/» (Courier, Exchange и др.) отбрасывается.
 */

import type {
  FolderMapping,
  FolderMappingOptions,
  SourceFolder,
  SpecialRole,
} from './types.js';

/** SPECIAL-USE атрибут → роль. */
const SPECIAL_USE_ROLES: Record<string, SpecialRole> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
};

/**
 * Таблица известных имён спец-папок (в нижнем регистре).
 * Собрана по Kerio Connect, Exchange/Outlook, Zimbra, Dovecot, Gmail,
 * Яндекс.Почте и русским локализациям.
 */
const NAME_ROLES: Record<string, SpecialRole> = {
  // Входящие
  inbox: 'inbox',
  'входящие': 'inbox',
  // Отправленные: Kerio/Exchange — "Sent Items", Dovecot — "Sent",
  // Apple Mail — "Sent Messages", Gmail — "[Gmail]/Sent Mail"
  sent: 'sent',
  'sent items': 'sent',
  'sent messages': 'sent',
  'sent mail': 'sent',
  'отправленные': 'sent',
  'отправленные письма': 'sent',
  'исходящие': 'sent',
  // Черновики
  drafts: 'drafts',
  draft: 'drafts',
  'черновики': 'drafts',
  // Корзина: Kerio/Exchange — "Deleted Items"
  trash: 'trash',
  'deleted items': 'trash',
  'deleted messages': 'trash',
  bin: 'trash',
  'корзина': 'trash',
  'удаленные': 'trash',
  'удалённые': 'trash',
  // Спам: Kerio/Outlook — "Junk E-mail", Dovecot по умолчанию — "Junk",
  // у нас — "Spam"
  junk: 'junk',
  'junk e-mail': 'junk',
  'junk email': 'junk',
  'junk mail': 'junk',
  spam: 'junk',
  'спам': 'junk',
  'нежелательная почта': 'junk',
  // Архив
  archive: 'archive',
  archives: 'archive',
  'all mail': 'archive',
  'архив': 'archive',
};

/** Имена спец-папок нашего сервера по умолчанию (infra/dovecot: separator "/"). */
export const DEFAULT_ROLE_TARGETS: Record<SpecialRole, string> = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Spam',
  archive: 'Archive',
};

/** Папки Gmail, которые нет смысла переносить (дубли «All Mail» и служебные). */
const SKIP_NAMES = new Set(['[gmail]', '[google mail]']);

/** Определить роль папки источника (без учёта переопределений). */
export function detectRole(folder: SourceFolder): SpecialRole | null {
  if (folder.specialUse) {
    const role = SPECIAL_USE_ROLES[folder.specialUse.toLowerCase()];
    if (role) return role;
  }
  // Имя целиком (для папок верхнего уровня) …
  const full = folder.path.toLowerCase();
  if (full === 'inbox') return 'inbox';
  const direct = NAME_ROLES[full];
  if (direct) return direct;
  // … или последний сегмент, если папка лежит под INBOX или [Gmail]
  const segments = folder.path.split(folder.delimiter);
  if (segments.length === 2) {
    const parent = (segments[0] ?? '').toLowerCase();
    if (parent === 'inbox' || SKIP_NAMES.has(parent)) {
      const role = NAME_ROLES[(segments[1] ?? '').toLowerCase()];
      if (role) return role;
    }
  }
  return null;
}

/** Экранировать спецсимволы регулярного выражения. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Символы, которые нельзя оставлять ВНУТРИ имени папки приёмника.
 *
 * Разделителя иерархии мало. Наш Dovecot отдаёт по IMAP разделитель «/»,
 * но хранит почту в Maildir++, где уровни вложенности разделяются ТОЧКОЙ.
 * Поэтому папка вида «Отчёт 2024.финал» или «Проект v2.0» (у Kerio такие
 * имена обычны) не создаётся вовсе: сервер отвечает «NO Command failed»,
 * и вся папка со всеми письмами теряется.
 */
export const MAILDIR_UNSAFE_CHARS = ['.'];

/** Заменить в имени сегмента символы, недопустимые у приёмника. */
export function sanitizeSegment(segment: string, unsafe: readonly string[]): string {
  let out = segment;
  for (const ch of unsafe) {
    if (ch.length === 0) continue;
    out = out.split(ch).join('_');
  }
  return out;
}

/**
 * Привести уже готовый путь приёмника к виду, который приёмник примет:
 * иерархия по destDelimiter сохраняется, а внутри каждого сегмента
 * недопустимые символы заменяются на «_».
 */
export function sanitizeDestPath(
  destPath: string,
  destDelimiter: string,
  unsafe: readonly string[],
): string {
  const parts = destDelimiter ? destPath.split(destDelimiter) : [destPath];
  return parts
    .map((s) => sanitizeSegment(s, unsafe.filter((c) => c !== destDelimiter)))
    .join(destDelimiter);
}

/**
 * Перевести «обычный» путь источника в путь приёмника:
 * заменить разделитель и отбросить префикс INBOX, если он служит
 * корнем личного пространства имён (Courier-IMAP, Exchange).
 */
export function translatePath(
  path: string,
  sourceDelimiter: string,
  destDelimiter: string,
  stripInboxPrefix: boolean,
  /**
   * Символы, недопустимые внутри имени папки у приёмника, помимо его
   * разделителя иерархии (для Maildir++ это точка — см. MAILDIR_UNSAFE_CHARS).
   */
  unsafeChars: readonly string[] = [],
): string {
  let p = path;
  if (stripInboxPrefix) {
    const prefix = new RegExp(`^INBOX${escapeRegExp(sourceDelimiter)}`, 'i');
    if (prefix.test(p) && p.toLowerCase() !== 'inbox') {
      p = p.replace(prefix, '');
    }
  }
  const segments = p.split(sourceDelimiter);
  // Символы разделителя приёмника внутри имени сегмента заменяем, чтобы
  // случайно не создать лишний уровень иерархии; вместе с ними — символы,
  // на которых спотыкается хранилище приёмника (точка в Maildir++).
  const unsafe = [...(destDelimiter ? [destDelimiter] : []), ...unsafeChars];
  return segments.map((s) => sanitizeSegment(s, unsafe)).join(destDelimiter);
}

/**
 * Определить, используется ли в источнике префикс личного пространства имён
 * «INBOX<delimiter>» (все прочие папки лежат под INBOX).
 */
export function detectInboxPrefix(folders: SourceFolder[]): boolean {
  const others = folders.filter((f) => f.path.toLowerCase() !== 'inbox');
  if (others.length === 0) return false;
  return others.every((f) =>
    f.path.toLowerCase().startsWith(`inbox${f.delimiter}`.toLowerCase()),
  );
}

/**
 * Построить план сопоставления всех папок источника.
 *
 * @param folders     папки источника (LIST)
 * @param destDelimiter разделитель иерархии приёмника
 * @param destRoleTargets имена спец-папок приёмника (обычно определяются
 *        по SPECIAL-USE самого приёмника; по умолчанию DEFAULT_ROLE_TARGETS)
 * @param options     переопределения и исключения
 */
export function buildFolderMappings(
  folders: SourceFolder[],
  destDelimiter: string,
  destRoleTargets: Partial<Record<SpecialRole, string>> = {},
  options: FolderMappingOptions = {},
  /** Символы, недопустимые внутри имени папки у приёмника (Maildir++: точка). */
  destUnsafeChars: readonly string[] = [],
): FolderMapping[] {
  const targets: Record<SpecialRole, string> = {
    ...DEFAULT_ROLE_TARGETS,
    ...destRoleTargets,
    ...options.roleTargets,
  };
  const exclude = new Set((options.exclude ?? []).map((p) => p.toLowerCase()));
  const overrides = options.overrides ?? {};
  const stripInbox = detectInboxPrefix(folders);

  const mappings: FolderMapping[] = [];
  for (const folder of folders) {
    if (folder.noSelect) continue; // сами письма лежат только в выбираемых папках
    if (exclude.has(folder.path.toLowerCase())) continue;
    const lastSegment = folder.path.split(folder.delimiter).at(-1) ?? folder.path;
    if (SKIP_NAMES.has(folder.path.toLowerCase()) || SKIP_NAMES.has(lastSegment.toLowerCase())) {
      continue;
    }

    // 1. Явное переопределение
    const override = overrides[folder.path];
    if (override !== undefined) {
      mappings.push({ source: folder, destPath: override, role: detectRole(folder), reason: 'override' });
      continue;
    }

    // 2–3. Спец-папка по SPECIAL-USE или по имени
    const role = detectRole(folder);
    if (role) {
      mappings.push({
        source: folder,
        destPath: targets[role],
        role,
        reason: folder.specialUse ? 'special-use' : 'name',
      });
      continue;
    }

    // 4. Обычная папка — переносим иерархию
    mappings.push({
      source: folder,
      destPath: translatePath(
        folder.path,
        folder.delimiter,
        destDelimiter,
        stripInbox,
        destUnsafeChars,
      ),
      role: null,
      reason: 'hierarchy',
    });
  }
  return mappings;
}
