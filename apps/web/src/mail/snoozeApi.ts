/**
 * «Отложить письмо до срока» — обращения к серверу и слова, которыми это
 * называется в интерфейсе.
 *
 * Отдельным файлом, а не внутри общего клиента API (api/client.ts), по той
 * же причине, по какой отдельно живут настройки и подключённые ящики:
 * возможность целиком принадлежит работе со списком писем и не должна
 * появляться в интерфейсе, пока сервер не сказал, что она у него есть.
 *
 * СРОК СЧИТАЕТ СЕРВЕР. Отсюда уходит только название готового срока
 * («завтра утром») и имя часового пояса браузера; момент времени приходит
 * обратно уже посчитанным. Так «завтра утром» означает одно и то же в окне,
 * в телефоне и во второй вкладке — см. apps/api/src/mail/snooze-schedule.ts.
 */

import { useMocks } from '../api/mockFlag';
import { apiFetch } from '../api/http';

/** Готовые сроки из меню. */
export type SnoozePreset = 'tomorrow-morning' | 'monday' | 'next-week' | 'custom';

/** Строка списка «Отложенных». */
export interface SnoozedItem {
  /** Составной идентификатор письма в папке «Отложенные». */
  id: string;
  subject: string;
  from: string;
  /** Когда вернётся (ISO). Пусто — срока нет, см. `orphan`. */
  wakeAt: string;
  preset: string;
  originPath: string;
  /**
   * Письмо лежит в «Отложенных», а срока у него нет: его положили туда
   * руками или перенос оборвался. Само оно не вернётся — и говорить об
   * этом надо прямо, а не молчать.
   */
  orphan: boolean;
}

export interface SnoozedState {
  /**
   * Возможность есть. Ложь — кнопки «Отложить» в интерфейсе НЕ ПОЯВЛЯЕТСЯ
   * вовсе: общее правило продукта — кнопка появляется вместе с поведением.
   */
  available: boolean;
  /** Возврат по расписанию работает (настроен служебный доступ Dovecot). */
  scheduledReturn: boolean;
  reason: string | null;
  items: SnoozedItem[];
}

export interface SnoozeRequest {
  ids: string[];
  preset?: SnoozePreset;
  /** Произвольный срок (ISO) — при preset === 'custom'. */
  until?: string;
}

/**
 * Часовой пояс браузера именем IANA.
 *
 * Именно имя, а не смещение в минутах: смещение меняется дважды в год, и
 * «завтра утром», назначенное в субботу перед переводом стрелок, приехало
 * бы на час мимо. По имени сервер знает правила перехода целиком.
 */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Возможности нет, пока сервер не сказал обратного. */
export const SNOOZE_UNAVAILABLE: SnoozedState = {
  available: false,
  scheduledReturn: false,
  reason: null,
  items: [],
};

/**
 * Обращения к серверу — одним объектом, а не россыпью функций.
 *
 * Ровно так же устроен основной клиент API (api/index.ts): за объектом
 * можно подставить другую реализацию. Здесь это нужно проверкам —
 * убедиться, что кнопка «Отложить» НЕ появляется, пока сервер молчит,
 * иначе нельзя.
 */
export const snoozeApi = {
  async fetchSnoozed(): Promise<SnoozedState> {
    /*
     * На заглушках интерфейса запроса нет вовсе.
     *
     * Своей очереди отложенных писем у них нет, а сходить на настоящий
     * адрес нельзя: без сессии он ответит 401, и общий обработчик уведёт
     * человека на экран входа — из режима, в котором никакого входа и не
     * предполагается. Возвращаем «возможности нет»: кнопка не появится,
     * и это честно — за ней действительно ничего не стоит.
     */
    if (useMocks) return SNOOZE_UNAVAILABLE;
    return apiFetch<SnoozedState>('/api/messages/snoozed');
  },

  async snoozeMessages(request: SnoozeRequest): Promise<{ snoozed: number; wakeAt: string }> {
    return apiFetch('/api/messages/snooze', {
      method: 'POST',
      body: JSON.stringify({ ...request, timeZone: browserTimeZone() }),
    });
  },

  /** «Вернуть сейчас» — не дожидаясь срока. */
  async unsnoozeMessages(ids: string[]): Promise<{ returned: number }> {
    return apiFetch('/api/messages/snooze', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    });
  },
};

/* ------------------------------------------------------------------ */
/* Слова                                                               */
/* ------------------------------------------------------------------ */

/** Названия готовых сроков — ровно то, что человек видит в меню. */
export const PRESET_TITLES: Record<Exclude<SnoozePreset, 'custom'>, string> = {
  'tomorrow-morning': 'Завтра утром',
  monday: 'В понедельник',
  'next-week': 'Через неделю',
};

const WEEKDAYS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среду',
  'четверг',
  'пятницу',
  'субботу',
];

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Подсказка срока для меню и для строки списка.
 *
 * Называется человеческим языком, а не датой: «завтра в 08:00» читается
 * с одного взгляда, «06.08.2026, 08:00» — нет. Дальше недели язык уже
 * не помогает («через 43 дня» ничего не говорит), и тогда пишется дата.
 *
 * Считается по часам БРАУЗЕРА, потому что показывается человеку: сервер
 * прислал момент времени, а в какой день недели этот момент попадает —
 * зависит от того, где человек сидит.
 */
export function formatWakeAt(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);

  if (days <= 0) return `сегодня в ${hhmm(at)}`;
  if (days === 1) return `завтра в ${hhmm(at)}`;
  if (days < 7) return `в ${WEEKDAYS[at.getDay()] ?? ''} в ${hhmm(at)}`;
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${String(at.getFullYear())}`;
  return `${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ''}${year} в ${hhmm(at)}`;
}

/**
 * Значение для поля «дата и время» — местные часы, а не UTC.
 *
 * `toISOString()` здесь не годится: он отдаёт UTC, и поле показало бы
 * человеку в Москве на три часа меньше того, что он выбрал.
 */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Значение поля «дата и время» -> момент времени. Пусто/мусор — null. */
export function fromLocalInputValue(value: string): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Что предложить в поле произвольной даты по умолчанию: завтра в 8 утра. */
export function defaultCustomWake(now: Date = new Date()): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0);
  return at;
}
