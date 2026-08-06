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

/* --- Предел ожидания ответа -----------------------------------------
 *
 * У `fetch` своего предела НЕТ, и это не мелочь. Проверено на стенде:
 * при остановленном сервере приложения запрос к `/api/folders` не
 * разрешился и не отвергся за 24 секунды — обещание просто висело, а
 * интерфейс всё это время показывал «загружаем». Отказа, на который можно
 * было бы среагировать, не существовало вовсе.
 *
 * Ждать бесконечно нельзя ни в одном месте продукта: человек не отличает
 * «медленно» от «сломалось» и сидит перед крутилкой. Поэтому предел есть
 * всегда, а по его истечении приходит НАСТОЯЩАЯ ошибка с внятным текстом.
 *
 * Пределы разные, потому что разное и ожидание:
 *   - обычный запрос — секунды; если ответа нет полминуты, связи нет;
 *   - выгрузка файла на сервер — минуты: вложение на 18 МБ по слабому
 *     каналу идёт долго, и обрывать его на тридцатой секунде значит
 *     ломать работающую отправку;
 *   - скачивание вложения — тоже минуты, по той же причине.
 */
const TIMEOUT_DEFAULT_MS = 30_000;
const TIMEOUT_UPLOAD_MS = 10 * 60 * 1000;
const TIMEOUT_DOWNLOAD_MS = 5 * 60 * 1000;

/** Код ошибки предела ожидания — по нему интерфейс отличает «нет связи». */
export const TIMEOUT_CODE = 'TIMEOUT';

/** Сработал ли предел ожидания (а не отказ сервера). */
export function isTimeoutError(error: unknown): boolean {
  return isApiError(error) && error.code === TIMEOUT_CODE;
}

/**
 * Сигнал прерывания: наш предел плюс тот, что передал вызывающий.
 *
 * Свой сигнал у вызова бывает (отмена поиска при новом вводе), и терять
 * его нельзя — поэтому сигналы объединяются, а не подменяются.
 */
function withTimeout(init: ApiRequestInit | undefined, ms: number): AbortSignal {
  const ours = AbortSignal.timeout(ms);
  const theirs = init?.signal;
  return theirs ? AbortSignal.any([theirs, ours]) : ours;
}

/**
 * Свои параметры запроса поверх обычных.
 *
 * `timeoutMs` нужен там, где вызывающий знает про ожидание больше нас:
 * заведомо долгая операция может попросить больше, заведомо быстрая —
 * меньше. Без этого предел был бы зашит намертво, и единственным способом
 * его проверить оставалось бы ждать полминуты в каждой проверке.
 */
export interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
}

/** Предел для конкретного запроса: выгрузка файла ждёт дольше. */
function timeoutFor(init: ApiRequestInit | undefined): number {
  if (typeof init?.timeoutMs === 'number' && init.timeoutMs > 0) return init.timeoutMs;
  const body = init?.body;
  return typeof FormData !== 'undefined' && body instanceof FormData
    ? TIMEOUT_UPLOAD_MS
    : TIMEOUT_DEFAULT_MS;
}

/**
 * Превращает прерывание по времени в ошибку, которую можно показать.
 *
 * Своё прерывание вызывающего (отмена запроса) сюда не попадает: его
 * пробрасываем как есть, иначе отменённый поиск выглядел бы поломкой.
 */
function asTimeout(err: unknown, path: string, ms: number, ownSignal: AbortSignal | undefined): never {
  const aborted = err instanceof DOMException && err.name === 'AbortError';
  const timedOut =
    (err instanceof DOMException && err.name === 'TimeoutError') ||
    (aborted && ownSignal?.aborted !== true);
  if (timedOut) {
    throw new ApiError(
      0,
      path,
      `Сервер не ответил за ${String(Math.round(ms / 1000))} с. Проверьте связь и повторите.`,
      TIMEOUT_CODE,
    );
  }
  throw err;
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

export async function apiFetch<T>(path: string, init?: ApiRequestInit): Promise<T> {
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
  const ms = timeoutFor(init);
  let response: Response;
  try {
    response = await fetch(path, {
      ...(withJson ? { headers: { 'Content-Type': 'application/json' } } : {}),
      ...init,
      signal: withTimeout(init, ms),
    });
  } catch (err) {
    asTimeout(err, path, ms, init?.signal ?? undefined);
  }
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
export async function apiFetchBlob(path: string, init?: ApiRequestInit): Promise<Blob> {
  let response: Response;
  try {
    const ms = init?.timeoutMs && init.timeoutMs > 0 ? init.timeoutMs : TIMEOUT_DOWNLOAD_MS;
    response = await fetch(path, { ...init, signal: withTimeout(init, ms) });
  } catch (err) {
    asTimeout(err, path, init?.timeoutMs ?? TIMEOUT_DOWNLOAD_MS, init?.signal ?? undefined);
  }
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
