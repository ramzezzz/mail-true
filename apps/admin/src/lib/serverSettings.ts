/**
 * Разбор настроек сервера для экрана «Настройки сервера».
 *
 * Здесь только чистые функции — без React и без запросов, — потому что
 * главное в этом разделе не разметка, а РАЗЛИЧЕНИЕ СОСТОЯНИЙ, и
 * ошибиться в них дороже всего. Разделив, их можно проверить тестами.
 *
 * ------------------------------------------------------------------
 * ЧЕТЫРЕ СОСТОЯНИЯ И ПЯТЫЙ ПРИЗНАК
 * ------------------------------------------------------------------
 *   live    — сохранил и работает.
 *   restart — ОБЕЩАНИЕ: подействует после перезапуска. Свойство самой
 *             настройки, верно всегда, даже когда её никто не трогал.
 *   recreate — то же обещание, но перезапуска мало: значение задаётся
 *             контейнеру при создании, и менять его — пересоздавать
 *             контейнер. Разговор с человеком другой, поэтому и
 *             состояние отдельное.
 *   locked  — из веба не меняется, и рядом обязана стоять ПРИЧИНА.
 *
 * И отдельно от них — pendingRestart. Это не состояние настройки, а ФАКТ
 * о сервере прямо сейчас: значение уже в базе, а живой процесс работает
 * по-старому. Смешивать его с `restart` нельзя: «когда-нибудь понадобится
 * перезапуск» и «перезапуск нужен сейчас, вот из-за этих настроек» —
 * разные сообщения, и второе требует действия, а первое нет.
 */
import type { ServerSetting, ServerSettingsSection, SettingUnit, SettingValue } from '../api/types';
import { formatBytes } from './format';

/* ------------------------------------------------------------------ */
/* Названия состояний                                                   */
/* ------------------------------------------------------------------ */

export type SettingTone = 'ok' | 'warn' | 'fail' | 'muted';

export interface SettingStateLabel {
  text: string;
  tone: SettingTone;
  /** Пояснение при наведении: чем это состояние обернётся на практике. */
  title: string;
}

/** Как называется состояние настройки — то, что стоит на плашке. */
export function stateLabel(setting: ServerSetting): SettingStateLabel {
  if (setting.group === 'locked') {
    return {
      text: 'не меняется из веба',
      tone: 'muted',
      title: setting.reason ?? 'Значение показано для справки.',
    };
  }
  if (setting.group === 'recreate') {
    return {
      text: 'нужно пересоздать контейнер',
      tone: 'warn',
      title:
        'Значение задаётся контейнеру при создании, поэтому обычного перезапуска мало: контейнер пересоздаётся из того же образа.',
    };
  }
  if (setting.group === 'restart') {
    return {
      text: 'нужен перезапуск',
      tone: 'warn',
      title: 'Сохранить можно когда угодно, но подействует после перезапуска контейнера api.',
    };
  }
  return {
    text: 'действует сразу',
    tone: 'ok',
    title: 'Значение читается при каждом обращении: сохранил — работает со следующего запроса.',
  };
}

/** Откуда взято действующее значение — по-человечески. */
export function sourceLabel(setting: ServerSetting): string {
  switch (setting.source) {
    case 'db':
      return 'задано в панели';
    case 'env':
      return 'из окружения (infra/.env)';
    default:
      return 'умолчание продукта';
  }
}

/**
 * Что из источника следует. Строкой ниже подписи и только там, где есть
 * что добавить: у значения из окружения подпись «из окружения (infra/.env)»
 * уже всё сказала, и вторая строка про то же была бы шумом на 133 строки.
 */
