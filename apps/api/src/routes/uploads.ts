/**
 * POST /api/uploads — загрузка вложений во временное хранилище (multipart).
 */
import type { FastifyInstance } from 'fastify';
import { UnauthorizedError, BadRequestError } from '../errors.js';
import type { UploadMeta } from '../uploads.js';

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const { uploads } = app.deps;

  app.post('/uploads', { preHandler: app.requireSession }, async (request) => {
    if (!request.mailSession) throw new UnauthorizedError();
    if (!request.isMultipart()) {
      throw new BadRequestError('Ожидается multipart/form-data');
    }

    const saved: Array<Pick<UploadMeta, 'id' | 'filename' | 'mimeType' | 'size'>> = [];
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
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
      throw err;
    }

    if (saved.length === 0) throw new BadRequestError('Файлы не переданы');
    return { files: saved };
  });
}
