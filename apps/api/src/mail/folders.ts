/**
 * Маппинг IMAP-папок в доменную модель Folder:
 * определение ролей (inbox/sent/drafts/spam/trash/archive),
 * стабильные идентификаторы, дерево вложенности, счётчики.
 */
import type { Folder, FolderRole } from '@mail-true/shared';

/** Сырые данные папки из IMAP LIST (+ STATUS). */
export interface RawFolderInfo {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse?: string | undefined;
  flags?: Set<string> | undefined;
  status?:
    | {
        messages?: number | undefined;
        unseen?: number | undefined;
        uidValidity?: bigint | undefined;
      }
    | undefined;
}

const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
};

/** Подстраховка по имени, если сервер не сообщил SPECIAL-USE. */
const NAME_HINTS: Array<[RegExp, FolderRole]> = [
  [/^inbox$/i, 'inbox'],
  [/^(sent|sent items|sent messages|sent mail|отправленные)$/i, 'sent'],
  [/^(drafts?|черновики)$/i, 'drafts'],
  [/^(junk|junk e-?mail|spam|спам)$/i, 'spam'],
  [/^(trash|deleted|deleted items|deleted messages|корзина|удал[её]нные)$/i, 'trash'],
  [/^(archives?|архив)$/i, 'archive'],
  // «Отложенные». SPECIAL-USE для неё в RFC 6154 нет — ни у кого: ни Gmail,
  // ни Fastmail не смогли договориться о ключевом слове. Значит, узнаётся
  // только по имени, и русское имя здесь не для красоты: ящик мог приехать
  // с чужого сервера, где папку уже назвали по-русски.
  [/^(snoozed|отложенные)$/i, 'snoozed'],
  // «Заглушённые» — по тем же причинам, что и «Отложенные»: своего
  // SPECIAL-USE у неё нет, а русское имя нужно на случай ящика, приехавшего
  // с чужого сервера.
  [/^(muted|заглушённые|заглушенные)$/i, 'muted'],
];

const ROLE_ORDER: FolderRole[] = [
  'inbox',
  'sent',
  'drafts',
  // «Отложенные» стоят сразу после черновиков и ДО спама с корзиной:
  // это папка, в которую человек заглядывает, а не свалка.
  'snoozed',
  // «Заглушённые» — сразу за «Отложенными»: это тоже папка, куда человек
  // заглядывает сам, а не свалка. Но ниже — заглядывает он туда реже.
  'muted',
  'spam',
  'trash',
  'archive',
];

/**
 * Корневые каталоги, которые Dovecot заводит себе сам.
 *
 * `dovecot/lda-dupes/locks` — служебное хранилище защиты от дублей при
 * доставке. В Maildir++ оно лежит рядом с папками пользователя
 * (`.dovecot.lda-dupes.locks`) и честно приходит в ответе на LIST, поэтому
 * попадало в дерево наравне с «Входящими»: человек видел папку «locks»,
 * мог её переименовать и удалить — то есть сломать доставку. Имена
 * зарезервированы самим Dovecot, завести такую папку пользователь не может.
 */
const SERVICE_ROOTS = new Set(['dovecot', 'sieve']);

/**
 * Папка, куда уезжает очищенная корзина (см. settings/recovery-mailbox.ts).
 *
 * Имя английское, как у остальных служебных папок: ящик должен оставаться
 * понятным в любой почтовой программе. По-русски её называет интерфейс —
 * «Восстановление писем» в настройках.
 *
 * В дереве папок её НЕ показываем, и это осознанный размен. Показать
 * значило бы завести рядом с «Корзиной» вторую корзину, из которой нельзя
 * ни писать, ни читать письма, — человек справедливо спросил бы, зачем
 * их две. Спрятать значит взять на себя обязанность рассказать о ней в
 * другом месте, и раздел настроек рассказывает: сколько там писем,
 * сколько они занимают и когда исчезнут.
 *
 * Оборотная сторона: если человек САМ заведёт папку с таким именем, она
 * тоже пропадёт из дерева. Имя выбрано так, чтобы это было маловероятно
 * (служебное английское слово в корне ящика), и совпадение ничего не
 * ломает — письма в такой папке целы и видны любой почтовой программе.
 */
export const RECOVERY_FOLDER_PATH = 'Recovery';

/** Служебный ли это каталог (его и всё, что внутри, не показываем). */
export function isServiceFolder(info: Pick<RawFolderInfo, 'path' | 'delimiter'>): boolean {
  const delimiter = info.delimiter || '/';
  const first = info.path.split(delimiter)[0] ?? info.path;
  if (first === RECOVERY_FOLDER_PATH) return true;
  return SERVICE_ROOTS.has(first.toLowerCase());
}

/** Определяет роль папки по SPECIAL-USE или имени. */
export function detectRole(info: RawFolderInfo): FolderRole {
  if (info.path.toUpperCase() === 'INBOX') return 'inbox';
  if (info.specialUse) {
    const role = ROLE_BY_SPECIAL_USE[info.specialUse];
    if (role) return role;
  }
  for (const [re, role] of NAME_HINTS) {
    if (re.test(info.name)) return role;
  }
  return 'custom';
}

