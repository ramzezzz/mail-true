/**
 * Проверка админской сессии и прав. Вызывается на КАЖДОМ админском запросе:
 * интерфейс не является источником истины, права решаются здесь.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { UnauthorizedError } from '../errors.js';
import { buildAuditRecord, type AuditInput, type AuditOrigin } from './audit.js';
import { assertPermission, type Permission } from './permissions.js';
import type { AdminContext, CurrentAdmin } from './types.js';

/**
 * Адрес и клиент запроса — для журнала аудита.
 *
 * Адрес берём ТОЛЬКО из `request.ip`. Раньше здесь напрямую читался заголовок
 * `X-Forwarded-For` и брался самый левый элемент — а он полностью подконтролен
 * клиенту при любом числе прокси. То есть в журнал административных действий
 * записывался любой выдуманный адрес, и журнал переставал что-либо доказывать.
 *
 * `request.ip` считает Fastify по списку доверенных прокси (`TRUSTED_PROXIES`):
 * заголовку он верит только от своего обратного прокси, а от постороннего
 * клиента — нет. Обходить эту логику своим разбором заголовка нельзя, иначе
 * настройка доверенных прокси теряет смысл.
 */
export function originOf(request: FastifyRequest): AuditOrigin {
  const ua = request.headers['user-agent'];
  return { ip: request.ip || null, userAgent: typeof ua === 'string' ? ua : null };
}

/** Читает и проверяет админскую cookie; продлевает сессию. */
export async function loadAdminSession(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<CurrentAdmin> {
  const ctx = app.adminCtx;
  const raw = request.cookies[ctx.config.ADMIN_SESSION_COOKIE_NAME];
  if (!raw) throw new UnauthorizedError('Требуется вход в админку');
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) throw new UnauthorizedError('Требуется вход в админку');

  const data = await ctx.sessions.get(unsigned.value);
  if (!data) throw new UnauthorizedError('Сессия админки истекла');

  // Роль и активность перечитываем из базы: изменение прав должно
  // действовать немедленно, а не после перелогина
  const row = await ctx.db.findAdminById(data.adminId);
  if (!row || !row.active) {
    await ctx.sessions.delete(unsigned.value);
    throw new UnauthorizedError('Учётная запись администратора отключена');
  }

  void ctx.sessions
    .touch(unsigned.value, ctx.config.ADMIN_SESSION_TTL_SECONDS)
    .catch(() => undefined);

  return { ...data, role: row.role, login: row.login, sessionId: unsigned.value };
}

/**
 * preHandler: требует админскую сессию и указанное право.
 * Без права — 403, без сессии — 401.
 */
export function requireAdmin(
  app: FastifyInstance,
  permission: Permission,
): preHandlerAsyncHookHandler {
  return async function adminGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const admin = await loadAdminSession(app, request);
    assertPermission(admin.role, permission);
    request.admin = admin;
  };
}

/** Текущий администратор или 401 (для мест, где preHandler уже отработал). */
export function currentAdmin(request: FastifyRequest): CurrentAdmin {
  if (!request.admin) throw new UnauthorizedError('Требуется вход в админку');
  return request.admin;
}

/** Пишет запись аудита от имени текущего администратора. */
export async function audit(
  ctx: AdminContext,
  request: FastifyRequest,
  input: AuditInput,
): Promise<void> {
  const admin = request.admin;
  const actor = admin ? { id: admin.adminId, login: admin.login } : { id: 0, login: 'anonymous' };
  await ctx.db.writeAudit(buildAuditRecord(actor, originOf(request), input));
}

/** Пишет аудит для действия без сессии (например, неудачный вход). */
export async function auditAnonymous(
  ctx: AdminContext,
  request: FastifyRequest,
  login: string,
  input: AuditInput,
): Promise<void> {
  await ctx.db.writeAudit(buildAuditRecord({ id: 0, login }, originOf(request), input));
}
