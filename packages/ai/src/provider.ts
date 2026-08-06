/**
 * Слой поставщика: запросы к совместимому API через встроенный fetch.
 *
 * Одинаково работает и с внешним сервисом, и с локальной моделью —
 * различаются только адрес, ключ и название модели из настроек.
 *
 * Здесь же: таймауты, повторные попытки при временных ошибках,
 * подсчёт израсходованных токенов и потоковая выдача.
 */

import { chatEndpoint, type ProviderConfig } from './config.js';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';
import { aiFail, aiOk, type AiError, type AiFailureResult, type AiOutcome, type TokenUsage } from './types.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Переопределяет температуру из настроек. */
  temperature?: number;
  /** Переопределяет предел длины ответа. */
  maxTokens?: number;
  /** Просить сервис отвечать строго объектом JSON. */
  json?: boolean;
  stop?: string[];
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
  finishReason: string | null;
  /** Сколько попыток потребовалось (1 — с первой). */
  attempts: number;
}

/** Событие потоковой выдачи. Исключения наружу не выбрасываются. */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; usage: TokenUsage; finishReason: string | null }
  | { type: 'error'; error: AiError };

export interface ProviderDeps {
  /** Подменяется в тестах. По умолчанию — встроенный fetch. */
  fetch?: typeof globalThis.fetch;
  /** Подменяется в тестах, чтобы не ждать паузы между попытками. */
  sleep?: (ms: number) => Promise<void>;
  /** Часы — для измерения длительности. */
  now?: () => number;
}

export interface ChatProvider {
  readonly endpoint: string;
  readonly model: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<AiOutcome<ChatResult>>;
  stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void>;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Поставщик поверх совместимого API вида `POST {baseUrl}/chat/completions`. */
export class CompatibleChatProvider implements ChatProvider {
  readonly #config: ProviderConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(config: ProviderConfig, deps?: ProviderDeps) {
    this.#config = config;
    this.#fetch = deps?.fetch ?? globalThis.fetch;
    this.#sleep = deps?.sleep ?? defaultSleep;
    this.#now = deps?.now ?? (() => Date.now());
  }

  get endpoint(): string {
    return chatEndpoint(this.#config);
  }

  get model(): string {
    return this.#config.model;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.#config.headers,
    };
    if (this.#config.apiKey) headers['authorization'] = `Bearer ${this.#config.apiKey}`;
    return headers;
  }

  #body(request: ChatRequest, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model: this.#config.model,
      messages: request.messages,
      temperature: request.temperature ?? this.#config.temperature,
      max_tokens: request.maxTokens ?? this.#config.maxOutputTokens,
      stream,
    };
    if (request.json === true) payload['response_format'] = { type: 'json_object' };
    if (request.stop && request.stop.length > 0) payload['stop'] = request.stop;
    if (stream) payload['stream_options'] = { include_usage: true };
    return JSON.stringify(payload);
  }

  /** Обычный вызов с повторами при временных ошибках. */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<AiOutcome<ChatResult>> {
    const started = this.#now();
    const promptText = request.messages.map((m) => m.content).join('\n');
    let lastFailure = aiFail('network', 'Сервис ИИ недоступен');

    for (let attempt = 1; attempt <= this.#config.maxRetries + 1; attempt += 1) {
      const response = await this.#send(this.#body(request, false), signal);

      if (!response.ok) {
        lastFailure = response;
        if (!response.error.retryable || attempt > this.#config.maxRetries) return lastFailure;
        await this.#sleep(this.#delay(attempt, response.error.status));
        continue;
      }

      const parsed = parseChatCompletion(response.value.text, promptText);
      if (!parsed.ok) return parsed;

      return aiOk(
        { ...parsed.value, attempts: attempt },
        { usage: parsed.value.usage, durationMs: this.#now() - started },
      );
    }

    return lastFailure;
  }

  /**
   * Потоковый вызов: текст отдаётся по мере генерации.
   * Повторов здесь нет — часть ответа уже могла уйти в интерфейс.
   */
  async *stream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, void> {
    const promptText = request.messages.map((m) => m.content).join('\n');
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) {
        yield { type: 'error', error: aiFail('aborted', 'Запрос отменён').error };
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#config.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.#fetch(this.endpoint, {
          method: 'POST',
          headers: { ...this.#headers(), accept: 'text/event-stream' },
          body: this.#body(request, true),
          signal: controller.signal,
        });
      } catch (error) {
        yield { type: 'error', error: describeFetchError(error, signal).error };
        return;
      }

      if (!response.ok) {
        const detail = await safeText(response);
        yield {
          type: 'error',
          error: httpFailure(response.status, detail).error,
        };
        return;
      }

      const body = response.body;
      if (!body) {
        yield { type: 'error', error: aiFail('bad-response', 'Сервис ИИ вернул пустой поток').error };
        return;
      }

      let text = '';
      let usage: TokenUsage | null = null;
      let finishReason: string | null = null;
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        const reader = body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });

          let cut = buffer.indexOf('\n\n');
          while (cut >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = parseSseBlock(block);
            if (event === 'done') {
              cut = -1;
              buffer = '';
              break;
            }
            if (event) {
              if (event.delta.length > 0) {
                text += event.delta;
                yield { type: 'delta', text: event.delta };
              }
              if (event.usage) usage = event.usage;
              if (event.finishReason) finishReason = event.finishReason;
            }
            cut = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        yield { type: 'error', error: describeFetchError(error, signal).error };
        return;
      }

      yield {
        type: 'done',
        text,
        usage: usage ?? estimateUsage(promptText, text),
        finishReason,
      };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Один запрос с таймаутом; возвращает тело ответа как текст. */
  async #send(
    body: string,
    signal?: AbortSignal,
  ): Promise<AiOutcome<{ text: string; status: number }>> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) return aiFail('aborted', 'Запрос отменён', { retryable: false });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#config.timeoutMs);

    try {
      const response = await this.#fetch(this.endpoint, {
        method: 'POST',
        headers: this.#headers(),
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) return httpFailure(response.status, text);
      return aiOk({ text, status: response.status }, { usage: ZERO });
    } catch (error) {
      if (timedOut) {
        return aiFail('timeout', 'Сервис ИИ не ответил вовремя', {
          retryable: true,
          details: `таймаут ${this.#config.timeoutMs} мс`,
        });
      }
      return describeFetchError(error, signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  #delay(attempt: number, status: number | null): number {
    const base = this.#config.retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(base * 0.2 * Math.random());
    const capped = Math.min(base + jitter, 30_000);
    return status === 429 ? Math.max(capped, this.#config.retryBaseDelayMs * 2) : capped;
  }
}

const ZERO: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimated: true,
};

