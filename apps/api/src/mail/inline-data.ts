/**
 * Картинки, вшитые в тело письма (`data:`), — во встроенные вложения.
 *
 * ------------------------------------------------------------------
 * ОТКУДА ОНИ БЕРУТСЯ И ПОЧЕМУ ТАК ОТПРАВЛЯТЬ НЕЛЬЗЯ
 * ------------------------------------------------------------------
 * Два пути приводят к одному и тому же виду тела:
 *
 *  1. ЧЕРНОВИК С КАРТИНКОЙ. Открытый на дописывание черновик отдаётся
 *     окну написания с картинками, вшитыми прямо в разметку (см.
 *     mail/draft-read.ts). Так сделано намеренно: прежде там стояла
 *     ссылка на часть письма `/api/messages/drafts:<номер>/parts/<N>`, а
 *     номер черновика меняется при КАЖДОМ сохранении — прежний удаляется.
 *     Значит уже второе автосохранение скачивало часть по мёртвому
 *     адресу, не находило её и оставляло `<img>` без картинки. Человек
 *     при этом видел картинку на экране (браузер держит её в своей
 *     памяти час) и отправлял письмо, в котором её нет.
 *
 *  2. ВСТАВКА ИЗ БУФЕРА. Снимок экрана, вставленный в поле письма,
 *     браузер кладёт в разметку тем же `data:`. Уходило это получателю
 *     как есть, а почтовые программы такие картинки не показывают:
 *     Outlook и Gmail режут `data:` в письмах.
 *
 * Здесь они превращаются в обычные встроенные вложения с `cid:` — ровно
 * в то, что делает любая почтовая программа, и в то, что уже делается
 * для картинок цитаты (mail/inline-images.ts).
 */
import type { Attachment } from 'nodemailer/lib/mailer';

/** `<img src="data:image/png;base64,...">` — то, что надо вынуть. */
const DATA_IMG_SRC = /(<img\b[^>]*?\bsrc=)(["'])(data:image\/[^"';]+;base64,[^"']*)\2/gi;

/** Разбор самой ссылки: тип содержимого и байты. */
const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i;

export interface InlineDataResult {
  html: string;
  attachments: Attachment[];
  /**
   * Сколько картинок НЕ поместилось в предел письма.
   *
   * Они остаются в теле как были: вырезать картинку молча нельзя, а
   * отказывать за неё должен тот, кто знает предел целиком (composeRaw).
   */
  skipped: number;
  /** Сколько байт заняли перенесённые картинки (в исходном виде). */
  bytes: number;
}

/** Расширение файла по типу содержимого — только для имени вложения. */
function extensionOf(contentType: string): string {
  const sub = contentType.slice(contentType.indexOf('/') + 1).toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  return sub.replace(/[^a-z0-9]/g, '') || 'img';
}

/**
 * Выносит вшитые картинки из тела во вложения.
 *
 * `maxBytes` — сколько ещё можно занять В ИСХОДНЫХ байтах: письмо
 * кодируется base64, и запас считает вызывающий.
 */
export function inlineDataImages(html: string, maxBytes: number): InlineDataResult {
  if (!html.includes('data:image/')) {
    return { html, attachments: [], skipped: 0, bytes: 0 };
  }

  const attachments: Attachment[] = [];
  /** Одна и та же картинка в теле дважды — вкладываем один раз. */
  const seen = new Map<string, string>();
  const replacements: Array<{ from: string; to: string }> = [];
  let total = 0;
  let skipped = 0;

  for (const match of html.matchAll(DATA_IMG_SRC)) {
    const url = match[3] ?? '';
    const already = seen.get(url);
    if (already) {
      replacements.push({ from: url, to: `cid:${already}` });
      continue;
    }
    const parsed = DATA_URI.exec(url);
    if (!parsed) continue;
    const contentType = (parsed[1] ?? '').toLowerCase();
    const base64 = (parsed[2] ?? '').replace(/\s+/g, '');
    if (base64 === '') continue;

    let content: Buffer;
    try {
      content = Buffer.from(base64, 'base64');
    } catch {
      continue;
    }
    if (content.length === 0) continue;
    if (total + content.length > maxBytes) {
      skipped += 1;
      continue;
    }
    total += content.length;

    /*
     * Свой cid, а не выдуманный из содержимого: он должен быть уникален
     * в пределах ОДНОГО письма и не совпасть с cid картинки цитаты,
     * которую переносит соседний перенос (inline-images.ts). Совпадение
     * склеило бы две разные картинки в одну.
     */
    const cid = `mtd-${String(attachments.length + 1)}.${Date.now().toString(36)}@mail.true`;
    seen.set(url, cid);
    attachments.push({
      cid,
      content,
      contentType,
      filename: `image-${String(attachments.length + 1)}.${extensionOf(contentType)}`,
      contentDisposition: 'inline',
    });
    replacements.push({ from: url, to: `cid:${cid}` });
  }

  let out = html;
  for (const { from, to } of replacements) out = out.split(from).join(to);
  return { html: out, attachments, skipped, bytes: total };
}
