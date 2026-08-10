/**
 * POST /api/uploads — загрузка вложений во временное хранилище (multipart).
 */
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError, BadRequestError, FileTooLargeError, NotFoundError } from '../errors.js';
import { decidePartDelivery } from '../mail/part-delivery.js';
import { UploadQuotaError } from '../uploads.js';
import type { UploadMeta } from '../uploads.js';

/**
 * Предел словами: «17,8 МБ» — человеку нужен порядок, а не 18724571.
 *
 * Округление ВНИЗ, а не по правилам: настоящий предел 17,856 МБ, и
 * округлённое «17,9 МБ» — обещание, которого мы не сдержим. Человек ужал бы
 * файл ровно до названного размера и получил тот же отказ второй раз.
 */
function megabytes(bytes: number): string {
  const tenths = Math.floor((bytes / 1024 / 1024) * 10) / 10;
  return `${tenths.toFixed(1).replace('.', ',')} МБ`;
}

/** Ошибка от предела размера — своя у Fastify и своя у хранилища. */
function isTooLarge(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FILE_TOO_LARGE';
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const { uploads, config } = app.deps;

  /**
   * Отдать содержимое загрузки её владельцу.
   *
   * ------------------------------------------------------------------
   * ЗАЧЕМ ЭТОТ МАРШРУТ
   * ------------------------------------------------------------------
   * Ради встроенных картинок ЧЕРНОВИКА. У них нет постоянного адреса:
   * ссылка на часть письма умирает при первом же пересохранении (номер
   * черновика меняется, прежний удаляется), а вшивать байты прямо в тело
   * значит возить их на сервер при каждом автосохранении — черновик с
   * фотографией на четыре мегабайта гнал бы пять с половиной вверх
   * каждые три секунды набора, и сервер каждый раз пересобирал бы письмо
   * целиком.
   *
   * Номер загрузки постоянен и переживает любое число сохранений. Само
   * хранилище уже есть и уже используется для вложений черновика
   * (routes/compose.ts, draftAttachments) — не хватало только способа
   * ПОКАЗАТЬ загруженное.
   *
   * Отдаём по тем же правилам, что и часть письма: тип из белого списка
   * или поток байтов, запрет угадывания типа и строгая политика
   * содержимого. Загрузка — это файл, который принёс сам человек, но
   * принести он мог что угодно.
   */
  app.get<{ Params: { id: string } }>(
    '/uploads/:id/content',
    { preHandler: app.requireSession },
    async (request, reply) => {
      const session = request.mailSession;
      if (!session) throw new UnauthorizedError();
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);

      // Владелец — из сессии. Чужая загрузка для нас не существует, и
      // отвечаем мы так же, как на несуществующую: сказать «эта не ваша»
      // значило бы подтвердить, что она есть.
      const found = await uploads.get(id, session.email);
      if (!found) throw new NotFoundError('Загрузка не найдена');

      const { contentType, inline } = decidePartDelivery(found.meta.mimeType);
      reply.header('content-type', contentType);
      reply.header('x-content-type-options', 'nosniff');
      reply.header(
        'content-security-policy',
        "default-src 'none'; sandbox; frame-ancestors 'none'",
      );
      reply.header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.meta.filename)}`,
      );
      // Загрузка неизменна: её содержимое привязано к номеру, и новый
      // файл получает новый номер.
      reply.header('cache-control', 'private, max-age=3600, immutable');
      return reply.send(await readFile(found.path));
    },
  );

  app.post('/uploads', { preHandler: app.requireSession }, async (request) => {
    if (!request.mailSession) throw new UnauthorizedError();
    if (!request.isMultipart()) {
      throw new BadRequestError('Ожидается multipart/form-data');
    }

    const owner = request.mailSession.email;
    /*
     * Сколько ящик уже занял до этого запроса. Считается один раз: файлы
     * этого же запроса прибавляются по мере сохранения, и пересчитывать
     * каталог на каждое вложение незачем.
     */
    let used = await uploads.usedBy(owner);

    const saved: Array<Pick<UploadMeta, 'id' | 'filename' | 'mimeType' | 'size'>> = [];
    // Имя файла, на котором сорвалось, — иначе при пяти вложениях сразу
    // непонятно, какое именно ужимать.
    let current = '';
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        current = part.filename;
        const meta = await uploads.save(owner, part.filename, part.mimetype, part.file);
        used += meta.size;
        if (used > config.UPLOAD_MAILBOX_MAX_BYTES) {
          /*
           * Файл уже на диске — иначе размер и не узнать: он приходит
           * потоком. Убирает его общий разбор ошибок ниже, вместе с
           * остальными файлами этого запроса.
           */
          await uploads.delete(meta.id);
          throw new UploadQuotaError(
            `Незавершённых вложений слишком много: предел на ящик — ${megabytes(config.UPLOAD_MAILBOX_MAX_BYTES)}.` +
              ' Отправьте или удалите начатые письма и повторите.',
          );
        }
        saved.push({
          id: meta.id,
          filename: meta.filename,
          mimeType: meta.mimeType,
          size: meta.size,
        });
      }
    } catch (err) {
      // Запрос отклонён целиком — значит, и на диске от него ничего не
      // остаётся. Клиент про уже сохранённые файлы всё равно не узнает:
      // идентификаторы уходят только в успешном ответе.
      await Promise.all(saved.map((file) => uploads.delete(file.id)));
      // «Файл слишком большой» не отвечает на единственный вопрос, который
      // человек в этот момент задаёт: до какого размера ужимать. Предел
      // называем прямо, вместе с именем файла, на котором сорвалось.
      // Про предел на ящик сказано своими словами — общий текст про
      // «предел одного вложения» тут только сбивал бы с толку.
      if (err instanceof UploadQuotaError) throw err;
      if (isTooLarge(err)) {
        const what = current ? `Файл «${current}»` : 'Файл';
        throw new FileTooLargeError(
          `${what} не помещается: предел одного вложения — ${megabytes(config.ATTACHMENT_MAX_BYTES)}` +
            ` (письмо целиком — не больше ${megabytes(config.MESSAGE_MAX_BYTES)}).`,
        );
      }
      throw err;
    }

    if (saved.length === 0) throw new BadRequestError('Файлы не переданы');
    return { files: saved };
  });
}
