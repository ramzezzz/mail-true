/**
 * GET /api/folders — список папок с ролями и счётчиками.
 */
import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../errors.js';
import { listFolders } from '../imap/service.js';

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  app.get('/folders', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();
    const folders = await pool.withClient(session.email, session.password, (client) =>
      listFolders(client),
    );
    return { folders };
  });
}
