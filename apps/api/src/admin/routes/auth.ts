/**
 * Вход в админку. Отдельная точка входа и отдельная cookie: почтовые
 * учётные данные здесь не работают, админские — не работают в почте.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { newSessionId } from '../../crypto.js';
import { AuthFailedError, UnauthorizedError } from '../../errors.js';
import { auditAnonymous, loadAdminSession, originOf, requireAdmin } from '../guard.js';
import { LockedError } from '../errors.js';
import { verifyAdminPassword } from '../passwords.js';
import { permissionsOf, ROLE_LABELS, isAdminRole } from '../permissions.js';
import { closeMailboxSession, MAILBOX_COOKIE } from './mailbox.js';

const loginSchema = z.object({
  login: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

/**
 * Тема оформления панели.
 *
 * Проверяется ФОРМА значения, а не принадлежность к списку тем: названия
 * тем — понятие интерфейса (apps/admin/src/appearance/adminThemes.ts), и
 * список на сервере означал бы правку сервера на каждую новую расцветку.
 * Незнакомое имя панель молча заменяет темой по умолчанию, так что худшее,
 * что может записать сюда чужой запрос, — бесполезная строка в своей же
 * учётной записи. null — «вернуть тему по умолчанию».
 */
const themeSchema = z.object({
  theme: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/u, 'Недопустимое имя темы')
    .nullable(),
});

