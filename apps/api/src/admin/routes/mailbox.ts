/**
 * Вход администратора в ящик пользователя.
 *
 * Условия из docs/admin-spec.md выполняются здесь:
 *  - причина обязательна и указывается ДО входа (без неё маршрут вернёт 400);
 *  - каждый вход — строка в admin_mailbox_access и запись в журнале аудита;
 *  - сеанс помечен административным (флаг adminSession в ответах,
 *    отдельная cookie mt_admin_mailbox, отдельный срок жизни);
 *  - отправка писем невозможна: в этом наборе маршрутов её просто нет,
 *    а служебное соединение Dovecot не даёт доступа к submission.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { newSessionId } from '../../crypto.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors.js';
import { AdminUnavailableError, ForbiddenError } from '../errors.js';
import { audit, currentAdmin, originOf, requireAdmin } from '../guard.js';
import { settingsOf } from '../server-settings.js';
import { hasPermission } from '../permissions.js';
import type { MailboxSessionData } from '../session.js';
import type { AdminContext } from '../types.js';

export const MAILBOX_COOKIE = 'mt_admin_mailbox';

const startSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  /** Причина входа — обязательна, минимум 5 значащих символов. */
  reason: z.string().trim().min(5).max(2000),
});

const listSchema = z.object({
  path: z.string().min(1).max(255).default('INBOX'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

const readSchema = z.object({
  path: z.string().min(1).max(255).default('INBOX'),
  uid: z.coerce.number().int().positive(),
});

/**
 * Закрывает открытый сеанс входа в чужой ящик, если он есть.
 *
 * Отметка о завершении раньше ставилась ТОЛЬКО явным выходом через
 * /mailbox/leave. Всё остальное — истёкший срок, закрытая вкладка, выход
 * из админки, вход в другой ящик — оставляло запись открытой навсегда,
 * и в журнале, который читает владелец ящика, вход выглядел бесконечным.
 *
 * Возвращает адрес ящика, чей сеанс закрыт, — чтобы вызывающий мог
 * записать это в журнал аудита.
 */
export async function closeMailboxSession(
  ctx: AdminContext,
  request: FastifyRequest,
  reason: 'leave' | 'logout' | 'replaced',
): Promise<{ mailboxEmail: string; accessId: number } | null> {
  const raw = request.cookies[MAILBOX_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  const data = await ctx.sessions.getMailbox(unsigned.value);
  await ctx.sessions.deleteMailbox(unsigned.value);
  if (!data) return null;
  await ctx.db.endMailboxAccess(data.accessId, reason);
  return { mailboxEmail: data.mailboxEmail, accessId: data.accessId };
}

export async function adminMailboxRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  const closeCurrentMailboxSession = (
    request: FastifyRequest,
    reason: 'leave' | 'logout' | 'replaced',
  ): Promise<{ mailboxEmail: string; accessId: number } | null> =>
    closeMailboxSession(ctx, request, reason);

  function setMailboxCookie(reply: FastifyReply, id: string, ttlSeconds: number): void {
    reply.setCookie(MAILBOX_COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.cookieSecure,
      signed: true,
      path: '/',
      maxAge: ttlSeconds,
    });
  }

  /** Достаёт активный сеанс входа в ящик; попутно требует права админа. */
  async function requireMailboxSession(
    request: Parameters<typeof originOf>[0],
  ): Promise<{ id: string; data: MailboxSessionData }> {
    const admin = currentAdmin(request);
    if (!hasPermission(admin.role, 'mailbox.impersonate')) {
      throw new ForbiddenError('Роль не позволяет входить в чужие ящики');
    }
    const raw = request.cookies[MAILBOX_COOKIE];
    if (!raw) throw new UnauthorizedError('Сеанс входа в ящик не открыт');
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      throw new UnauthorizedError('Сеанс входа в ящик не открыт');
    }
    const data = await ctx.sessions.getMailbox(unsigned.value);
    if (!data) throw new UnauthorizedError('Сеанс входа в ящик истёк');
    if (data.adminId !== admin.adminId) {
      throw new ForbiddenError('Этот сеанс открыт другим администратором');
    }
    return { id: unsigned.value, data };
  }

  /* --- начало сеанса ------------------------------------------------ */
  app.post(
    '/mailbox/enter',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request, reply) => {
      const body = startSchema.parse(request.body);
      if (body.reason.replace(/\s+/g, '').length < 5) {
        throw new BadRequestError('Причина входа слишком короткая — опишите её словами');
      }
      if (!ctx.mailbox.configured) {
        throw new AdminUnavailableError(
          'Служебный доступ Dovecot не настроен: задайте DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD ' +
            'и включите master-passdb в infra/dovecot/conf/dovecot.conf.template',
        );
      }
      const admin = currentAdmin(request);
      const user = await ctx.db.findMailUserByEmail(body.email);
      if (!user) throw new NotFoundError('Такого ящика нет');

      // Сначала убеждаемся, что служебный вход действительно работает,
      // и только потом заводим сеанс — иначе в журнале появится вход,
      // которого не было
      await ctx.mailbox.verify(user.email);

      // Срок сеанса читается из настроек сервера на каждый вход: он
      // объявлен «действует сразу», и сокращение срока обязано касаться
      // ближайшего входа, а не следующего перезапуска контейнера.
      const ttlSeconds = await settingsOf(ctx).int('ADMIN_MAILBOX_TTL_SECONDS');

      // Вход в другой ящик поверх текущего закрывает предыдущую запись.
      // Раньше она оставалась открытой навсегда, и по журналу выходило,
      // что администратор сидит сразу в двух чужих ящиках.
      await closeCurrentMailboxSession(request, 'replaced');
      await ctx.db.closeOpenMailboxAccess(admin.adminId, 'replaced');

      const accessId = await ctx.db.recordMailboxAccess({
        adminId: admin.adminId,
        adminLogin: admin.login,
        mailboxEmail: user.email,
        reason: body.reason,
        ...originOf(request),
        // Срок сеанса пишется в запись: по нему уборщик закроет её, если
        // администратор просто ушёл, не нажав «выйти».
        ttlSeconds,
      });

      const sessionId = newSessionId();
      await ctx.sessions.setMailbox(
        sessionId,
        {
          adminId: admin.adminId,
          adminLogin: admin.login,
          mailboxEmail: user.email,
          reason: body.reason,
          accessId,
          createdAt: Date.now(),
          readOnly: true,
        },
        ttlSeconds,
      );
      setMailboxCookie(reply, sessionId, ttlSeconds);

      await audit(ctx, request, {
        action: 'mailbox.impersonate',
        targetType: 'mailbox',
        targetId: user.id,
        targetLabel: user.email,
        after: { reason: body.reason, access_id: accessId },
      });

      return {
        ok: true,
        mailboxEmail: user.email,
        displayName: user.display_name,
        reason: body.reason,
        accessId,
        /** Плашка в интерфейсе: «вы вошли как администратор в ящик …». */
        adminSession: true,
        readOnly: true,
        canSend: false,
        expiresInSeconds: ttlSeconds,
      };
    },
  );

  /* --- текущий сеанс ------------------------------------------------ */
  app.get(
    '/mailbox/session',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request) => {
      const { data } = await requireMailboxSession(request);
      return {
        active: true,
        mailboxEmail: data.mailboxEmail,
        reason: data.reason,
        adminSession: true,
        readOnly: true,
        canSend: false,
        startedAt: new Date(data.createdAt).toISOString(),
      };
    },
  );

  /* --- папки -------------------------------------------------------- */
  app.get(
    '/mailbox/folders',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request) => {
      const { data } = await requireMailboxSession(request);
      const folders = await ctx.mailbox.listFolders(data.mailboxEmail);
      return { mailboxEmail: data.mailboxEmail, adminSession: true, folders };
    },
  );

  /* --- список писем ------------------------------------------------- */
  app.get(
    '/mailbox/messages',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request) => {
      const { data } = await requireMailboxSession(request);
      const q = listSchema.parse(request.query);
      const page = await ctx.mailbox.listMessages(data.mailboxEmail, q.path, q.limit, q.offset);
      return {
        mailboxEmail: data.mailboxEmail,
        adminSession: true,
        readOnly: true,
        path: q.path,
        ...page,
        limit: q.limit,
        offset: q.offset,
      };
    },
  );

  /* --- одно письмо -------------------------------------------------- */
  app.get(
    '/mailbox/message',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request) => {
      const { data } = await requireMailboxSession(request);
      const q = readSchema.parse(request.query);
      const message = await ctx.mailbox.readMessage(data.mailboxEmail, q.path, q.uid);
      if (!message) throw new NotFoundError('Письмо не найдено');
      return { mailboxEmail: data.mailboxEmail, adminSession: true, readOnly: true, message };
    },
  );

  /* --- явный запрет отправки ---------------------------------------- */
  // Маршрут существует только чтобы дать понятный ответ вместо 404,
  // если интерфейс всё же попробует отправить письмо в этом режиме.
  app.post(
    '/mailbox/send',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request) => {
      await requireMailboxSession(request);
      throw new ForbiddenError(
        'В режиме административного входа отправка писем от имени пользователя запрещена',
      );
    },
  );

  /* --- завершение сеанса -------------------------------------------- */
  app.post(
    '/mailbox/leave',
    { preHandler: requireAdmin(app, 'mailbox.impersonate') },
    async (request, reply) => {
      const closed = await closeCurrentMailboxSession(request, 'leave');
      if (closed) {
        await audit(ctx, request, {
          action: 'mailbox.impersonate.end',
          targetType: 'mailbox',
          targetLabel: closed.mailboxEmail,
          after: { access_id: closed.accessId, end_reason: 'leave' },
        });
      }
      reply.clearCookie(MAILBOX_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
}
