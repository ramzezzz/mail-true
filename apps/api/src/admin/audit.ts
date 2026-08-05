/**
 * Журнал аудита: формирование и запись.
 *
 * Правила:
 *  - пишется КАЖДОЕ изменяющее действие (создание, изменение, удаление,
 *    вход в чужой ящик), даже если оно ничего фактически не изменило;
 *  - в old_value/new_value попадают только изменившиеся поля — читать
 *    журнал должно быть легко;
 *  - секреты (пароли, хэши, ключи) заменяются маркером '***' и никогда
 *    не попадают в базу в открытом виде;
 *  - записи не удаляются и не правятся — API на это ничего не предоставляет.
 */

/** Имена полей, значения которых нельзя писать в журнал. */
const SECRET_KEYS = [
  'password',
  'password_hash',
  'passwordhash',
  'passwd',
  'secret',
  'totp_secret',
  'token',
  'apikey',
  'api_key',
  'dkim_private_key',
];

/** Маркер, который подставляется вместо секрета. */
export const REDACTED = '***';

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SECRET_KEYS.some((s) => normalized === s || normalized.includes(s));
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Рекурсивно заменяет значения секретных полей маркером '***'. */
export function redactSecrets(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactSecrets(item);
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(redactSecrets(a)) === JSON.stringify(redactSecrets(b));
}

export interface ValueDiff {
  old: Record<string, JsonValue> | null;
  new: Record<string, JsonValue> | null;
}

/**
 * Оставляет только изменившиеся поля.
 * Поля, которых нет в `after`, не считаются изменёнными (частичное обновление).
 */
export function diffValues(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): ValueDiff {
  if (!before && !after) return { old: null, new: null };
  if (!before) return { old: null, new: redactSecrets(after) as Record<string, JsonValue> };
  if (!after) return { old: redactSecrets(before) as Record<string, JsonValue>, new: null };

  const oldOut: Record<string, JsonValue> = {};
  const newOut: Record<string, JsonValue> = {};
  for (const [key, next] of Object.entries(after)) {
    const prev = before[key];
    if (sameValue(prev, next)) continue;
    oldOut[key] = isSecretKey(key) ? REDACTED : redactSecrets(prev);
    newOut[key] = isSecretKey(key) ? REDACTED : redactSecrets(next);
  }
  const changed = Object.keys(newOut).length > 0;
  return changed ? { old: oldOut, new: newOut } : { old: null, new: null };
}

/** Кто выполняет действие. */
export interface AuditActor {
  id: number;
  login: string;
}

/** Откуда пришёл запрос. */
export interface AuditOrigin {
  ip: string | null;
  userAgent: string | null;
}

export type AuditTargetType = 'user' | 'alias' | 'domain' | 'admin' | 'mailbox' | 'settings';

export interface AuditInput {
  action: string;
  targetType: AuditTargetType;
  targetId?: number | null;
  targetLabel?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** Готовая к вставке строка admin_audit_log. */
export interface AuditRecord {
  adminId: number;
  adminLogin: string;
  action: string;
  targetType: AuditTargetType;
  targetId: number | null;
  targetLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  oldValue: Record<string, JsonValue> | null;
  newValue: Record<string, JsonValue> | null;
}

/** Обрезает строку до предела столбца в базе. */
function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Собирает запись журнала: диффует значения, вычищает секреты, режет длины. */
export function buildAuditRecord(
  actor: AuditActor,
  origin: AuditOrigin,
  input: AuditInput,
): AuditRecord {
  const diff = diffValues(input.before ?? null, input.after ?? null);
  return {
    adminId: actor.id,
    adminLogin: actor.login,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    targetLabel: clamp(input.targetLabel ?? null, 255),
    ip: clamp(origin.ip, 64),
    userAgent: clamp(origin.userAgent, 512),
    oldValue: diff.old,
    newValue: diff.new,
  };
}

/** Понятные названия действий для интерфейса журнала. */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'admin.login': 'Вход в админку',
  'admin.login.failed': 'Неудачный вход в админку',
  'admin.logout': 'Выход из админки',
  'admin.create': 'Создан администратор',
  'admin.update': 'Изменён администратор',
  'user.create': 'Создан ящик',
  'user.update': 'Изменён ящик',
  'user.password': 'Смена пароля ящика',
  'user.block': 'Ящик заблокирован',
  'user.unblock': 'Ящик разблокирован',
  'user.delete': 'Ящик удалён',
  'user.import': 'Массовый импорт ящиков',
  'user.bulk.quota': 'Массовая смена квоты',
  'user.bulk.active': 'Массовая блокировка/разблокировка',
  'alias.create': 'Создан алиас',
  'alias.update': 'Изменён алиас',
  'alias.delete': 'Удалён алиас',
  'domain.create': 'Добавлен домен',
  'domain.update': 'Изменён домен',
  'domain.delete': 'Удалён домен',
  'domain.dnscheck': 'Проверка DNS домена',
  'mailbox.impersonate': 'Вход администратора в ящик',
  'mailbox.impersonate.end': 'Выход из ящика пользователя',
};

/** Название действия для интерфейса; неизвестное возвращается как есть. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
