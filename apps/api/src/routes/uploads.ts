/**
 * POST /api/uploads — загрузка вложений во временное хранилище (multipart).
 */
import type { FastifyInstance } from 'fastify';
import { UnauthorizedError, BadRequestError, FileTooLargeError } from '../errors.js';
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

  app.post('/uploads', { preHandler: app.requireSession }, async (request) => {
    if (!request.mailSession) throw new UnauthorizedError();
    if (!request.isMultipart()) {
      throw new BadRequestError('Ожидается multipart/form-data');
    }

    const saved: Array<Pick<UploadMeta, 'id' | 'filename' | 'mimeType' | 'size'>> = [];
    // Имя файла, на котором сорвалось, — иначе при пяти вложениях сразу
    // непонятно, какое именно ужимать.
    let current = '';
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        current = part.filename;
        const meta = await uploads.save(part.filename, part.mimetype, part.file);
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
