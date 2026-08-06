/**
 * Операторы поиска на стороне браузера.
 *
 * Грамматика одна на всех и лежит в общем пакете
 * (packages/shared/src/search.ts). Здесь — только то, что сервер сделать
 * не может, и то, что нужно показать человеку:
 *
 *   `папка:Рассылки` — область поиска. У IMAP папка не условие поиска,
 *                      а то, что открыто до поиска; выбирает её тот, кто
 *                      этот поиск запускает, — то есть браузер (см.
 *                      useSearch: «Везде» разворачивается в запрос по
 *                      каждой папке).
 *   чипы             — во что превратился запрос. Показывать обязательно:
 *                      разборщик молча меняет смысл строки, и без чипов
 *                      человек не отличит «нашлось ноль» от «понято не так».
 */

import {
  describeSearch,
  parseSearch,
  type Folder,
  type ParsedSearch,
  type SearchChip,
} from '@mail-true/shared';
import { folderTitle } from '../lib/folderNames';

/** Разобранный запрос вместе со всем, что о нём надо показать. */
export interface SearchPlan {
  parsed: ParsedSearch;
  /** Чипы над выдачей — по одному на условие. */
  chips: SearchChip[];
  /** Папка, названная оператором `папка:`. */
  folder: Folder | null;
  /**
   * Оператор `папка:` был, а такой папки нет.
   *
   * Не пустой список молча, а названная причина. Молчание здесь — худший
   * из вариантов: человек видел бы «ничего не найдено» и искал ошибку
   * в запросе, а ошибка в названии папки.
   */
  unknownFolder: string | null;
}

/** Сравнение названий: без регистра и без разницы между «ё» и «е». */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/ё/gu, 'е');
}

/**
 * Ищет папку по тому, как её мог назвать человек: русским названием из
 * интерфейса, собственным именем, идентификатором или путём IMAP.
 *
 * Четыре способа, а не один, потому что человек пишет то, что видит
 * («Входящие»), а адрес и ящик знают совсем другие слова («inbox», «INBOX»).
 * Требовать от него правильного — значит требовать знать наше устройство.
 */
export function findFolderByName(folders: readonly Folder[], name: string): Folder | null {
  const wanted = normalize(name);
  if (wanted === '') return null;
  const exact =
    folders.find((f) => normalize(folderTitle(f)) === wanted) ??
    folders.find((f) => normalize(f.name) === wanted) ??
    folders.find((f) => normalize(f.id) === wanted) ??
    folders.find((f) => normalize(f.path) === wanted);
  if (exact) return exact;
  /*
   * Хвост пути — для вложенных папок: «папка:Отчёты» должно найти
   * «Работа/Отчёты». Целиком путь человек не пишет почти никогда.
   */
  return folders.find((f) => normalize(f.path).endsWith(`/${wanted}`)) ?? null;
}

/** Разбирает запрос и раскладывает всё, что нужно показать и применить. */
export function planSearch(query: string, folders: readonly Folder[]): SearchPlan {
  const parsed = parseSearch(query);
  const chips = describeSearch(parsed);
  if (!parsed.folder) return { parsed, chips, folder: null, unknownFolder: null };
  const folder = findFolderByName(folders, parsed.folder);
  /*
   * Пока папки не загрузились, о ненайденной говорить рано: пустой список
   * папок — это «ещё не знаем», а не «такой папки нет».
   */
  const unknownFolder = folder || folders.length === 0 ? null : parsed.folder;
  return { parsed, chips, folder, unknownFolder };
}
