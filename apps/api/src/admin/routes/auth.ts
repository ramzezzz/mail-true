/**
 * Вход в админку. Отдельная точка входа и отдельная cookie: почтовые
 * учётные данные здесь не работают, админские — не работают в почте.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { newSessionId } from '../../crypto.js';
import {
  BadRequestError,
  AuthFailedError,
  NotFoundError,
  UnauthorizedError,
} from '../../errors.js';
import { audit, auditAnonymous, loadAdminSession, originOf, requireAdmin } from '../guard.js';
import { ConflictError, LockedError } from '../errors.js';
import { hashAdminPassword, verifyAdminPassword } from '../passwords.js';
import { permissionsOf, ROLE_LABELS, isAdminRole } from '../permissions.js';
import { settingsOf } from '../server-settings.js';
import { changeAdminPassword } from '../admin-password.js';
import type { AdminUserRow } from '../db.js';
import { pathId } from '../../params.js';
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

function setAdminCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  sessionId: string,
  ttlSeconds: number,
): void {
  const ctx = app.adminCtx;
  reply.setCookie(ctx.config.ADMIN_SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.cookieSecure,
    signed: true,
    path: '/',
    maxAge: ttlSeconds,
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
      const stored =
        row?.password_hash ??
        'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const passwordOk = verifyAdminPassword(password, stored);

      const origin = originOf(request);
      const ip = origin.ip ?? '';
      const settings = settingsOf(ctx);

      /*
       * Страна входа — до всего остального.
       *
       * Проверяется раньше пароля и раньше блокировок намеренно: иначе
       * запрет по стране превратился бы в проверялку паролей («страна не
       * та» приходит только при верном пароле — значит пара найдена»).
       *
       * Ответ тот же, что при неверном пароле. Настоящая причина уходит в
       * журнал аудита и в api.log, где её видит владелец сервера, а не
       * тот, кто стучится.
       *
       * Локальные адреса сюда не попадают вовсе (см. geoip/index.ts), и
       * это же спасает от самозапирания: резервный вход в панель по
       * адресу сервера из локальной сети продолжает работать при любом
       * списке стран.
       */
      const geo = ctx.geoip?.check(ip);
      if (geo && !geo.allowed) {
        await auditAnonymous(ctx, request, login, {
          action: 'admin.login.failed',
          targetType: 'admin',
          targetLabel: login,
          after: { reason: geo.reason, country: geo.country },
        });
        request.log.warn(
          { kind: 'admin.login.failed', ip: request.ip, login, country: geo.country },
          'Вход в панель отклонён по стране',
        );
        throw new AuthFailedError('Неверный логин или пароль');
      }

      /*
       * БЛОКИРУЕТСЯ АДРЕС, А НЕ УЧЁТНАЯ ЗАПИСЬ.
       *
       * Раньше пять промахов подряд запирали учётку целиком — всем, включая
       * настоящего администратора. Зная логин (а это «admin» на каждой
       * второй установке), чужой человек держал его запертым бесконечно:
       * пять неверных паролей раз в пятнадцать минут. Защита от подбора
       * работала как кнопка «выключить админу доступ».
       *
       * Теперь перебирающий запирает сам себя. Разбор — в миграции 0037.
       */
      if (ip !== '') {
        const until = await ctx.db.adminAddressLock(login, ip);
        if (until) {
          const minutes = Math.ceil((until.getTime() - Date.now()) / 60_000);
          throw new LockedError(
            `Слишком много неудачных попыток с этого адреса. Вход заблокирован ещё на ${minutes} мин.`,
          );
        }
      }

      /*
       * Блокировка самой учётной записи остаётся — она ловит подбор с
       * МНОЖЕСТВА адресов, которому поадресный счётчик не мешает. Но
       * адрес, с которого недавно входили успешно, под неё не попадает:
       * иначе распределённый подбор снова становится способом запереть
       * администратора, только подороже.
       */
      if (row && row.locked_until && row.locked_until.getTime() > Date.now()) {
        const knownDays = await settings.int('ADMIN_KNOWN_IP_DAYS');
        const friendly = ip !== '' && (await ctx.db.adminAddressKnown(row.id, ip, knownDays));
        if (!friendly) {
          const minutes = Math.ceil((row.locked_until.getTime() - Date.now()) / 60_000);
          throw new LockedError(
            `Учётная запись временно заперта: слишком много неудачных попыток с разных адресов. ` +
              `Осталось ${minutes} мин. Со своего обычного адреса вход при этом работает.`,
          );
        }
      }

      if (!row || !passwordOk || !row.active) {
        // Порог и срок блокировки — настройки «действуют сразу»:
        // администратор поднимает их в панели, когда идёт подбор пароля,
        // и ждать перезапуска в этот момент ему негде.
        const maxFailures = await settings.int('ADMIN_LOGIN_MAX_FAILURES');
        const lockMinutes = await settings.int('ADMIN_LOCKOUT_MINUTES');

        /*
         * Промах записывается по адресу ВСЕГДА — даже когда логина не
         * существует. Иначе перебор имён администраторов не ограничен
         * ничем: «нет такого» отвечается мгновенно и бесплатно.
         */
        if (ip !== '') {
          await ctx.db.markAdminAddressFailure(login, ip, maxFailures, lockMinutes);
        }

        if (row) {
          const state = await ctx.db.markAdminLoginFailure(
            row.id,
            // Порог на учётку заметно выше поадресного: он ловит подбор с
            // множества адресов, а не обычную опечатку в пароле.
            await settings.int('ADMIN_ACCOUNT_LOCK_FAILURES'),
            lockMinutes,
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
        /*
         * И строкой в api.log — для fail2ban.
         *
         * Аудит выше пишется в базу и нужен человеку: кто, когда, по какой
         * учётке. Служба защиты от подбора в базу не ходит и ходить не
         * должна, она следит за файлом. Пишем одинаково для обоих случаев
         * — и когда учётка есть, и когда логин выдуман: перебор имён
         * администраторов ничем не лучше перебора паролей.
         *
         * Пароля в строке нет, логин есть: без него в журнале не отличить
         * забывчивого администратора от перебора словаря по одному адресу.
         */
        request.log.warn(
          { kind: 'admin.login.failed', ip: request.ip, login },
          'Неудачная попытка входа в панель управления',
        );
        throw new AuthFailedError('Неверный логин или пароль');
      }

      await ctx.db.markAdminLoginSuccess(row.id, origin.ip);
      if (ip !== '') {
        // Счётчик этого адреса обнуляется: человек вспомнил пароль.
        await ctx.db.clearAdminAddressFailures(login, ip);
        // И адрес запоминается — по нему потом отличают своих от чужих,
        // когда учётная запись заперта распределённым подбором.
        await ctx.db.rememberAdminAddress(row.id, ip);
      }

      const sessionId = newSessionId();
      const ttlSeconds = await settingsOf(ctx).int('ADMIN_SESSION_TTL_SECONDS');
      await ctx.sessions.set(
        sessionId,
        {
          adminId: row.id,
          login: row.login,
          role: row.role,
          createdAt: Date.now(),
          ip: origin.ip,
        },
        ttlSeconds,
      );
      setAdminCookie(app, reply, sessionId, ttlSeconds);

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
        // Страна входа — там же, где и при отказе по стране (выше).
        // Иначе GEOIP_LOGIN_POLICY=log, обещающий «определять и писать в
        // журнал», для панели не писал ничего: страна вычислялась и
        // выбрасывалась, а вход в ПАНЕЛЬ из чужой страны — как раз то
        // событие, ради которого такой журнал заводят.
        newValue: geo?.country ? { country: geo.country } : null,
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
  app.get('/admins', { preHandler: requireAdmin(app, 'admins.manage') }, async () => {
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
  });

  /* ---------------------------------------------------------------- */
  /* Управление администраторами                                        */
  /* ---------------------------------------------------------------- */
  /*
   * ЗАЧЕМ ЭТИ ТРИ МАРШРУТА.
   *
   * Право `admins.manage` было, список на чтение был, а завести второго
   * администратора, сменить ему роль, сбросить пароль или ОТКЛЮЧИТЬ
   * учётную запись уволенного можно было только из консоли: ssh, docker
   * exec, admin/cli.ts. То есть самое срочное действие после увольнения
   * или утечки пароля требовало доступа к серверу — а он есть не у того,
   * кто первым узнаёт об увольнении.
   *
   * Мгновенность обеспечена и без нас: guard перечитывает `active` и роль
   * из базы на каждом запросе, поэтому выключенная учётная запись теряет
   * доступ сразу, не дожидаясь истечения cookie.
   */

  // Имя своё, а не loginSchema: так называется схема формы входа выше.
  const adminLoginSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/u, 'Логин: латиница, цифры, точка, дефис и подчёркивание');
  const roleSchema = z.enum(['owner', 'user_manager', 'readonly']);
  const passwordSchema = z.string().min(12).max(200);

  const createAdminSchema = z.object({
    login: adminLoginSchema,
    password: passwordSchema,
    role: roleSchema,
    displayName: z.string().trim().max(128).optional(),
  });
  const patchAdminSchema = z.object({
    role: roleSchema.optional(),
    active: z.boolean().optional(),
  });
  const adminPasswordSchema = z.object({ password: passwordSchema });

  const adminDto = (r: AdminUserRow): Record<string, unknown> => ({
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
  });

  /**
   * Сколько ДЕЙСТВУЮЩИХ владельцев останется, если применить правку.
   *
   * Владелец — единственная роль, которая управляет владельцами. Оставить
   * сервер без единого действующего владельца значит запереть панель:
   * вернуть доступ можно будет только из консоли, а ровно от неё эти
   * маршруты и избавляют.
   */
  async function ownersAfter(change: {
    id: number;
    role?: string | undefined;
    active?: boolean | undefined;
  }): Promise<number> {
    const rows = await ctx.db.listAdmins();
    return rows.filter((r) => {
      const role = r.id === change.id ? (change.role ?? r.role) : r.role;
      const active = r.id === change.id ? (change.active ?? r.active) : r.active;
      return role === 'owner' && active;
    }).length;
  }

  app.post('/admins', { preHandler: requireAdmin(app, 'admins.manage') }, async (request) => {
    const body = createAdminSchema.parse(request.body);
    const exists = await ctx.db.findAdminByLogin(body.login);
    if (exists) throw new ConflictError(`Администратор «${body.login}» уже есть`);

    const created = await ctx.db.createAdmin(
      body.login,
      hashAdminPassword(body.password),
      body.role,
      body.displayName?.trim() ? body.displayName.trim() : null,
    );
    await audit(ctx, request, {
      action: 'admins.create',
      targetType: 'admin',
      targetId: created.id,
      targetLabel: created.login,
      after: { login: created.login, role: created.role, active: created.active },
    });
    return adminDto(created);
  });

  app.patch<{ Params: { id: string } }>(
    '/admins/:id',
    { preHandler: requireAdmin(app, 'admins.manage') },
    async (request) => {
      const id = pathId(request.params.id, 'администратора');
      const body = patchAdminSchema.parse(request.body);
      const rows = await ctx.db.listAdmins();
      const row = rows.find((r) => r.id === id);
      if (!row) throw new NotFoundError('Администратор не найден');

      const me = await loadAdminSession(app, request);
      /*
       * Себя нельзя ни выключить, ни понизить — и это не забота о
       * начальстве, а защита от запертой панели: снявший с себя права
       * потеряет доступ на следующем же запросе (guard читает роль из
       * базы каждый раз), а вернуть их будет некому.
       */
      if (me && me.adminId === id) {
        if (body.active === false) throw new BadRequestError('Себя выключить нельзя');
        if (body.role !== undefined && body.role !== row.role) {
          throw new BadRequestError('Свою роль сменить нельзя — попросите другого владельца');
        }
      }
      if ((await ownersAfter({ id, role: body.role, active: body.active })) === 0) {
        throw new BadRequestError(
          'Это последний действующий владелец. Сначала назначьте другого: иначе панель ' +
            'останется без управления, и вернуть доступ можно будет только из консоли.',
        );
      }

      const updated = await ctx.db.updateAdmin(id, {
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      });
      if (!updated) throw new NotFoundError('Администратор не найден');

      /*
       * Выключенного выкидываем немедленно. Guard и так проверяет `active`
       * на каждом запросе, но закрыть сессию честнее: в списке сессий её
       * после этого нет, и рассуждать «а вдруг где-то кэш» не приходится.
       */
      let closedSessions: number | null = null;
      if (body.active === false) {
        closedSessions = await ctx.sessions.revokeByAdminId(id).catch(() => null);
      }

      await audit(ctx, request, {
        action: 'admins.update',
        targetType: 'admin',
        targetId: id,
        targetLabel: row.login,
        before: { role: row.role, active: row.active },
        after: { role: updated.role, active: updated.active, closed_sessions: closedSessions },
      });
      return adminDto(updated);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admins/:id/password',
    { preHandler: requireAdmin(app, 'admins.manage') },
    async (request) => {
      const id = pathId(request.params.id, 'администратора');
      const { password } = adminPasswordSchema.parse(request.body);
      const rows = await ctx.db.listAdmins();
      const row = rows.find((r) => r.id === id);
      if (!row) throw new NotFoundError('Администратор не найден');

      /*
       * Пароль меняется тем же путём, что и из консоли: та же функция,
       * тот же сброс счётчика неудач и та же немедленная отмена всех
       * сессий этой учётной записи. Иначе панель и консоль делали бы вид,
       * что делают одно и то же, а панель оставляла бы действующей
       * украденную сессию.
       */
      const result = await changeAdminPassword(
        { db: ctx.db, sessions: ctx.sessions },
        row.login,
        password,
      );
      if (!result) throw new NotFoundError('Администратор не найден');

      await audit(ctx, request, {
        action: 'admins.password',
        targetType: 'admin',
        targetId: id,
        targetLabel: row.login,
        after: {
          closed_sessions: result.closedSessions,
          sessions_problem: result.sessionsProblem,
        },
      });
      return {
        ok: true,
        closedSessions: result.closedSessions,
        sessionsProblem: result.sessionsProblem,
      };
    },
  );
}
