/**
 * Чтение сохранённого черновика ОБРАТНО в окно написания.
 *
 * Зачем это вообще понадобилось. Черновик сохранялся собранным письмом
 * (RFC822) и лежал в папке «Черновики» — но прочитать его назад в форму было
 * нечем: щелчок по черновику открывал обычный просмотр письма, а окно
 * написания не открывалось никак. То есть дописать своё же неотправленное
 * письмо было невозможно, и папка «Черновики» работала как мусорная корзина
 * для набранного текста.
 *
 * Здесь живёт разбор письма в поля формы. Всё, что касается ящика и хранилища
 * загрузок, осталось в маршруте (routes/compose.ts): этот файл — чистая
 * функция от байтов письма, поэтому его можно проверить без IMAP.
 */
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';
import type { MailAddress } from '@mail-true/shared';
import { sanitizeEmailHtml } from './sanitize.js';

/** Вложение черновика, вынутое из письма. */
export interface DraftAttachmentPart {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Черновик, разобранный на поля формы. Вложения — ещё байтами. */
export interface ParsedDraft {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyHtml: string;
  attachments: DraftAttachmentPart[];
  inReplyTo: string | null;
  references: string[];
  requestReadReceipt: boolean;
}

/** Адреса из mailparser в наш вид. */
function addresses(obj: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : [obj];
  const out: MailAddress[] = [];
  for (const item of list) {
    for (const a of item.value) {
      if (!a.address) continue;
      out.push({ name: a.name && a.name.trim() !== '' ? a.name : null, address: a.address });
    }
  }
  return out;
}

/** Экранирование: голый текст письма вставляется в форму как текст. */
function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n/g, '\n');
  return escaped
    .split('\n')
    .map((line) => `<div>${line === '' ? '<br>' : line}</div>`)
    .join('');
}

/**
 * Разбирает исходник черновика в поля окна написания.
 *
 * Про внешние картинки. Тело черновика НЕ обеззараживается блокировкой
 * картинок (`allowRemote: true`), в отличие от чужого письма при просмотре.
 * Причина простая: это письмо человек написал сам и сам же его отправит.
 * Подмени мы в нём адреса картинок на пустышки — каждое открытие черновика
 * портило бы письмо, и после трёх заходов до получателя доехали бы прозрачные
 * точки вместо картинок. Разметка при этом всё равно чистится: скрипты и
 * обработчики событий не должны выполниться в окне написания даже из своего
 * же черновика (его мог положить туда и не человек — например, отказ
 * отложенной отправки чужого письма, пересланного вложением).
 */
export async function parseDraftSource(source: Buffer): Promise<ParsedDraft> {
  const parsed = await simpleParser(source, { skipImageLinks: true });

  /**
   * Картинки черновика ВШИВАЮТСЯ В ТЕЛО (`data:`), а не ссылаются наружу.
   *
   * ------------------------------------------------------------------
   * ПОЧЕМУ НЕ ССЫЛКА НА ЧАСТЬ ПИСЬМА
   * ------------------------------------------------------------------
   * Сначала здесь стоял адрес нашего же маршрута части письма —
   * `/api/messages/drafts:<номер>/parts/<N>`. Выглядело правильно и
   * работало ровно один раз: номер черновика меняется при КАЖДОМ
   * сохранении, прежний черновик при этом удаляется. Значит второе
   * автосохранение (а оно случается через три секунды набора) шло за
   * картинкой по мёртвому адресу, не находило её — и клало в ящик письмо
   * уже без картинки. На экране она всё это время была: браузер держит её
   * в своей памяти час. То есть человек отправлял письмо без картинки,
   * глядя на картинку.
   *
   * Вшитая в тело картинка не зависит ни от какого номера. Уходящее
   * письмо от этого не страдает: при сборке `data:` переносится во
   * встроенное вложение с `cid:` (mail/inline-data.ts) — ровно так же,
   * как это делается для картинок цитаты и для снимка экрана,
   * вставленного в письмо из буфера.
   */
  const placed = new Set<string>();
  const inlined = new Map<string, string>();
  for (const part of parsed.attachments) {
    const cid = typeof part.cid === 'string' ? part.cid.replace(/[<>]/g, '') : '';
    if (cid === '' || !part.related) continue;
    if (!/^image\//i.test(part.contentType || '')) continue;
    inlined.set(cid, `data:${part.contentType};base64,${part.content.toString('base64')}`);
  }

  const html = parsed.html
    ? sanitizeEmailHtml(parsed.html, {
        allowRemote: true,
        resolveCid: (cid: string): string | null => {
          const url = inlined.get(cid);
          if (url === undefined) return null;
          placed.add(cid);
          return url;
        },
      }).html
    : // Текстовый черновик тоже надо во что-то превратить: редактор в окне
      // написания работает с разметкой, и голый текст без этого слипся бы
      // в одну строку.
      textToHtml(parsed.text ?? '');

  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];

  /**
   * Вложения. `related` — это части, на которые ссылается само тело письма
   * (встроенные картинки по `cid:`). Прикладывать их ещё и файлами нельзя:
   * человек увидел бы в окне написания вложения, которых он не прикреплял,
   * и они уехали бы получателю вторым экземпляром.
   *
   * Но пропускается такая часть, только ЕСЛИ ОНА ВСТАЛА В ТЕЛО. Прежде
   * условие было безусловным, и при любом сбое соответствия картинка
   * пропадала отовсюду разом. Лишнее вложение человек увидит и уберёт
   * сам; исчезнувшего он не увидит никогда.
   */
  const attachments: DraftAttachmentPart[] = [];
  for (const part of parsed.attachments) {
    const cid = typeof part.cid === 'string' ? part.cid.replace(/[<>]/g, '') : '';
    if (part.related && cid !== '' && placed.has(cid)) continue;
    attachments.push({
      filename: part.filename ?? 'attachment',
      mimeType: part.contentType || 'application/octet-stream',
      content: part.content,
    });
  }

  return {
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    subject: parsed.subject ?? '',
    bodyHtml: html,
    attachments,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    // Просьба уведомить о прочтении живёт заголовком (RFC 8098). Потерять её
    // при дописывании нельзя: человек её уже поставил осознанно.
    requestReadReceipt: Boolean(parsed.headers.get('disposition-notification-to')),
  };
}