function httpFailure(status: number, detail: string): AiFailureResult {
  const retryable = RETRYABLE_STATUS.has(status);
  if (status === 429) {
    return aiFail('rate-limited', 'Сервис ИИ ограничил частоту запросов, попробуйте позже', {
      retryable: true,
      status,
      details: detail.slice(0, 500),
    });
  }
  if (status === 401 || status === 403) {
    return aiFail('not-configured', 'Сервис ИИ отклонил ключ доступа', {
      retryable: false,
      status,
      details: detail.slice(0, 500),
    });
  }
  return aiFail(
    'http',
    retryable
      ? 'Сервис ИИ временно недоступен'
      : `Сервис ИИ отклонил запрос (код ${String(status)})`,
    { retryable, status, details: detail.slice(0, 500) },
  );
}

function describeFetchError(error: unknown, signal?: AbortSignal): AiFailureResult {
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted === true) {
    return aiFail('aborted', 'Запрос отменён', { retryable: false, details: message });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return aiFail('timeout', 'Сервис ИИ не ответил вовремя', { retryable: true, details: message });
  }
  return aiFail('network', 'Не удалось связаться с сервисом ИИ', {
    retryable: true,
    details: message,
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function estimateUsage(prompt: string, completion: string): TokenUsage {
  const promptTokens = estimateMessagesTokens([prompt]);
  const completionTokens = estimateTokens(completion);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

/**
 * Разбирает ответ совместимого API. Устойчив к искажениям:
 * непонятный ответ даёт понятную ошибку, а не исключение.
 */
/**
 * Неизвестное значение — в текст, который не стыдно показать человеку.
 *
 * Обычный `String(value)` на объекте даёт «[object Object]»: сервис ИИ
 * кладёт в поле ошибки то вложенный объект, то массив, и в сообщении
 * пользователя оказывалось именно это — вместо причины отказа. Строку
 * берём как есть, объект разворачиваем в JSON (обрезая: сообщение об
 * ошибке не место для мегабайта), остальное приводим обычным способом.
 */
function readableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'неизвестная ошибка';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, 300);
    } catch {
      // Круговая ссылка: другого способа рассказать о ней нет.
      return 'ответ сервиса не удалось прочитать';
    }
  }
  // Здесь остались только простые значения: число, логическое, символ,
  // функция. Тип назван явно — иначе `unknown` и у читателя, и у линтера
  // оставляет вопрос, не попадёт ли сюда объект.
  return String(value as number | boolean | symbol | bigint);
}

