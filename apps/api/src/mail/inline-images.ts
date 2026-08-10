/**
 * Встроенные картинки цитируемого письма — во вложения нового письма.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ
 * ------------------------------------------------------------------
 * Тело письма, которое видит человек, приготовлено для ЧТЕНИЯ: встроенные
 * картинки (`cid:`) переписаны на маршрут `/api/messages/<id>/parts/<part>`
 * (mail/parse.ts). Окно написания цитирует ровно это тело — другого у него
 * нет, — и при отправке такие ссылки не проходят проверку схем URI в
 * санитайзере: атрибут снимается ЦЕЛИКОМ. У получателя оставался `<img>`
 * без адреса, то есть переслать письмо с картинками в подписи или
 * рассылку значило переслать письмо без единой картинки. Молча.
 *
 * Комментарий рядом (mail/forwarded.ts) утверждал обратное — «встроенные
 * картинки уже внутри цитируемой разметки»; внутри разметки была ссылка на
 * НАШ сервер, а не сама картинка.
 *
 * Здесь эти ссылки разбираются обратно: часть письма скачивается из ящика
 * и прикладывается к новому письму как встроенное вложение с собственным
 * `cid`, а в теле остаётся `cid:<новый>`. Ровно так же поступает любая
 * почтовая программа, пересылая письмо с картинками.
 *
 * Чего здесь НЕТ и намеренно: походов в интернет. Внешние картинки
 * (`http://…`) остаются ссылками, как и были в исходном письме, — тянуть
 * их через наш сервер значило бы и подтверждать отправителю прочтение, и
 * раздувать письмо чужими файлами.
 */
import type { ImapFlow } from 'imapflow';
import type { Attachment } from 'nodemailer/lib/mailer';

/** Адрес части письма в нашем API — то, что подставляет parse.ts. */
const PART_URL = /\/api\/messages\/([^/"'\s]+)\/parts\/([^/"'\s?]+)/;

/** Ссылка на часть письма внутри атрибута src. */
const IMG_SRC = /(<img\b[^>]*?\bsrc=)(["'])([^"']*)\2/gi;

export interface InlineImageSource {
  /** Скачивает часть письма. null — письма или части уже нет. */
  fetchPart(
    messageId: string,
    partId: string,
  ): Promise<{ content: Buffer; contentType: string; filename: string | null } | null>;
}

export interface InlineImagesResult {
  html: string;
  attachments: Attachment[];
}

/** Ссылка на часть письма — это `id письма` + `id части`. */
export function parsePartUrl(url: string): { messageId: string; partId: string } | null {
  const found = PART_URL.exec(url);
  if (!found) return null;
  const messageId = decodeURIComponent(found[1] ?? '');
  const partId = decodeURIComponent(found[2] ?? '');
  if (!messageId || !partId) return null;
  return { messageId, partId };
}

/**
 * Заменяет ссылки на части писем встроенными вложениями.
 *
 * Отказ скачать часть — не повод не отправить письмо: ссылка тогда
 * остаётся как была, и картинки у получателя не будет. Это ровно то, что
 * происходило со ВСЕМИ картинками до появления этой функции, — то есть
 * худший случай здесь равен прежнему поведению, а не хуже него.
 */
export async function inlineQuotedImages(
  html: string,
  source: InlineImageSource,
  /** Потолок на письмо: сумма встроенных картинок. */
  maxBytes: number,
): Promise<InlineImagesResult> {
  if (!html.includes('/parts/')) return { html, attachments: [] };

  const attachments: Attachment[] = [];
  /** Одна и та же часть в теле встречается дважды — вкладываем один раз. */
  const seen = new Map<string, string>();
  let total = 0;
  const replacements: Array<{ from: string; to: string }> = [];

  for (const match of html.matchAll(IMG_SRC)) {
    const url = match[3] ?? '';
    const parsed = parsePartUrl(url);
    if (!parsed) continue;
    const key = `${parsed.messageId} ${parsed.partId}`;
    const already = seen.get(key);
    if (already) {
      replacements.push({ from: url, to: `cid:${already}` });
      continue;
    }

    const part = await source.fetchPart(parsed.messageId, parsed.partId).catch(() => null);
    if (!part || part.content.length === 0) continue;
    // Только картинки: чужой тип содержимого в теле письма делать
    // встроенным незачем — он и не показывался бы.
    if (!/^image\//i.test(part.contentType)) continue;
    if (total + part.content.length > maxBytes) continue;
    total += part.content.length;

    /*
     * Свой cid, а не исходный. Исходный принадлежит ЧУЖОМУ письму, и
     * совпадение с cid другой части нового письма (например, из второго
     * пересылаемого письма) склеило бы две разные картинки в одну.
     */
    const cid = `mt-${String(attachments.length + 1)}.${Date.now().toString(36)}@mail.true`;
    seen.set(key, cid);
    attachments.push({
      cid,
      content: part.content,
      contentType: part.contentType,
      filename: part.filename ?? `image-${String(attachments.length + 1)}`,
      contentDisposition: 'inline',
    });
    replacements.push({ from: url, to: `cid:${cid}` });
  }

  let out = html;
  for (const { from, to } of replacements) out = out.split(from).join(to);
  return { html: out, attachments };
}

/** Загрузчик частей писем поверх живого соединения IMAP. */
export function imapPartSource(
  client: ImapFlow,
  openFolder: (client: ImapFlow, folderId: string) => Promise<{ path: string }>,
  splitId: (id: string) => { folderId: string; uid: number },
): InlineImageSource {
  return {
    async fetchPart(messageId, partId) {
      const { folderId, uid } = splitId(messageId);
      const folder = await openFolder(client, folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const dl = await client.download(String(uid), partId, { uid: true });
        if (!dl.content) return null;
        const chunks: Buffer[] = [];
        for await (const chunk of dl.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        const content = Buffer.concat(chunks);
        if (content.length === 0) return null;
        return {
          content,
          contentType: dl.meta.contentType ?? 'application/octet-stream',
          filename: dl.meta.filename ?? null,
        };
      } finally {
        lock.release();
      }
    },
  };
}
