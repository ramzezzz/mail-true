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

/*
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПОИСК ИДЁТ ПО ИМЕНИ АТРИБУТА, А НЕ ОТ ТЕГА `<img`
 * ------------------------------------------------------------------
 * Здесь стояло `/(<img\b[^>]*?\bsrc=)…/g`. Ленивое `[^>]*?` заставляет
 * разбор просматривать остаток тела ЗАНОВО для каждого вхождения
 * «<img», у которого дальше не нашлось закрывающей скобки. Стоимость —
 * квадрат от длины письма, и считается это синхронно, в единственном
 * потоке сервера.
 *
 * Замерено на самой функции: тело 100 КБ — 167 мс, 200 КБ — 663 мс,
 * 400 КБ — 2663 мс. Учетверение времени на каждое удвоение размера; при
 * разрешённых десяти мегабайтах это часы. Любой вошедший человек (или
 * угнанная сессия) одним сохранением черновика останавливал ВЕСЬ
 * сервер: ни почты, ни входа, ни панели — а автосохранение повторяло бы
 * запрос каждые три секунды.
 *
 * Поиск от имени атрибута такого поведения не даёт: разбор цепляется за
 * литерал (`src=`, `background=`, `url(`) и от каждой находки идёт
 * вперёд, не возвращаясь.
 *
 * Заодно закрылись две дыры: `background=` и `url(data:…)` в стилях
 * раньше не переносились вовсе и уезжали получателю как есть — то есть
 * ровно в том виде, ради исправления которого этот модуль и написан.
 *
 * Проверка перед именем атрибута — чтобы не поймать `data-src=`: такую
 * ссылку санитайзер всё равно снимает, и вложение уехало бы получателю
 * без единой ссылки на него, заняв место в пределе письма.
 */
const DATA_URL_ATTR =
  /(?<![\w-])(?:src|background)\s*=\s*(["'])(data:image\/[^"';\s]+;base64,[^"'\s]*)\1/gi;

/** `background-image: url(data:image/png;base64,…)` внутри стиля. */
const DATA_URL_CSS = /url\(\s*(["']?)(data:image\/[^"';\s)]+;base64,[^"'\s)]*)\1\s*\)/gi;

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

  const found: string[] = [];
  for (const match of html.matchAll(DATA_URL_ATTR)) found.push(match[2] ?? '');
  for (const match of html.matchAll(DATA_URL_CSS)) found.push(match[2] ?? '');

  for (const url of found) {
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
