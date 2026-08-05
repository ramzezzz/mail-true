/**
 * Очередь Postfix глазами админки.
 *
 * ОТКУДА ДАННЫЕ. Очередь — это каталоги в /var/spool/postfix, и читают их
 * только программы Postfix. У сервера приложения их нет, и получить их он
 * может лишь двумя путями: попросить сокет Docker (это права root на всей
 * машине — цена несоразмерна) или спросить того, кто уже стоит рядом с
 * очередью. Выбран второй: в контейнере postfix живёт крошечный посредник
 * (infra/postfix/queue-agent.pl), умеющий ровно четыре вещи — показать
 * очередь, показать письмо, протолкнуть, удалить.
 *
 * Здесь — клиент к нему и разбор `postqueue -j`.
 *
 * ПРО ОБЪЁМ. `postqueue -j` выкладывает очередь целиком, а на застрявшем
 * сервере в ней бывают сотни тысяч писем. Поэтому: предел числа разбираемых
 * записей, предел объёма ответа и короткий кэш — чтобы листание страниц не
 * запускало postqueue на каждый щелчок.
 */
import type { Logger } from 'pino';
import { ApiError } from '../errors.js';
import { errorInfo } from '../log.js';

/** Адресат письма в очереди и последняя причина отсрочки для него. */
export interface QueueRecipient {
  address: string;
  delayReason: string | null;
}

/** Письмо, лежащее в очереди прямо сейчас. */
export interface QueueMessage {
  queueId: string;
  /** incoming | active | deferred | hold | corrupt — где именно лежит. */
  queueName: string;
  arrivalTime: Date;
  sizeBytes: number;
  /** Пустой отправитель (<>) — это отбойник, так и показываем. */
  sender: string;
  recipients: QueueRecipient[];
  /** Последняя причина отсрочки — то, ради чего сюда и заходят. */
  reason: string | null;
}

export interface QueueSnapshot {
  messages: QueueMessage[];
  /** Записей было больше предела разбора — показанное неполно. */
  truncated: boolean;
  takenAt: Date;
}

export interface QueueAgentOptions {
  /** Пусто — посредник не настроен, раздел очереди недоступен. */
  baseUrl: string;
  token: string;
  logger: Logger;
  /** Сколько секунд разрешено отдавать один и тот же снимок очереди. */
  cacheSeconds?: number;
  /** Потолок числа разбираемых писем очереди. */
  maxMessages?: number;
  timeoutMs?: number;
}

/** Посредник не настроен или не отвечает. */
export class QueueUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'QUEUE_UNAVAILABLE', message);
    this.name = 'QueueUnavailableError';
  }
}

const NOT_CONFIGURED =
  'Очередь недоступна: не настроен посредник к Postfix. Задайте QUEUE_AGENT_TOKEN ' +
  'в infra/.env (общий секрет с infra/postfix/queue-agent.pl) и перезапустите ' +
  'postfix и api. Пока секрета нет, посредник не запускается вовсе.';

export class QueueAgent {
  private readonly maxMessages: number;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private cache: { snapshot: QueueSnapshot; at: number } | null = null;
  /** Идущий прямо сейчас запрос: параллельные читатели ждут его, а не плодят свои. */
  private inflight: Promise<QueueSnapshot> | null = null;