export function parseChatCompletion(
  raw: string,
  promptText: string,
): AiOutcome<{ text: string; usage: TokenUsage; finishReason: string | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return aiFail('bad-response', 'Сервис ИИ вернул не JSON', {
      retryable: false,
      details: raw.slice(0, 300),
    });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return aiFail('bad-response', 'Сервис ИИ вернул неожиданный ответ', { retryable: false });
  }

  const root = parsed as Record<string, unknown>;

  // Некоторые сервисы кладут ошибку в тело с кодом 200.
  const errorField = root['error'];
  if (errorField != null) {
    const message = readableValue(
      typeof errorField === 'object' && errorField !== null
        ? ((errorField as Record<string, unknown>)['message'] ?? errorField)
        : errorField,
    );
    return aiFail('http', `Сервис ИИ вернул ошибку: ${message}`, { retryable: false });
  }

  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return aiFail('bad-response', 'В ответе сервиса ИИ нет вариантов ответа', { retryable: false });
  }

  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return aiFail('bad-response', 'В ответе сервиса ИИ повреждён вариант ответа', {
      retryable: false,
    });
  }

  const choice = first as Record<string, unknown>;
  const messageField = choice['message'];
  let text = '';
  if (typeof messageField === 'object' && messageField !== null) {
    const content = (messageField as Record<string, unknown>)['content'];
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      // Форма с массивом частей содержимого.
      text = content
        .map((part) => {
          if (typeof part !== 'object' || part === null) return '';
          const value = (part as Record<string, unknown>)['text'];
          // Только строка: часть с картинкой или вызовом инструмента текста
          // не несёт, и «[object Object]» посреди ответа — не текст, а мусор,
          // который человек увидит в письме.
          return typeof value === 'string' ? value : '';
        })
        .join('');
    }
  } else if (typeof choice['text'] === 'string') {
    text = choice['text'];
  }

  const finishReasonEarly = choice['finish_reason'];
  if (text.trim().length === 0) {
    // Модели с «размышлением» тратят предел длины на рассуждение, и полезный
    // ответ не помещается. Сообщаем об этом прямо, а не «пустым ответом».
    if (finishReasonEarly === 'length') {
      return aiFail(
        'bad-response',
        'Ответ модели оборван: не хватило предела длины ответа. Увеличьте maxOutputTokens в настройках',
        { retryable: false },
      );
    }
    return aiFail('bad-response', 'Сервис ИИ вернул пустой ответ', { retryable: true });
  }

  const finishReasonRaw = choice['finish_reason'];
  const finishReason = typeof finishReasonRaw === 'string' ? finishReasonRaw : null;
  const usage = readUsage(root['usage'], promptText, text);

  return aiOk({ text, usage, finishReason }, { usage });
}

/** Счётчики токенов из ответа; при их отсутствии — оценка по длине текста. */
export function readUsage(raw: unknown, promptText: string, completion: string): TokenUsage {
  if (typeof raw === 'object' && raw !== null) {
    const u = raw as Record<string, unknown>;
    const prompt = numberOrNull(u['prompt_tokens']);
    const completionTokens = numberOrNull(u['completion_tokens']);
    const total = numberOrNull(u['total_tokens']);
    if (prompt !== null || completionTokens !== null || total !== null) {
      const p = prompt ?? 0;
      const c = completionTokens ?? 0;
      return {
        promptTokens: p,
        completionTokens: c,
        totalTokens: total ?? p + c,
        estimated: false,
      };
    }
  }
  return estimateUsage(promptText, completion);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

interface SseDelta {
  delta: string;
  usage: TokenUsage | null;
  finishReason: string | null;
}

/**
 * Разбирает один блок SSE. Возвращает 'done' на маркере завершения
 * и null на всём, что разобрать не удалось, — поток не должен падать
 * из-за одной битой строки.
 */
export function parseSseBlock(block: string): SseDelta | 'done' | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('');
  if (payload === '[DONE]') return 'done';
  if (payload.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const root = parsed as Record<string, unknown>;
  let delta = '';
  let finishReason: string | null = null;

  const choices = root['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === 'object' && first !== null) {
      const choice = first as Record<string, unknown>;
      const deltaField = choice['delta'];
      if (typeof deltaField === 'object' && deltaField !== null) {
        const content = (deltaField as Record<string, unknown>)['content'];
        if (typeof content === 'string') delta = content;
      } else if (typeof choice['text'] === 'string') {
        delta = choice['text'];
      }
      const fr = choice['finish_reason'];
      if (typeof fr === 'string') finishReason = fr;
    }
  }

  let usage: TokenUsage | null = null;
  const usageField = root['usage'];
  if (typeof usageField === 'object' && usageField !== null) {
    const u = usageField as Record<string, unknown>;
    const prompt = numberOrNull(u['prompt_tokens']);
    const completion = numberOrNull(u['completion_tokens']);
    const total = numberOrNull(u['total_tokens']);
    if (prompt !== null || completion !== null || total !== null) {
      const p = prompt ?? 0;
      const c = completion ?? 0;
      usage = { promptTokens: p, completionTokens: c, totalTokens: total ?? p + c, estimated: false };
    }
  }

  return { delta, usage, finishReason };
}
