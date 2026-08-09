/**
 * Общие типы пакета @mail-true/ai.
 *
 * Главное правило пакета: наружу НИКОГДА не бросается исключение.
 * Любая функция возвращает {@link AiOutcome} — либо результат, либо
 * описание причины отказа. Отказ сервиса ИИ не должен ломать почту.
 */

/** Возможность помощника. Входит в ключ кэша и в журнал обращений. */
export type AiFeature =
  | 'summarize.message'
  | 'summarize.thread'
  | 'classify'
  | 'reply.variants'
  | 'reply.continue'
  | 'rewrite'
  | 'extract'
  | 'translate'
  | 'search.query'
  /** Подсказка адреса файла логотипа по домену отправителя. */
  | 'logo.hint';

/** Расход токенов за один вызов сервиса. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true — сервис не вернул счётчики и значения оценены по длине текста. */
  estimated: boolean;
}

export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimated: true,
};

/** Складывает расходы нескольких вызовов. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimated: a.estimated || b.estimated,
  };
}

/**
 * Причина отказа. Разделение нужно интерфейсу: одни причины стоит
 * показать пользователю дословно («исчерпан лимит»), другие — свернуть
 * в «подсказки временно недоступны».
 */
export type AiErrorKind =
  /** Помощник выключен администратором или пользователем. */
  | 'disabled'
  /** Настройки поставщика отсутствуют или не проходят проверку. */
  | 'not-configured'
  /** Некорректные входные данные (пустое письмо и т. п.). */
  | 'invalid-input'
  /** Исчерпан заданный предел расходов или частоты. */
  | 'budget-exceeded'
  /** Сервис ответил 429 — слишком часто. */
  | 'rate-limited'
  /** Истёк таймаут запроса. */
  | 'timeout'
  /** Сеть недоступна, соединение оборвалось. */
  | 'network'
  /** Сервис вернул ошибочный код состояния. */
  | 'http'
  /** Ответ разобран, но не соответствует ожидаемой форме. */
  | 'bad-response'
  /** Вызов отменён снаружи (AbortSignal). */
  | 'aborted';

export interface AiError {
  kind: AiErrorKind;
  /** Сообщение на русском, пригодное для показа пользователю. */
  message: string;
  /** Имеет ли смысл повторить попытку позже. */
  retryable: boolean;
  /** Код состояния HTTP, если отказ пришёл от сервиса. */
  status: number | null;
  /** Технические подробности для журнала; в интерфейс не выводится. */
  details: string | null;
}

/** Опись того, что именно уходит наружу. Показывается пользователю. */
export interface OutboundDisclosure {
  /** Адрес, на который уйдут данные. */
  endpoint: string;
  /** Название модели. */
  model: string;
  /** Человекочитаемое название сервиса из настроек. */
  providerLabel: string;
  /** true — модель поднята внутри периметра, письма не покидают сервер. */
  local: boolean;
  /** Поля, которые действительно попадают в запрос. */
  fields: OutboundField[];
  /** Что было вырезано перед отправкой. */
  removed: RemovedPart[];
  /** Имена вложений, которые НЕ отправляются (отправляются никогда). */
  attachmentsExcluded: string[];
  /** Суммарная длина отправляемого текста в символах. */
  totalChars: number;
  /** Оценка числа токенов отправляемого текста. */
  approxTokens: number;
}

export interface OutboundField {
  /** Машинное имя: 'subject', 'from', 'to', 'cc', 'date', 'body'. */
  field: string;
  /** Подпись для интерфейса. */
  label: string;
  /** Полное значение, ровно то, что уходит наружу. */
  value: string;
  chars: number;
}

export type RemovedKind =
  'signature' | 'quote' | 'attachment' | 'headers' | 'truncated' | 'html-markup';

export interface RemovedPart {
  kind: RemovedKind;
  /** Сколько фрагментов такого рода вырезано. */
  count: number;
  /** Сколько символов вырезано. Для вложений — сколько байт не отправлено. */
  chars: number;
  /** Пояснение для интерфейса. */
  note: string;
}

export interface AiSuccess<T> {
  ok: true;
  value: T;
  usage: TokenUsage;
  /** Ответ взят из кэша, наружу ничего не отправлялось. */
  cached: boolean;
  /** Опись отправленного; null, если отправки не было (кэш). */
  disclosure: OutboundDisclosure | null;
  durationMs: number;
}

export interface AiFailureResult {
  ok: false;
  error: AiError;
}

export type AiOutcome<T> = AiSuccess<T> | AiFailureResult;

export function isOk<T>(outcome: AiOutcome<T>): outcome is AiSuccess<T> {
  return outcome.ok;
}

export function aiFail(
  kind: AiErrorKind,
  message: string,
  extra?: { retryable?: boolean; status?: number; details?: string },
): AiFailureResult {
  const retryableByDefault =
    kind === 'timeout' || kind === 'network' || kind === 'rate-limited' || kind === 'http';
  return {
    ok: false,
    error: {
      kind,
      message,
      retryable: extra?.retryable ?? retryableByDefault,
      status: extra?.status ?? null,
      details: extra?.details ?? null,
    },
  };
}

export function aiOk<T>(
  value: T,
  init: {
    usage: TokenUsage;
    cached?: boolean;
    disclosure?: OutboundDisclosure | null;
    durationMs?: number;
  },
): AiSuccess<T> {
  return {
    ok: true,
    value,
    usage: init.usage,
    cached: init.cached ?? false,
    disclosure: init.disclosure ?? null,
    durationMs: init.durationMs ?? 0,
  };
}

/**
 * Письмо на входе помощника.
 *
 * Форма намеренно совпадает с `Message` из @mail-true/shared по именам
 * и типам полей, но объявлена здесь отдельно: пакет не должен зависеть
 * от сборки соседнего пакета. Благодаря структурной типизации
 * `Message` из shared подходит сюда без преобразований.
 */
export interface AiSourceMessage {
  id: string;
  threadId?: string;
  subject: string;
  /** Дата в формате ISO 8601. */
  date: string;
  from: AiSourceAddress;
  to: readonly AiSourceAddress[];
  cc?: readonly AiSourceAddress[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments?: readonly AiSourceAttachment[];
  headers?: Readonly<Record<string, string>>;
}

export interface AiSourceAddress {
  name: string | null;
  address: string;
}

export interface AiSourceAttachment {
  filename: string;
  mimeType: string;
  size: number;
}
