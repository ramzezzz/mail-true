/**
 * Сроки возврата отложенного письма: «завтра утром», «в понедельник»,
 * «через неделю» и произвольная дата.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СРОКИ СЧИТАЕТ СЕРВЕР, А НЕ БРАУЗЕР
 * ------------------------------------------------------------------
 * Соблазн велик: браузер знает пояс человека, пусть сам и считает
 * «завтра в 8:00», а серверу присылает готовый момент времени. Так делать
 * нельзя по двум причинам, и обе проверяемы.
 *
 * 1. Момент времени приходит СНАРУЖИ. Прислать можно что угодно: год
 *    вперёд, год назад, «через минус сутки». Проверять его всё равно
 *    придётся здесь — а раз так, то и считать проще здесь же, чем сверять
 *    чужой ответ со своим.
 * 2. Готовые сроки — это обещание продукта, а не расчёт клиента. Почта
 *    открыта в трёх местах (окно, телефон, вторая вкладка), и «завтра
 *    утром» обязано означать одно и то же во всех трёх. Три реализации
 *    одного правила разойдутся при первой же правке.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПОЯС ПРИХОДИТ ОТ БРАУЗЕРА
 * ------------------------------------------------------------------
 * «Завтра утром» — это утро ЧЕЛОВЕКА. Сервер стоит в UTC (и обязан там
 * стоять), поэтому его собственное «утро» не значит ничего: письмо,
 * отложенное вечером в Иркутске, вернулось бы среди ночи. Пояс присылает
 * браузер именем IANA (`Intl.DateTimeFormat().resolvedOptions().timeZone`),
 * и по нему считается стенное время, а хранится и сравнивается уже момент.
 *
 * Пояса нет или он не разобран — считаем в UTC и говорим об этом честно
 * (`zoneUsed: null`): ошибиться на несколько часов лучше, чем отказать
 * человеку в возможности отложить письмо.
 *
 * Всё здесь — чистые функции без базы, IMAP и сети: ровно эти правила и
 * должны быть проверены до последнего случая.
 */

/** Готовый срок из меню. */
export type SnoozePreset = 'tomorrow-morning' | 'monday' | 'next-week' | 'custom';

/**
 * Что считается утром — 8:00 по поясу человека.
 *
 * Не «9:00, ведь рабочий день»: письмо должно ждать человека уже открытым,
 * а не приезжать в тот момент, когда он сел за работу. Ровно 8:00 берут и
 * Gmail, и Outlook — это то время, к которому у людей уже сложилась
 * привычка. Число вынесено в константу, потому что оно встречается во всех
 * трёх готовых сроках, и разъехаться им нельзя.
 */
export const SNOOZE_MORNING_HOUR = 8;

/**
 * Ближний край: тридцать секунд.
 *
 * У отложенной ОТПРАВКИ край — минута, и всё, что ближе, считается
 * «отправить сейчас» (см. deferred-send.ts). Здесь так нельзя: «вернуть
 * через минуту» — это законная просьба, а не описка. Тридцать секунд —
 * граница, ниже которой письмо вернулось бы раньше, чем список успел бы
 * обновиться, и человек увидел бы, что кнопка «не сработала».
 */
export const SNOOZE_MIN_DELAY_MS = 30_000;

/**
 * Дальний край: год.
 *
 * У отложенной отправки он тридцать суток, и это НЕ произвол, а следствие
 * хранения пароля ящика в очереди: чем дальше край, тем дольше пароль
 * лежит. Здесь пароля нет вовсе — возврат делает служебный пользователь
 * Dovecot, — поэтому та причина не применима, и край можно ставить по
 * здравому смыслу. Год берёт Яндекс, и год покрывает всё, ради чего письма
 * откладывают: «после отпуска», «к началу года», «когда закончится договор».
 */
export const SNOOZE_MAX_DELAY_MS = 365 * 24 * 3600 * 1000;

/** Разбор стенных часов в заданном поясе. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 — понедельник, 7 — воскресенье (как в ISO 8601). */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Стенные часы момента в указанном поясе. null — пояс неизвестен.
 *
 * Через Intl, а не через смещение в минутах: смещение меняется дважды
 * в год, и «прибавить три часа» ломается ровно в те выходные, когда
 * переводят стрелки. Intl знает правила перехода целиком.
 */
export function zonedParts(date: Date, timeZone: string | null): ZonedParts | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    }).formatToParts(date);
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const out: ZonedParts = {
      year: Number(pick('year')),
      month: Number(pick('month')),
      day: Number(pick('day')),
      hour: Number(pick('hour')),
      minute: Number(pick('minute')),
      second: Number(pick('second')),
      weekday: WEEKDAY_INDEX[pick('weekday')] ?? 0,
    };
    if (!Number.isFinite(out.year) || out.weekday === 0) return null;
    return out;
  } catch {
    // Неизвестное имя пояса. Не авария: см. заголовок файла.
    return null;
  }
}

