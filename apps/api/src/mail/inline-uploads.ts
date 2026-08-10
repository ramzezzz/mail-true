/**
 * Картинки из временного хранилища — во встроенные вложения письма.
 *
 * ------------------------------------------------------------------
 * ОТКУДА В ТЕЛЕ БЕРУТСЯ ССЫЛКИ НА ЗАГРУЗКИ
 * ------------------------------------------------------------------
 * Их ставит чтение черновика (routes/compose.ts, `GET /drafts/:uid`).
 * У встроенной картинки черновика нет постоянного адреса: ссылка на
 * часть письма умирает при первом же пересохранении — номер черновика
 * меняется, прежний удаляется. А вшивать байты прямо в тело значит
 * возить их на сервер при каждом автосохранении: черновик с фотографией
 * на четыре мегабайта гнал бы пять с половиной вверх каждые три секунды
 * набора, и сервер каждый раз пересобирал бы письмо целиком.
 *
 * Номер загрузки постоянен. Поэтому в теле, которое правит человек,
 * стоит `/api/uploads/<номер>/content`, а при сборке уходящего письма
 * эта ссылка превращается в обычное встроенное вложение с `cid:` —
 * ровно так же, как это делается для картинок цитаты
 * (mail/inline-images.ts) и для снимка экрана из буфера
 * (mail/inline-data.ts).
 *
 * Отправить такую ссылку наружу нельзя: у получателя нет ни нашей
 * сессии, ни доступа к чужому временному хранилищу — он увидел бы
 * пустое место.
 */
import type { Attachment } from 'nodemailer/lib/mailer';

/** Хранилище загрузок в том объёме, какой здесь нужен. */
export interface UploadSource {
  get(
    id: string,
    owner: string,
  ): Promise<{ meta: { filename: string; mimeType: string; size: number }; path: string } | null>;
  /**
   * Продлить срок жизни использованной загрузки. Необязателен: проверки
   * подставляют сюда заглушку хранилища, а не всё хранилище целиком.
   */
  touch?(id: string): Promise<void>;
}

/**
 * Ссылка на загрузку в атрибуте или в стиле.
 *
 * Поиск идёт от литерала `/api/uploads/`, а не от тега: разбор от `<img`
 * с ленивым просмотром до атрибута стоит квадрат от длины письма и уже
 * однажды останавливал сервер на минуты (см. mail/inline-data.ts).
 */
const UPLOAD_URL = /\/api\/uploads\/([A-Za-z0-9._-]{1,100})\/content/g;

export interface InlineUploadsResult {
  html: string;
  attachments: Attachment[];
  /** Сколько картинок не поместилось в предел письма. */
  skipped: number;
  /**
   * Сколько картинок не нашлось в хранилище — их унёс уборщик.
   *
   * Считается отдельно от `skipped`: причина другая и лечится иначе.
   * Молчать здесь нельзя — письмо ушло бы без картинки, которая у
   * человека на экране есть.
   */
  missing: number;
  /** Сколько байт заняли перенесённые картинки. */
  bytes: number;
}

/**
 * Заменяет ссылки на загрузки встроенными вложениями.
 *
 * Загрузка, которой уже нет (уборщик подчистил брошенные файлы), ссылку
 * не меняет, но попадает в счётчик `missing`. Отправка по нему
 * отказывает: письмо ушло бы без картинки, которая у человека на экране
 * есть, — а это ровно та молчаливая потеря, ради которой всё это
 * устройство и заводилось.
 */
export async function inlineUploadImages(
  html: string,
  uploads: UploadSource,
  owner: string,
  maxBytes: number,
  readFile: (path: string) => Promise<Buffer>,
): Promise<InlineUploadsResult> {
  if (!html.includes('/api/uploads/')) {
    return { html, attachments: [], skipped: 0, missing: 0, bytes: 0 };
  }

  const attachments: Attachment[] = [];
  /** Одна и та же загрузка в теле дважды — вкладываем один раз. */
  const seen = new Map<string, string>();
  const replacements: Array<{ from: string; to: string }> = [];
  let total = 0;
  let skipped = 0;
  let missing = 0;

  for (const match of html.matchAll(UPLOAD_URL)) {
    const url = match[0];
    const id = match[1] ?? '';
    const already = seen.get(id);
    if (already) {
      replacements.push({ from: url, to: `cid:${already}` });
      continue;
    }

    // Владелец — тот, от чьего имени письмо: чужая загрузка для него не
    // существует и в письмо попасть не может.
    const found = await uploads.get(id, owner).catch(() => null);
    if (!found) {
      missing += 1;
      continue;
    }
    if (!/^image\//i.test(found.meta.mimeType)) continue;
    if (total + found.meta.size > maxBytes) {
      skipped += 1;
      continue;
    }

    let content: Buffer;
    try {
      content = await readFile(found.path);
    } catch {
      continue;
    }
    if (content.length === 0) continue;
    total += content.length;

    const cid = `mtu-${String(attachments.length + 1)}.${Date.now().toString(36)}@mail.true`;
    seen.set(id, cid);
    attachments.push({
      cid,
      content,
      contentType: found.meta.mimeType,
      filename: found.meta.filename,
      contentDisposition: 'inline',
    });
    replacements.push({ from: url, to: `cid:${cid}` });

    // Картинку пустили в дело — срок жизни считается заново. Иначе она
    // умирала ровно через сутки после открытия черновика, а окно
    // написания живёт дольше: письмо уходило без неё, молча.
    await uploads.touch?.(id).catch(() => undefined);
  }

  let out = html;
  for (const { from, to } of replacements) out = out.split(from).join(to);
  return { html: out, attachments, skipped, missing, bytes: total };
}
