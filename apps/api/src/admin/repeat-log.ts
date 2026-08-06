/**
 * Защита журнала от повторов.
 *
 * ПОЧЕМУ ЭТО НУЖНО
 *
 * Почти всё фоновое в админке ходит по расписанию, а поломки, которые эти
 * проходы находят, живут не минуты, а дни: не поднялся посредник очереди,
 * недоступна база, некому читать журнал Postfix. Проход пишет предупреждение
 * — и, пока причина не устранена, пишет его снова на каждом заходе.
 *
 * Арифметика беспощадна при нынешних интервалах:
 *   уборщик              60 с →  1 440 одинаковых записей в сутки;
 *   сборщик показателей  60 с →  1 440;
 *   сборщик истории       5 с → 17 280.
 *
 * Итог — журнал сервера приложения, в котором 99% строк об одном и том же.
 * Настоящие, разовые предупреждения в нём тонут, и администратор перестаёт
 * журнал читать вообще. Это ровно та беда, из-за которой раздел «Журналы
 * почты» в панели показывал бесполезную ленту.
 *
 * ЧТО ДЕЛАЕМ
 *
 * Сообщаем о поломке ОДИН раз, дальше молчим, пока причина та же, и
 * напоминаем не чаще раза в час. Когда причина меняется (другая ошибка) —
 * это новость, сообщаем сразу. Когда всё наладилось — сообщаем и об этом,
 * с числом подавленных повторов: иначе по журналу нельзя будет понять, шла
 * поломка минуту или сутки.
 *
 * ЧЕГО НЕ ДЕЛАЕМ
 *
 * Не глушим разовые ошибки: первая всегда проходит целиком. Не считаем
 * подавленное «потерянным» — количество попадает в запись о напоминании и
 * в запись о восстановлении, так что ни одно событие не исчезает бесследно,
 * исчезают только дубликаты.
 */
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';

/** Раз в час — компромисс: смену видно, а журнал не забит. */
export const DEFAULT_REMINDER_MS = 60 * 60 * 1000;

/** Решение сторожа: писать эту запись в журнал или промолчать. */
export interface RepeatDecision {
  /** Сколько повторов подавлено с прошлой записи. */
  suppressed: number;
  /** Почему пишем: впервые / сменилась причина / часовое напоминание. */
  reason: 'first' | 'changed' | 'reminder';
}

export interface RepeatGuardOptions {
  /** Как часто напоминать, если причина не меняется. */
  reminderMs?: number;
  /** Часы. Подменяются в тестах, чтобы не ждать час. */
  now?: () => number;
}

/**
 * Сторож повторов для ОДНОЙ точки журнала.
 *
 * Состояние держится в памяти процесса и намеренно не переживает
 * перезапуск: после перезапуска первая же поломка снова новость, и это
 * правильно — перезапуск мог её и вызвать.
 */
export class RepeatGuard {
  readonly #reminderMs: number;
  readonly #now: () => number;
  /** Признак текущей причины; null — сейчас всё в порядке. */
  #key: string | null = null;
  #lastLoggedAt = 0;
  #suppressed = 0;

  constructor(opts: RepeatGuardOptions = {}) {
    this.#reminderMs = opts.reminderMs ?? DEFAULT_REMINDER_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Сколько повторов подавлено и ещё не показано. */
  get suppressed(): number {
    return this.#suppressed;
  }

  /**
   * Случилась поломка с признаком `key`. Вернёт решение, если писать надо,
   * и null, если это дубликат в пределах окна тишины.
   */
  onFailure(key: string): RepeatDecision | null {
    const now = this.#now();
    if (this.#key !== key) {
      // Другая причина — другая новость. Счётчик подавленного отдаём
      // вместе с ней, чтобы прошлая поломка не пропала бесследно.
      const suppressed = this.#suppressed;
      const reason: RepeatDecision['reason'] = this.#key === null ? 'first' : 'changed';
      this.#key = key;
      this.#lastLoggedAt = now;
      this.#suppressed = 0;
      return { suppressed, reason };
    }
    if (now - this.#lastLoggedAt >= this.#reminderMs) {
      const suppressed = this.#suppressed;
      this.#lastLoggedAt = now;
      this.#suppressed = 0;
      return { suppressed, reason: 'reminder' };
    }
    this.#suppressed += 1;
    return null;
  }

  /**
   * Всё наладилось. Вернёт число подавленных повторов, если поломка была,
   * и null, если её и не было (тогда писать нечего).
   */
  onSuccess(): number | null {
    if (this.#key === null) return null;
    const suppressed = this.#suppressed;
    this.#key = null;
    this.#lastLoggedAt = 0;
    this.#suppressed = 0;
    return suppressed;
  }
}

/**
 * Признак причины по ошибке.
 *
 * Берём текст и код, но НЕ стек: у одной и той же поломки стек может
 * отличаться номером строки повтора, и тогда каждая попытка считалась бы
 * новой причиной — то есть глушение не работало бы вовсе.
 */
export function failureKey(err: unknown): string {
  const info = errorInfo(err);
  // Код отказа бывает и числом (errno), и объектом (вложенная ошибка):
  // «[object Object]» в ключе склеил бы разные причины в одну, и глушение
  // повторов промолчало бы о новой.
  const code =
    typeof info.code === 'string' || typeof info.code === 'number' ? String(info.code) : '';
  return `${code}|${info.err}`;
}

/**
 * Предупреждение с защитой от повторов.
 *
 * Обёртка над `logger.warn`, чтобы на каждом месте применения не повторять
 * одни и те же четыре строки. Возвращает true, если запись сделана.
 */
export function warnOnce(
  guard: RepeatGuard,
  logger: Logger,
  err: unknown,
  message: string,
  extra: Record<string, unknown> = {},
): boolean {
  const decision = guard.onFailure(failureKey(err));
  if (!decision) return false;
  logger.warn(
    {
      ...errorInfo(err, extra),
      repeat: decision.reason,
      // Число подавленных повторов — единственный способ отличить
      // «моргнуло раз» от «лежит вторые сутки», раз промежуточных
      // записей больше нет.
      ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
    },
    decision.reason === 'reminder' ? `${message} (всё ещё)` : message,
  );
  return true;
}

/**
 * Сообщение о восстановлении. Пишется только если до этого была поломка:
 * без него молчание сторожа неотличимо от «раздел вообще не работает».
 */
export function noteRecovered(
  guard: RepeatGuard,
  logger: Logger,
  message: string,
  extra: Record<string, unknown> = {},
): boolean {
  const suppressed = guard.onSuccess();
  if (suppressed === null) return false;
  logger.info({ ...extra, ...(suppressed > 0 ? { suppressed } : {}) }, message);
  return true;
}
