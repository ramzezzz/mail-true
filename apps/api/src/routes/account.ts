/**
 * GET /api/account — профиль и квота текущего пользователя.
 */
import type { FastifyInstance } from 'fastify';
import type { Account } from '@mail-true/shared';
import { UnauthorizedError } from '../errors.js';
import { AccountDirectory } from '../accounts/directory.js';
import { loadSettingsConfig } from '../settings/config.js';

/** Отображаемое имя из локальной части адреса: ivan.petrov -> Ivan Petrov. */
function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface AccountRoutesOptions {
  /** Подмена справочника для тестов. */
  directory?: AccountDirectory;
}

export async function accountRoutes(
  app: FastifyInstance,
  options: AccountRoutesOptions = {}
): Promise<void> {
  const { pool, logger } = app.deps;

  // Дата создания ящика живёт только в базе почтового стека; без базы
  // поле честно приходит пустым (см. accounts/directory.ts)
  const directory =
    options.directory ??
    new AccountDirectory({ connectionString: loadSettingsConfig().databaseUrl, logger });
  app.addHook('onClose', async () => {
    await directory.close();
  });

  app.get('/account', { preHandler: app.requireSession }, async (request) => {
    const session = request.mailSession;
    if (!session) throw new UnauthorizedError();

    // Квота из IMAP QUOTA (Dovecot поддерживает при включённом плагине quota)
    const quota = await pool.withClient(session.email, session.password, async (client) => {
      try {
        return await client.getQuota('INBOX');
      } catch {
        return false as const;
      }
    });

    const storage = quota && quota.storage ? quota.storage : null;
    // ImapFlow кладёт занятое место в поле usage, хотя в его типах и примере
    // из JSDoc написано used. Из-за этого квота всегда приходила нулевой.
    const usedBytes =
      (storage as { usage?: number; used?: number } | null)?.usage ??
      storage?.used ??
      0;

    const account: Account = {
      id: session.email,
      email: session.email,
      displayName: displayNameFromEmail(session.email),
      avatarUrl: null,
      quotaUsedBytes: usedBytes,
      quotaLimitBytes: storage?.limit ?? 0,
      signature: '',
      // Раньше здесь стояло `new Date(0)`, то есть в профиле у всех была
      // дата «01.01.1970». Настоящая дата заведения ящика есть только
      // в базе; если её не видно — поле пустое, а не выдуманное.
      createdAt: await directory.createdAt(session.email),
    };
    return account;
  });
}