/** Насколько стенные часы пояса опережают UTC в этот момент, мс. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  if (!parts) return 0;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Секунды миллисекунд Intl не отдаёт — округляем до секунды, иначе
  // смещение «дрожало» бы на доли секунды и сравнения плыли.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Обратное преобразование: стенные часы пояса -> момент времени.
 *
 * Двухшаговое, и это не перестраховка. Смещение пояса зависит от момента,
 * а момент — это как раз то, что мы ищем. Первый шаг даёт приближение по
 * смещению «в районе искомого времени», второй уточняет его уже в найденной
 * точке. Разойтись эти два шага могут только на переводе стрелок — ровно
 * там, где однократный расчёт и ошибается на час.
 */
export function fromZonedWallClock(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string | null,
): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  if (!timeZone) return new Date(naive);
  let stamp = naive - zoneOffsetMs(new Date(naive), timeZone);
  stamp = naive - zoneOffsetMs(new Date(stamp), timeZone);
  return new Date(stamp);
}

/** Что вышло из просьбы отложить письмо. */
export type SnoozeCheck =
  | { kind: 'at'; at: Date; preset: SnoozePreset; zoneUsed: string | null }
  | { kind: 'invalid'; reason: string };

/** Пояс годится, только если Intl его понимает. */
export function usableZone(timeZone: string | null | undefined): string | null {
  const name = (timeZone ?? '').trim();
  if (name === '') return null;
  return zonedParts(new Date(), name) ? name : null;
}

/**
 * Момент, в который вернётся письмо по готовому сроку.
 *
 * Утро всегда БУДУЩЕЕ: «завтра утром», нажатое в 3 часа ночи, — это утро
 * наступающего дня, а не сегодняшнее восьмичасовое, которое ещё не
 * настало... и не вчерашнее, которое уже прошло. Проверка на «раньше чем
 * сейчас» стоит после расчёта каждого срока, потому что попасть в прошлое
 * можно только у «завтра утром» и только на переводе стрелок, — но попасть
 * туда молча нельзя.
 */
export function presetWakeTime(
  preset: Exclude<SnoozePreset, 'custom'>,
  now: Date,
  timeZone: string | null,
): Date {
  const local = zonedParts(now, timeZone) ?? {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    second: now.getUTCSeconds(),
    weekday: ((now.getUTCDay() + 6) % 7) + 1,
  };

  let daysAhead: number;
  switch (preset) {
    case 'tomorrow-morning':
      daysAhead = 1;
      break;
    case 'monday':
      // Ближайший СЛЕДУЮЩИЙ понедельник. Если сегодня понедельник, человек
      // имеет в виду понедельник будущей недели: «в понедельник», сказанное
      // в понедельник, никогда не значит «через два часа».
      daysAhead = 8 - local.weekday;
      if (daysAhead > 7) daysAhead -= 7;
      if (local.weekday === 1) daysAhead = 7;
      break;
    case 'next-week':
      daysAhead = 7;
      break;
  }

  // Сложение по календарю, а не по миллисекундам: «+24 часа» в сутки
  // перевода стрелок даёт 7:00 или 9:00 вместо восьми.
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + daysAhead));
  return fromZonedWallClock(
    {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
      hour: SNOOZE_MORNING_HOUR,
      minute: 0,
    },
    timeZone,
  );
}

export interface SnoozeRequest {
  preset?: string | undefined;
  /** Произвольный срок (ISO). Используется при preset === 'custom'. */
  until?: string | undefined;
  /** Имя пояса IANA от браузера. */
  timeZone?: string | undefined;
}

/**
 * Проверяет просьбу отложить письмо и превращает её в момент времени.
 *
 * Отказ — это строка на русском, а не код: её показывают человеку прямо
 * в списке писем, и «SNOOZE_RANGE» ему ничего не объяснит.
 */
export function checkSnoozeRequest(request: SnoozeRequest, now: Date): SnoozeCheck {
  const zone = usableZone(request.timeZone);
  const preset = (request.preset ?? (request.until ? 'custom' : '')) as SnoozePreset | '';

  let at: Date;
  if (preset === 'tomorrow-morning' || preset === 'monday' || preset === 'next-week') {
    at = presetWakeTime(preset, now, zone);
  } else if (preset === 'custom') {
    if (!request.until) return { kind: 'invalid', reason: 'Не указан срок возврата письма' };
    at = new Date(request.until);
    if (Number.isNaN(at.getTime())) {
      return { kind: 'invalid', reason: 'Не удалось разобрать срок возврата письма' };
    }
  } else {
    return { kind: 'invalid', reason: 'Не указан срок возврата письма' };
  }

  const delay = at.getTime() - now.getTime();
  if (delay < SNOOZE_MIN_DELAY_MS) {
    return {
      kind: 'invalid',
      reason: 'Этот срок уже наступил — выберите время хотя бы на минуту вперёд',
    };
  }
  if (delay > SNOOZE_MAX_DELAY_MS) {
    return { kind: 'invalid', reason: 'Отложить письмо можно не больше чем на год' };
  }
  return { kind: 'at', at, preset, zoneUsed: zone };
}
