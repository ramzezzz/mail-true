/**
 * Разбор BODYSTRUCTURE: поиск вложений, встроенных картинок и текстовых частей.
 */
import type { MessageStructureObject } from 'imapflow';
import type { AttachmentInfo } from '@mail-true/shared';

function isMultipart(node: MessageStructureObject): boolean {
  return node.type.toLowerCase().startsWith('multipart/');
}

/** Вложенное письмо: часть `message/rfc822` (переслано «как вложение»). */
function isEmbeddedMessage(node: MessageStructureObject): boolean {
  return node.type.toLowerCase() === 'message/rfc822';
}

/** Имя файла для сохранения на диск: из темы вложенного письма. */
function embeddedMessageFilename(node: MessageStructureObject): string {
  const subject = node.envelope?.subject?.trim();
  if (!subject) return 'Вложенное письмо.eml';
  // Оставляем только безопасное для имени файла: буквы, цифры и немного
  // пунктуации. Всё остальное (в том числе разделители пути и управляющие
  // символы) схлопывается в пробел.
  const safe = subject
    .replace(/[^\p{L}\p{N} _.()№,+'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = safe.slice(0, 120).trim() || 'Вложенное письмо';
  return `${trimmed}.eml`;
}

/**
 * Названия кодировок, которые попадают в имя файла обломком разбора.
 *
 * Параметр RFC 2231 записывается как `filename*=UTF-8''%D0%BE...`: сначала
 * кодировка, потом язык, потом само значение. Кривые клиенты (и посредники,
 * обрезающие длинные заголовки) присылают `filename*=UTF-8` без апострофов
 * и без значения — и разборщик честно отдаёт «UTF-8» как имя файла.
 *
 * Такое письмо разобрано на живом стенде: вложение показывалось с именем
 * «UTF-8», без расширения, при том что в соседнем `Content-Type` лежало
 * настоящее имя. Человек скачивал файл, который нечем открыть.
 */
const ENCODING_NAMES =
  /^(utf-?8|utf-?7|koi8-[ru]|windows-\d{3,4}|cp\d{3,4}|iso-8859-\d{1,2}|us-ascii|ascii)$/i;

/**
 * Годится ли значение как имя файла.
 *
 * Риск отбросить настоящий файл, названный «UTF-8», ничтожен, а запасное
 * имя у нас есть всегда — либо `name` из Content-Type, либо тема вложенного
 * письма, либо «attachment».
 */
export function looksLikeFilename(value: string | undefined | null): boolean {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return false;
  return !ENCODING_NAMES.test(trimmed);
}

function nodeFilename(node: MessageStructureObject): string | null {
  // Источники перебираются по порядку, а негодные пропускаются: раньше
  // бралось первое непустое, и обломок разбора из `filename` побеждал
  // совершенно годное имя из `name`.
  for (const candidate of [
    node.dispositionParameters?.['filename'],
    node.parameters?.['name'],
  ]) {
    if (looksLikeFilename(candidate)) return (candidate as string).trim();
  }
  // У вложенного письма нет ни Content-Disposition, ни имени файла: почтовые
  // клиенты пересылают его голой частью message/rfc822. Раньше из-за этого
  // такое вложение не попадало в список вовсе — при том, что сама часть
  // прекрасно отдавалась маршрутом /parts/:partId. Пользователь видел письмо
  // без вложения и не мог его скачать.
  if (isEmbeddedMessage(node)) return embeddedMessageFilename(node);
  return null;
}

function cleanContentId(id: string | undefined): string | null {
  if (!id) return null;
  return id.replace(/[<>]/g, '');
}

/**
 * Размер вложения в байтах ФАЙЛА, а не в байтах письма.
 *
 * В BODYSTRUCTURE лежит размер части уже в закодированном виде — в письме
 * вложение едет в base64. Показывать его пользователю нельзя: файл на
 * 3 000 000 байт отображался как 4 105 262 (завышение примерно на 37%),
 * при том что скачивался он байт в байт правильным. Человек сравнивает
 * размер в списке вложений с размером файла на диске — и не сходится.
 *
 * Обратный пересчёт точен, потому что кодировщики строго следуют RFC 2045:
 * 4 символа base64 на каждые 3 байта плюс перенос строки (CRLF) после
 * каждых 76 символов. Проверка на живом примере: 4 105 262 -> 3 000 000.
 *
 * quoted-printable не пересчитываем: там раздувание зависит от содержимого
 * (от 0% для текста ASCII до +200% для кириллицы), и однозначного обратного
 * преобразования нет. Такой кодировкой вложения-файлы почти не ездят —
 * это кодировка текстовых частей.
 */
export function decodedPartSize(node: MessageStructureObject): number {
  const size = node.size ?? 0;
  if (size <= 0) return 0;
  const encoding = (node.encoding ?? '').toLowerCase();
  if (encoding !== 'base64') return size;
  // Снимаем переносы строк: на каждые 76 символов приходится 2 байта CRLF,
  // после последней строки переноса нет — отсюда «+2».
  const chars = Math.round(((size + 2) * 76) / 78);
  // 4 символа base64 -> 3 байта; хвостовое дополнение '=' даёт погрешность
  // не больше двух байт и на отображаемом размере не сказывается.
  return Math.floor(chars / 4) * 3;
}

/** Является ли узел вложением или встроенной картинкой. */
function isAttachmentNode(node: MessageStructureObject): boolean {
  if (isMultipart(node)) return false;
  const disposition = node.disposition?.toLowerCase();
  if (disposition === 'attachment') return true;
  if (nodeFilename(node)) return true;
  // Встроенная картинка с Content-ID
  if (node.id && node.type.toLowerCase().startsWith('image/')) return true;
  return false;
}

/** Собирает список вложений (включая inline-картинки) из BODYSTRUCTURE. */
export function collectAttachments(structure: MessageStructureObject | undefined): AttachmentInfo[] {
  const result: AttachmentInfo[] = [];
  if (!structure) return result;

  const walk = (node: MessageStructureObject): void => {
    if (isAttachmentNode(node)) {
      const contentId = cleanContentId(node.id);
      const inline = node.disposition?.toLowerCase() === 'inline' || (!node.disposition && Boolean(contentId));
      result.push({
        partId: node.part ?? '1',
        filename: nodeFilename(node) ?? 'attachment',
        mimeType: node.type.toLowerCase(),
        size: decodedPartSize(node),
        contentId,
        inline: Boolean(inline && contentId),
      });
      // Части вложенного письма принадлежат самому вложению и отдельными
      // вложениями внешнего письма не являются
      if (isEmbeddedMessage(node)) return;
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(structure);
  return result;
}

/** Соответствие Content-ID -> номер части (для переписывания cid:-ссылок). */
export function cidToPartMap(structure: MessageStructureObject | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const att of collectAttachments(structure)) {
    if (att.contentId) map.set(att.contentId, att.partId);
  }
  return map;
}

export interface TextPartRef {
  part: string;
  /** 'plain' или 'html' */
  kind: 'plain' | 'html';
}

/** Находит основную текстовую часть письма (предпочитая text/plain). */
export function pickTextPart(structure: MessageStructureObject | undefined): TextPartRef | null {
  if (!structure) return null;
  let plain: TextPartRef | null = null;
  let html: TextPartRef | null = null;

  const walk = (node: MessageStructureObject): void => {
    if (!isMultipart(node) && !isAttachmentNode(node)) {
      const type = node.type.toLowerCase();
      const part = node.part ?? 'TEXT';
      if (type === 'text/plain' && !plain) plain = { part, kind: 'plain' };
      if (type === 'text/html' && !html) html = { part, kind: 'html' };
    }
    // Текст вложенного письма — не текст этого письма: сниппет должен
    // показывать сопроводительную строку, а не содержимое вложения
    if (isEmbeddedMessage(node)) return;
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(structure);
  return plain ?? html;
}

/** Есть ли настоящие (не inline) вложения. */
export function hasRealAttachments(structure: MessageStructureObject | undefined): boolean {
  return collectAttachments(structure).some((a) => !a.inline);
}
