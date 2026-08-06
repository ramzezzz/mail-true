/**
 * Сжатая запись ошибки в журнал.
 *
 * Зачем. Если передать pino объект ошибки целиком (`logger.warn({ err }, …)`),
 * стандартный сериализатор выкладывает в строку журнала всё: текст, стек и
 * все собственные поля. У ошибок `pg` и почтовых клиентов среди этих полей
 * лежит состояние соединения, поэтому ОДНА запись весит килобайты.
 *
 * Измерено на живом стеке: запись об ошибке пула Postgres — 3596 Б при
 * перезапуске сервера и 3101 Б при обрыве соединения; те же события в сжатом
 * виде — 198 Б и 166 Б (в 18 раз меньше). На «шторме перезапусков» из 5000
 * событий занятая куча вырастала на 46.6 МБ против 7.0 МБ. Сборщик мусора
 * это потом возвращает, но на сервере с 2 ГБ такой всплеск — лишний риск.
 *
 * Для понимания причины достаточно текста и кода: `57P01` (сервер закрыл
 * соединение), `ECONNRESET` (оборвалась сеть) и так далее. Стек соединения
 * ничего не объясняет — он всегда один и тот же, из недр драйвера.
 *
 * Где НЕ применять: там, где ошибка означает нашу собственную поломку и
 * случается один раз (проверка схемы при старте, необработанное исключение
 * процесса) — там стек и есть всё содержание.
 */

/** Суть ошибки: то, по чему её опознают в журнале. */
export interface ErrorInfo {
  err: string;
  code?: string;
  /** Имя класса ошибки, если оно что-то добавляет к тексту. */
  errType?: string;
}

/**
 * Предел длины текста в записи журнала.
 *
 * Не теория: ошибка «Too long argument» от Dovecot приезжала вместе с
 * командой, в которой лежал весь список номеров писем, — ОДНА запись
 * весила 225 КБ. Причина ошибки к тому времени уже понятна из первых
 * строк, а остальное только раздувает журнал и память.
 */
const MAX_TEXT_CHARS = 500;

function clamp(text: string, limit = MAX_TEXT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (обрезано)`;
}

function textOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  if (err === undefined) return 'неизвестная ошибка';
  if (err === null) return 'null';
  // Объект сюда доходит редко, но именно в такие минуты журнал и читают:
  // «[object Object]» вместо причины — это потерянный след.
  if (typeof err !== 'object') return String(err as number | boolean | symbol | bigint);
  try {
    return JSON.stringify(err) ?? 'нечитаемая ошибка';
  } catch {
    // Круговая ссылка — рассказать о ней иначе нечем.
    return 'нечитаемая ошибка';
  }
}

/**
 * Готовит объект для pino: `logger.warn(errorInfo(err), 'Что случилось')`.
 * Дополнительные поля добавляются вторым аргументом.
 */
export function errorInfo(
  err: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const info: ErrorInfo = { err: clamp(textOf(err)) };

  const source = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const code = source['code'];
  if (typeof code === 'string' || typeof code === 'number') info.code = String(code);

  const name = source['name'];
  if (typeof name === 'string' && name && name !== 'Error') info.errType = name;

  return { ...info, ...extra };
}

/**
 * То же самое, но со стеком: для ошибок, которые означают нашу поломку
 * (обработчик 500). Стек нужен, а вот чужие поля объекта ошибки — нет:
 * именно в них у клиентов почты и базы лежит состояние соединения.
 * У imapflow там же лежит и текст команды целиком — отсюда и брались
 * записи журнала на сотни килобайт.
 */
export function errorForLog(err: unknown): Record<string, unknown> {
  const stack = err && typeof err === 'object' ? (err as { stack?: unknown }).stack : undefined;
  if (typeof stack !== 'string') return errorInfo(err);
  // Первых строк стека достаточно, чтобы найти место в коде
  return errorInfo(err, { stack: clamp(stack.split('\n').slice(0, 12).join('\n'), 2000) });
}
