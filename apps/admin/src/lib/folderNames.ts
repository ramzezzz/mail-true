/**
 * Отображаемые названия папок в админке.
 *
 * Тот же перевод, что и в почте (`apps/web/src/lib/folderNames.ts`), но по
 * служебному признаку IMAP, а не по роли: админский маршрут отдаёт папки
 * так, как их видит почтовый сервер.
 *
 * Зачем это здесь. Перевод названий сделали в почте и посчитали закрытым,
 * а админка осталась с исходными `INBOX`, `Sent`, `Drafts`. Администратор,
 * разбирая жалобу владельца ящика, видел не те названия папок, что владелец,
 * — и говорил с человеком на разных языках. Нашлось это только отдельным
 * проходом недоверия, который перепроверял уже «исправленное».
 */

const BY_SPECIAL_USE: Record<string, string> = {
  '\\Inbox': 'Входящие',
  '\\Sent': 'Отправленные',
  '\\Drafts': 'Черновики',
  '\\Junk': 'Спам',
  '\\Trash': 'Корзина',
  '\\Archive': 'Архив',
};

/** У «Входящих» служебного признака может не быть — узнаём по имени. */
const BY_PATH: Record<string, string> = {
  INBOX: 'Входящие',
};

/** Название папки для показа. Пользовательские папки сохраняют своё имя. */
export function folderTitle(folder: {
  name: string;
  path?: string;
  specialUse?: string | null;
}): string {
  if (folder.specialUse) {
    const byUse = BY_SPECIAL_USE[folder.specialUse];
    if (byUse) return byUse;
  }
  const byPath = BY_PATH[(folder.path ?? folder.name).toUpperCase()];
  return byPath ?? folder.name;
}

/**
 * Служебные каталоги почтового сервера, которые не должны показываться
 * человеку как папки: он может их переименовать или удалить.
 */
export function isServiceFolder(folder: { path?: string; name: string }): boolean {
  const p = folder.path ?? folder.name;
  return p.startsWith('dovecot/') || p.startsWith('.') || p.includes('/.');
}
