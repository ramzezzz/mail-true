/** Тонкая обёртка над fetch: JSON, ошибки, query-параметры. */

/**
 * Ошибка HTTP API.
 *
 * Сервер отвечает телом `{ error: КОД, message: "человеческий текст" }`.
 * Раньше в `message` ошибки попадал КОД, а человеческий текст терялся —
 * и пользователь видел «AI_BUDGET_EXCEEDED» вместо объяснения, сколько
 * именно израсходовано. Теперь ошибка несёт и то и другое:
 *
 *   - `code`    — машинный код (`AI_CONSENT_REQUIRED` и т. п.) или null,
 *                 если тело ответа не JSON;
 *   - `message` — текст для человека; если сервер его не прислал, остаётся
 *                 код, а если и кода нет — `statusText` (как было раньше).
 *
 * Четвёртый параметр необязательный, поэтому существующие вызовы
 * `new ApiError(status, url, message)` продолжают работать.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Сужение типа для `catch (err: unknown)`. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Машинный код ошибки API или null, если ошибка другого рода. */
export function apiErrorCode(error: unknown): string | null {
  return isApiError(error) ? error.code : null;
}

/* --- Истёкшая сессия ------------------------------------------------
 * Ответ 401 значит одно: сессии больше нет. Раньше его никто не ловил —
 * запрос трижды повторялся, а пользователь видел пустое меню и невнятную
 * ошибку вместо экрана входа. Теперь любой 401 поднимает один общий
 * обработчик, который ставит SessionProvider (src/app/session.tsx). */

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Регистрирует реакцию на 401; возвращает функцию снятия. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

/** Сам вход и выход из 401 выводов не делают — иначе получится петля. */
function isAuthRoute(path: string): boolean {
  return path.startsWith('/api/auth/');
}

/**
 * Говорит ли 401 о том, что НАША сессия закончилась.
 *
 * Не всякий 401 про нас. Связывание второго ящика проверяет введённый
 * пароль настоящим IMAP-логином и на неверный отвечает
 * `401 {"error":"AUTH_FAILED"}` — про чужой пароль, а не про нашу сессию.
 * Про сессию сервер говорит другим кодом: `401 {"error":"UNAUTHORIZED",
 * "message":"Требуется вход в систему"}` (проверено обоими запросами).
 *
 * Без этого различия человек, опечатавшийся в пароле добавляемого ящика,
 * вылетал бы из почты на экран входа.
 */
function isSessionExpiry(path: string, code: string | null): boolean {
  if (isAuthRoute(path)) return false;
  return code !== 'AUTH_FAILED';
}

/**
 * Стоит ли повторять запрос. 401 и 403 — не сбой связи, а отказ в доступе:
 * повтор ничего не изменит, а пользователь ждёт три круга впустую.
 * Ровно так же сделано в админке (`apps/admin/src/main.tsx`).
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = isApiError(error) ? error.status : undefined;
  if (status === 401 || status === 403 || status === 404) return false;
  return failureCount < 2;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export function buildQuery(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  /*
   * Заголовок с типом содержимого ставится ТОЛЬКО когда тело действительно
   * есть и оно в формате JSON.
   *
   * Раньше условие звучало «всё, что не форма с файлом» — и заголовок
   * попадал в том числе на запросы вовсе без тела. Сервер такой запрос
   * отвергает: заявлено JSON, а тела нет. Из-за этого девять операций
   * не работали вовсе и молчали об этом: очистка и удаление папки,
   * удаление фильтра, проверка и удаление внешнего ящика, отписка от
   * рассылки, отзыв согласия на помощника, удаление его ответов — и,
   * что хуже всего, выход из ящика.
   *
   * Выход при этом выглядел удавшимся: ошибка глоталась, показывался
   * экран входа, а сессия на сервере продолжала действовать. На общем
   * компьютере человек уверен, что вышел, а почта доступна следующему.
   *
   * Заглушки этого поймать не могли: они не делают HTTP-запросов вовсе.
   */
  const hasBody = init?.body !== undefined && init.body !== null;
  const withJson = hasBody && !(init.body instanceof FormData);
  const response = await fetch(path, {
    ...(withJson ? { headers: { 'Content-Type': 'application/json' } } : {}),
    ...init,
  });
  if (!response.ok) {
    let detail = response.statusText;
    let code: string | null = null;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (typeof body.error === 'string' && body.error) code = body.error;
      // Человеческий текст важнее кода: именно он показывается пользователю.
      if (typeof body.message === 'string' && body.message) detail = body.message;
      else if (code) detail = code;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    if (response.status === 401 && isSessionExpiry(path, code)) unauthorizedHandler?.();
    throw new ApiError(response.status, path, detail, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * То же самое, но ответ — байты, а не JSON.
 *
 * Нужно для частей письма (`/api/messages/:id/parts/:partId`): их отдают
 * как файл, и `apiFetch` на таком ответе споткнулся бы о `response.json()`.
 * Разбор отказа и реакция на истёкшую сессию — общие с `apiFetch`.
 */
export async function apiFetchBlob(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = response.statusText;
    let code: string | null = null;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      if (typeof body.error === 'string' && body.error) code = body.error;
      if (typeof body.message === 'string' && body.message) detail = body.message;
      else if (code) detail = code;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    if (response.status === 401 && isSessionExpiry(path, code)) unauthorizedHandler?.();
    throw new ApiError(response.status, path, detail, code);
  }
  return await response.blob();
}