export function sourceExplain(setting: ServerSetting): string | null {
  switch (setting.source) {
    case 'db':
      return (
        'Задано здесь и перебивает infra/.env: пока это так, за файлом ' +
        'окружения настройка не следует.'
      );
    case 'default':
      return 'Ни в панели, ни в infra/.env значения нет — действует умолчание продукта.';
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Единицы измерения                                                    */
/* ------------------------------------------------------------------ */

const UNIT_LABELS: Readonly<Record<SettingUnit, string>> = {
  bytes: 'байт',
  ms: 'мс',
  seconds: 'секунд',
  minutes: 'минут',
  hours: 'часов',
  days: 'суток',
  rows: 'строк',
  count: 'шт.',
  perMinute: 'в минуту',
};

/** Подпись справа от поля ввода. Пусто — единицы у настройки нет. */
export function unitLabel(unit: SettingUnit | null): string {
  return unit === null ? '' : UNIT_LABELS[unit];
}

/** Округление до одного знака, запятой — как принято по-русски. */
function round1(value: number): string {
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

/**
 * Перевод числа в привычные единицы: «28800» секунд — это «8 часов».
 *
 * Без этого поля вроде ADMIN_SESSION_TTL_SECONDS = 2592000 не читаются
 * вовсе: понять, месяц это или сутки, можно только с калькулятором.
 * null — переводить нечего (значение и так наглядно).
 */
export function humanValue(unit: SettingUnit | null, value: SettingValue | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  switch (unit) {
    case 'bytes':
      return value === 0 ? null : formatBytes(value);
    case 'ms':
      if (value < 1000) return null;
      return value < 60_000 ? `${round1(value / 1000)} с` : `${round1(value / 60_000)} мин`;
    case 'seconds':
      if (value < 60) return null;
      if (value < 3600) return `${round1(value / 60)} мин`;
      return value < 86_400 ? `${round1(value / 3600)} ч` : `${round1(value / 86_400)} сут`;
    case 'minutes':
      if (value < 60) return null;
      return value < 1440 ? `${round1(value / 60)} ч` : `${round1(value / 1440)} сут`;
    case 'hours':
      return value < 24 ? null : `${round1(value / 24)} сут`;
    default:
      return null;
  }
}

/** Значение в виде текста — для запертых настроек и колонки «умолчание». */
export function valueText(value: SettingValue | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (value === '') return 'пусто';
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Поиск и отбор                                                        */
/* ------------------------------------------------------------------ */

/**
 * Отбор по состоянию. `pending` стоит отдельно от `restart` намеренно:
 * по нему приходят из плашки «нужен перезапуск», и там нужны те самые
 * настройки, из-за которых он нужен, а не все 59 обещаний.
 */
export type SettingFilter =
  'all' | 'live' | 'restart' | 'recreate' | 'pending' | 'locked' | 'changed';

export const FILTER_LABELS: Readonly<Record<SettingFilter, string>> = {
  all: 'Все',
  live: 'Действуют сразу',
  restart: 'Нужен перезапуск',
  recreate: 'Нужно пересоздать контейнер',
  pending: 'Ждут перезапуска',
  locked: 'Не меняются из веба',
  changed: 'Заданные в панели',
};

function matchesFilter(setting: ServerSetting, filter: SettingFilter): boolean {
  switch (filter) {
    case 'live':
      return setting.group === 'live';
    case 'restart':
      return setting.group === 'restart';
    case 'recreate':
      return setting.group === 'recreate';
    case 'pending':
      return setting.pendingRestart;
    case 'locked':
      return setting.group === 'locked';
    case 'changed':
      return setting.source === 'db';
    default:
      return true;
  }
}

/**
 * Поиск идёт и по описанию тоже, а не только по имени ключа. Имена
 * английские и заглавными (SENDER_LOGO_TTL_HOURS): человек, который
 * ищет «логотип», не должен знать их наизусть — ради этого раздел и
 * заведён.
 */
export function matchesSearch(setting: ServerSetting, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    setting.key.toLowerCase().includes(needle) ||
    setting.description.toLowerCase().includes(needle) ||
    (setting.reason ?? '').toLowerCase().includes(needle)
  );
}

export interface FilteredSections {
  sections: ServerSettingsSection[];
  /** Сколько настроек прошло отбор — подпись «найдено N из 133». */
  shown: number;
}

/** Разделы без единой подходящей настройки не показываются вовсе. */
export function filterSections(
  sections: readonly ServerSettingsSection[],
  query: string,
  filter: SettingFilter,
): FilteredSections {
  let shown = 0;
  const kept: ServerSettingsSection[] = [];
  for (const section of sections) {
    const settings = section.settings.filter(
      (item) => matchesFilter(item, filter) && matchesSearch(item, query),
    );
    if (settings.length === 0) continue;
    shown += settings.length;
    kept.push({ ...section, settings });
  }
  return { sections: kept, shown };
}

/* ------------------------------------------------------------------ */
/* Правка значений                                                      */
/* ------------------------------------------------------------------ */

/**
 * Проверка набранного ДО отправки: пределы известны с сервера, и
 * показать «от 60 до 2592000» рядом с полем честнее, чем дать нажать
 * «Сохранить» и вернуть отказ. null — всё в порядке.
 */
export function validate(setting: ServerSetting, draft: SettingValue): string | null {
  if (setting.kind === 'int') {
    const text = String(draft).trim();
    if (text === '') return 'Нужно число.';
    if (!/^-?\d+$/u.test(text)) return 'Только целое число, без пробелов и букв.';
    const number = Number(text);
    if (setting.min !== null && number < setting.min) return `Не меньше ${String(setting.min)}.`;
    if (setting.max !== null && number > setting.max) return `Не больше ${String(setting.max)}.`;
    return null;
  }
  if (setting.kind === 'string' && String(draft).trim() === '') {
    return 'Значение не может быть пустым.';
  }
  return null;
}

/** Изменилось ли набранное по сравнению с тем, что действует сейчас. */
export function isDirty(setting: ServerSetting, draft: SettingValue): boolean {
  if (setting.kind === 'int') return String(draft).trim() !== String(setting.value ?? '');
  return draft !== setting.value;
}

/** Что уходит на сервер: число — числом, «да/нет» — булевым. */
export function toWire(setting: ServerSetting, draft: SettingValue): SettingValue {
  if (setting.kind === 'int') return Number(String(draft).trim());
  return draft;
}