function setAdminCookie(app: FastifyInstance, reply: FastifyReply, sessionId: string): void {
  const ctx = app.adminCtx;
  reply.setCookie(ctx.config.ADMIN_SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.cookieSecure,
    signed: true,
    path: '/',
    maxAge: ctx.config.ADMIN_SESSION_TTL_SECONDS,
  });
}

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  // Вход. Частота ограничена жёстче общего лимита; сверх того —
  // счётчик неудач в базе и временная блокировка учётной записи.
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { login, password } = loginSchema.parse(request.body);
      const row = await ctx.db.findAdminByLogin(login);

      // Пароль сверяем даже для несуществующего логина — чтобы по времени
      // ответа нельзя было перебрать имена администраторов
      const stored = row?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const passwordOk = verifyAdminPassword(password, stored);

      if (row && row.locked_until && row.locked_until.getTime() > Date.now()) {
        const minutes = Math.ceil((row.locked_until.getTime() - Date.now()) / 60_000);
        throw new LockedError(
          `Слишком много неудачных попыток. Вход заблокирован ещё на ${minutes} мин.`,
        );
      }

      if (!row || !passwordOk || !row.active) {
        if (row) {
          const state = await ctx.db.markAdminLoginFailure(
            row.id,
            ctx.config.ADMIN_LOGIN_MAX_FAILURES,
            ctx.config.ADMIN_LOCKOUT_MINUTES,
          );
          await auditAnonymous(ctx, request, login, {
            action: 'admin.login.failed',
            targetType: 'admin',
            targetId: row.id,
            targetLabel: login,
            after: { failed_attempts: state?.failed_attempts ?? null },
          });
        } else {
          await auditAnonymous(ctx, request, login, {
            action: 'admin.login.failed',
            targetType: 'admin',
            targetLabel: login,
            after: { reason: 'нет такого администратора' },
          });
        }
        throw new AuthFailedError('Неверный логин или пароль');
      }

      const origin = originOf(request);
      await ctx.db.markAdminLoginSuccess(row.id, origin.ip);

      const sessionId = newSessionId();
      await ctx.sessions.set(
        sessionId,
        {
          adminId: row.id,
          login: row.login,
          role: row.role,
          createdAt: Date.now(),
          ip: origin.ip,
        },
        ctx.config.ADMIN_SESSION_TTL_SECONDS,
      );
      setAdminCookie(app, reply, sessionId);

      await ctx.db.writeAudit({
        adminId: row.id,
        adminLogin: row.login,
        action: 'admin.login',
        targetType: 'admin',
        targetId: row.id,
        targetLabel: row.login,
        ip: origin.ip,
        userAgent: origin.userAgent,
        oldValue: null,
        newValue: null,
      });

      return {
        ok: true,
        login: row.login,
        displayName: row.display_name,
        role: row.role,
        roleLabel: isAdminRole(row.role) ? ROLE_LABELS[row.role] : row.role,
        permissions: permissionsOf(row.role),
      };
    },
  );

  // Выход
  app.post('/auth/logout', async (request, reply) => {
    const raw = request.cookies[ctx.config.ADMIN_SESSION_COOKIE_NAME];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const data = await ctx.sessions.get(unsigned.value);
        await ctx.sessions.delete(unsigned.value);
        if (data) {
          // Выход из админки закрывает и сеанс входа в чужой ящик: иначе
          // запись остаётся открытой навсегда, и в журнале, который читает
          // владелец ящика, администратор «сидит» там до скончания века.
          const closed = await closeMailboxSession(ctx, request, 'logout');
          await ctx.db.closeOpenMailboxAccess(data.adminId, 'logout');
          reply.clearCookie(MAILBOX_COOKIE, { path: '/' });
          const origin = originOf(request);
          if (closed) {
            await ctx.db.writeAudit({
              adminId: data.adminId,
              adminLogin: data.login,
              action: 'mailbox.impersonate.end',
              targetType: 'mailbox',
              targetId: null,
              targetLabel: closed.mailboxEmail,
              ip: origin.ip,
              userAgent: origin.userAgent,
              oldValue: null,
              newValue: { access_id: closed.accessId, end_reason: 'logout' },
            });
          }
          await ctx.db.writeAudit({
            adminId: data.adminId,
            adminLogin: data.login,
            action: 'admin.logout',
            targetType: 'admin',
            targetId: data.adminId,
            targetLabel: data.login,
            ip: origin.ip,
            userAgent: origin.userAgent,
            oldValue: null,
            newValue: null,
          });
        }
      }
    }
    reply.clearCookie(ctx.config.ADMIN_SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // Текущая сессия: интерфейс спрашивает при загрузке
  app.get('/auth/session', async (request) => {
    const admin = await loadAdminSession(app, request);
    if (!admin) throw new UnauthorizedError();
    const row = await ctx.db.findAdminById(admin.adminId);
    return {
      authenticated: true,
      login: admin.login,
      displayName: row?.display_name ?? null,
      role: admin.role,
      roleLabel: isAdminRole(admin.role) ? ROLE_LABELS[admin.role] : admin.role,
      permissions: permissionsOf(admin.role),
      masterAccess: ctx.mailbox.configured,
      // Оформление панели у ЭТОГО администратора. Приезжает вместе с
      // сессией, а не отдельным запросом: панель применяет тему сразу,
      // как только узнала, кто вошёл, — лишний рейс сюда означал бы
      // лишнюю вспышку чужой темы на экране.
      theme: await ctx.db.getAdminTheme(admin.adminId),
    };
  });

  /*
   * Смена темы. Пишется в ту учётную запись, под которой вошли: id берётся
   * из сессии, а не из тела запроса, — сменить оформление соседу нельзя.
   *
   * В журнал аудита НЕ пишется намеренно: там перечислены изменения, за
   * которые администратор отвечает перед другими (ящики, домены, права),
   * а цвет интерфейса не меняет ничего ни для кого, кроме автора. Заносить
   * его в журнал значит топить настоящие события в шуме.
   */
  app.put('/auth/theme', async (request) => {
    const admin = await loadAdminSession(app, request);
    if (!admin) throw new UnauthorizedError();
    const { theme } = themeSchema.parse(request.body);
    await ctx.db.setAdminTheme(admin.adminId, theme);
    return { ok: true, theme };
  });

  // Список администраторов — только для роли с правом admins.manage
  app.get(
    '/admins',
    { preHandler: requireAdmin(app, 'admins.manage') },
    async () => {
      const rows = await ctx.db.listAdmins();
      return {
        items: rows.map((r) => ({
          id: r.id,
          login: r.login,
          displayName: r.display_name,
          role: r.role,
          roleLabel: isAdminRole(r.role) ? ROLE_LABELS[r.role] : r.role,
          active: r.active,
          lastLoginAt: r.last_login_at?.toISOString() ?? null,
          lastLoginIp: r.last_login_ip,
          lockedUntil: r.locked_until?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
        })),
      };
    },
  );
}