  constructor(private readonly opts: QueueAgentOptions) {
    this.maxMessages = opts.maxMessages ?? 20_000;
    this.cacheMs = (opts.cacheSeconds ?? 3) * 1000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Настроен ли посредник (иначе раздел очереди честно недоступен). */
  get configured(): boolean {
    return this.opts.baseUrl !== '' && this.opts.token !== '';
  }

  private assertConfigured(): void {
    if (!this.configured) throw new QueueUnavailableError(NOT_CONFIGURED);
  }

  private async call(
    path: string,
    method: 'GET' | 'POST',
  ): Promise<Record<string, unknown>> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { 'X-Agent-Token': this.opts.token },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.opts.logger.warn(errorInfo(err, { path }), 'Посредник очереди не отвечает');
      throw new QueueUnavailableError(
        'Посредник к очереди Postfix не отвечает. Проверьте, что контейнер postfix ' +
          'запущен и в нём поднялся queue-agent.pl (docker compose logs postfix).',
      );
    }
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new QueueUnavailableError(
        `Посредник очереди ответил не по формату (код ${response.status}).`,
      );
    }
    if (!response.ok) {
      const detail = typeof body.error === 'string' ? body.error : `код ${response.status}`;
      if (response.status === 401) {
        throw new QueueUnavailableError(
          'Посредник очереди не принял секрет: QUEUE_AGENT_TOKEN у api и postfix ' +
            'должны совпадать.',
        );
      }
      throw new QueueUnavailableError(`Посредник очереди отказал: ${detail}`);
    }
    return body;
  }

  /** Снимок очереди; повторные вызовы в пределах кэша не тревожат Postfix. */
  async snapshot(force = false): Promise<QueueSnapshot> {
    this.assertConfigured();
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < this.cacheMs) {
      return this.cache.snapshot;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchSnapshot()
      .then((snapshot) => {
        this.cache = { snapshot, at: Date.now() };
        return snapshot;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchSnapshot(): Promise<QueueSnapshot> {
    const body = await this.call('/queue', 'GET');
    const lines = Array.isArray(body.lines) ? (body.lines as unknown[]) : [];
    const messages: QueueMessage[] = [];
    let truncated = lines.length > this.maxMessages;
    for (const line of lines.slice(0, this.maxMessages)) {
      if (typeof line !== 'string') continue;
      const parsed = parseQueueLine(line);
      if (parsed) messages.push(parsed);
    }
    // Свежие сверху: в очереди в первую очередь смотрят на то, что пришло
    // последним и уже застряло.
    messages.sort((a, b) => b.arrivalTime.getTime() - a.arrivalTime.getTime());
    if (lines.length > this.maxMessages) truncated = true;
    return { messages, truncated, takenAt: new Date() };
  }

  /** Одно письмо очереди целиком (конверт, заголовки, начало тела). */
  async message(queueId: string): Promise<{ text: string; truncated: boolean }> {
    assertQueueId(queueId);
    const body = await this.call(`/message?id=${encodeURIComponent(queueId)}`, 'GET');
    return {
      text: typeof body.text === 'string' ? body.text : '',
      truncated: body.truncated === true,
    };
  }

  /** Попробовать доставить сейчас, не дожидаясь расписания Postfix. */
  async flush(queueId: string): Promise<void> {
    assertQueueId(queueId);
    this.cache = null;
    await this.call(`/flush?id=${encodeURIComponent(queueId)}`, 'POST');
  }

  /** Удалить письмо из очереди. Отменить это нельзя. */
  async remove(queueId: string): Promise<void> {
    assertQueueId(queueId);
    this.cache = null;
    await this.call(`/delete?id=${encodeURIComponent(queueId)}`, 'POST');
  }
}

/**
 * Идентификатор письма проверяется и здесь, и в посреднике.
 *
 * Двойная проверка не лишняя: посредник — последний рубеж (он запускает
 * программы), а здесь она даёт человеку внятный отказ вместо «посредник
 * ответил 400» и не пускает мусор в сеть.
 */
export function isQueueId(value: string): boolean {
  return /^[A-Za-z0-9]{5,32}$/.test(value);
}

function assertQueueId(value: string): void {
  if (!isQueueId(value)) {
    throw new QueueUnavailableError(`Некорректный идентификатор письма: «${value}»`);
  }
}

/**
 * Разбор строки `postqueue -j` — по объекту JSON на письмо.
 *
 * Строка, которую не удалось разобрать, пропускается молча: postqueue
 * иногда печатает предупреждения обычным текстом, и падать из-за них,
 * теряя всю очередь, нельзя.
 */
export function parseQueueLine(line: string): QueueMessage | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const queueId = typeof raw.queue_id === 'string' ? raw.queue_id : '';
  if (!isQueueId(queueId)) return null;

  const recipientsRaw = Array.isArray(raw.recipients) ? raw.recipients : [];
  const recipients: QueueRecipient[] = [];
  for (const item of recipientsRaw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const addr = typeof rec.address === 'string' ? rec.address : '';
    if (addr === '') continue;
    recipients.push({
      address: addr,
      delayReason: typeof rec.delay_reason === 'string' ? rec.delay_reason : null,
    });
  }

  const arrival = typeof raw.arrival_time === 'number' ? raw.arrival_time : 0;
  const sender = typeof raw.sender === 'string' ? raw.sender : '';
  return {
    queueId,
    queueName: typeof raw.queue_name === 'string' ? raw.queue_name : 'unknown',
    arrivalTime: new Date(arrival * 1000),
    sizeBytes: typeof raw.message_size === 'number' ? raw.message_size : 0,
    // Пустая строка в postqueue -j — это отбойник (MAIL FROM:<>).
    sender: sender === '' ? '<>' : sender,
    recipients,
    reason: recipients.find((r) => r.delayReason !== null)?.delayReason ?? null,
  };
}

/** Отбор по строке поиска: адресат, отправитель, идентификатор, причина. */
export function queueMatches(message: QueueMessage, needle: string): boolean {
  if (needle === '') return true;
  const lower = needle.toLowerCase();
  if (message.queueId.toLowerCase().includes(lower)) return true;
  if (message.sender.toLowerCase().includes(lower)) return true;
  if ((message.reason ?? '').toLowerCase().includes(lower)) return true;
  return message.recipients.some((r) => r.address.toLowerCase().includes(lower));
}