/**
 * Наибольшая длина пути папки в байтах.
 *
 * Ограничение существует потому, что путь целиком попадает в адрес запроса:
 * идентификатор папки — это `f-<base64url(путь)>`, а идентификатор письма —
 * `<идентификатор папки>:<номер>`. Кодирование удлиняет путь примерно в
 * 1,34 раза, а кириллица занимает по два байта на букву — то есть папка из
 * 37 русских букв уже давала идентификатор длиннее ста символов.
 *
 * Раньше предела не было ни здесь, ни в маршрутизаторе (у Fastify по
 * умолчанию сто символов на параметр адреса), и папка с длинным названием
 * становилась ловушкой: список писем в ней открывался, а само письмо нельзя
 * было ни прочитать, ни пометить, ни ВЫНЕСТИ ОБРАТНО — все обращения по
 * идентификатору отвергались. Папку при этом тоже нельзя было ни
 * переименовать, ни удалить. Письмо, попавшее туда правилом фильтрации,
 * оставалось недостижимым ничем, кроме доступа к серверу.
 *
 * Теперь предел задан явно и проверяется при создании и переименовании —
 * человек узнаёт о нём сразу и внятным сообщением, а не после того, как
 * потеряет письмо.
 */
export const MAX_FOLDER_PATH_BYTES = 255;

/**
 * Запас длины для параметров адреса.
 *
 * Считается от предела пути: base64url прибавляет треть, «f-» два символа,
 * двоеточие и номер письма ещё до одиннадцати. Берётся с запасом, чтобы уже
 * созданные длинные папки остались достижимыми и их можно было разобрать.
 */
export const MAX_ENTITY_ID_LENGTH = 512;

/** Длина пути в байтах: кириллица занимает по два, а предел IMAP — в байтах. */
export function folderPathBytes(path: string): number {
  return Buffer.byteLength(path, 'utf8');
}

/** Кодирует произвольный IMAP-путь в URL-безопасный идентификатор. */
export function encodePathId(path: string): string {
  return 'f-' + Buffer.from(path, 'utf8').toString('base64url');
}

/** Обратное преобразование encodePathId. */
export function decodePathId(id: string): string | null {
  if (!id.startsWith('f-')) return null;
  try {
    return Buffer.from(id.slice(2), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Преобразует список IMAP-папок в Folder[].
 * Первая папка каждой системной роли получает id, равный роли
 * ('inbox', 'sent', ...); остальные — 'f-<base64url(path)>'.
 */
export function mapFolders(list: RawFolderInfo[]): Folder[] {
  // Отбрасываем невыбираемые контейнеры и служебные каталоги Dovecot
  const selectable = list.filter(
    (f) => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent') && !isServiceFolder(f)
  );

  const withRoles = selectable.map((info) => ({ info, role: detectRole(info) }));

  // Стабильный порядок: системные роли по приоритету, остальные по алфавиту пути
  withRoles.sort((a, b) => {
    const ai = a.role === 'custom' ? ROLE_ORDER.length : ROLE_ORDER.indexOf(a.role);
    const bi = b.role === 'custom' ? ROLE_ORDER.length : ROLE_ORDER.indexOf(b.role);
    if (ai !== bi) return ai - bi;
    return a.info.path.localeCompare(b.info.path);
  });

  const usedRoleIds = new Set<string>();
  const idByPath = new Map<string, string>();
  const folders: Folder[] = [];

  for (const { info, role } of withRoles) {
    let id: string;
    let effectiveRole = role;
    if (role !== 'custom' && !usedRoleIds.has(role)) {
      id = role;
      usedRoleIds.add(role);
    } else {
      id = encodePathId(info.path);
      // Дубликат системной роли показываем как обычную папку
      if (role !== 'custom' && usedRoleIds.has(role)) effectiveRole = 'custom';
    }
    idByPath.set(info.path, id);

    const depth = info.parentPath ? info.parentPath.split(info.delimiter).length : 0;
    folders.push({
      id,
      path: info.path,
      name: info.name,
      role: effectiveRole,
      parentId: null, // проставим вторым проходом
      depth,
      unreadCount: info.status?.unseen ?? 0,
      totalCount: info.status?.messages ?? 0,
      system: effectiveRole !== 'custom',
      uidValidity: Number(info.status?.uidValidity ?? 0n),
    });
  }

  for (const folder of folders) {
    const raw = selectable.find((f) => f.path === folder.path);
    if (raw && raw.parentPath) {
      folder.parentId = idByPath.get(raw.parentPath) ?? null;
    }
  }

  return folders;
}

/** Ищет папку по её публичному идентификатору. */
export function findFolderById(folders: Folder[], folderId: string): Folder | null {
  return folders.find((f) => f.id === folderId) ?? null;
}
