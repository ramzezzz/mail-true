/**
 * Разбор и подписи для раздела «Помощник ИИ».
 *
 * Вынесено из страницы отдельно по той же причине, что и lib/format.ts:
 * пределы расходов, окна учёта и названия отказов должны проверяться
 * тестами без рендера React. Границы чисел здесь те же, что в схеме
 * сервера (apps/api/src/ai/admin.ts) — чтобы форма не отправляла того,
 * что всё равно будет отвергнуто.
 */
import type { AiFeatureInfo } from '../api/types';

/* ------------------------------------------------------------------ */
/* Окно учёта расходов                                                  */
/* ------------------------------------------------------------------ */

/** Готовые окна учёта. Сервер принимает от 60 000 до 2 592 000 000 мс. */
export const AI_PERIODS = [
  { ms: 3_600_000, label: 'час' },
  { ms: 86_400_000, label: 'сутки' },
  { ms: 604_800_000, label: 'неделя' },
  { ms: 2_592_000_000, label: '30 суток' },
] as const;

export interface PeriodOption {
  ms: number;
  label: string;
}

/** Подпись окна учёта: 86400000 -> «сутки», 7200000 -> «2 ч». */
export function periodLabel(ms: number): string {
  const known = AI_PERIODS.find((period) => period.ms === ms);
  if (known) return known.label;
  if (ms % 3_600_000 === 0) return `${String(ms / 3_600_000)} ч`;
  return `${String(Math.round(ms / 60_000))} мин`;
}

/**
 * Значения для выпадающего меню. Если в базе стоит нестандартное окно
 * (его мог выставить кто-то через API), оно не теряется — показываем
 * его первым пунктом, а не молча подменяем сутками.
 */
export function periodOptions(current: number): PeriodOption[] {
  const list: PeriodOption[] = AI_PERIODS.map((period) => ({ ms: period.ms, label: period.label }));
  if (!list.some((option) => option.ms === current)) {
    list.unshift({ ms: current, label: periodLabel(current) });
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* Разбор чисел из полей формы                                          */
/* ------------------------------------------------------------------ */

/** Результат разбора необязательного предела: значение либо ошибка ввода. */
export type LimitInput = { ok: true; value: number | null } | { ok: false };

/** Пустое поле — «без предела». Иначе целое положительное число. */
export function parseLimit(raw: string): LimitInput {
  const text = raw.trim().replace(/\s/gu, '');
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/u.test(text)) return { ok: false };
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value < 1) return { ok: false };
  return { ok: true, value };
}

/** Обязательное целое в границах сервера. null — введено не то. */
export function parseNumber(raw: string, min: number, max: number): number | null {
  const text = raw.trim().replace(/\s/gu, '');
  if (!/^\d+$/u.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/** Похоже ли введённое на адрес совместимого API. */
export function isValidBaseUrl(raw: string): boolean {
  const text = raw.trim();
  if (text === '') return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Включить помощника без адреса сервиса и модели нельзя: такую строку
 * не примет база, вернётся ошибка. Проверяем до отправки формы.
 */
export function canEnable(baseUrl: string, model: string): boolean {
  return baseUrl.trim() !== '' && model.trim() !== '';
}

/** Полный адрес, на который уйдут письма: база плюс путь метода. */
export function endpointOf(baseUrl: string | null, chatPath: string): string {
  if (!baseUrl) return '— адрес не задан —';
  return `${baseUrl.replace(/\/+$/u, '')}/${chatPath.replace(/^\/+/u, '')}`;
}

/* ------------------------------------------------------------------ */
/* Подписи для журнала                                                  */
/* ------------------------------------------------------------------ */

/** Число с разделением разрядов: 1234567 -> «1 234 567». */
export function formatCount(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** Длительность: 850 -> «850 мс», 12500 -> «12,5 с». */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} мс`;
  const seconds = Math.round(ms / 100) / 10;
  return `${String(seconds).replace('.', ',')} с`;
}

/** Причины отказа (AiErrorKind пакета @mail-true/ai) по-русски. */
const ERROR_LABELS: Readonly<Record<string, string>> = {
  'not-configured': 'настройки неполные',
  'invalid-input': 'нечего обрабатывать',
  'budget-exceeded': 'исчерпан предел расходов',
  'rate-limited': 'сервис попросил реже',
  timeout: 'сервис не ответил вовремя',
  network: 'сеть недоступна',
  http: 'сервис вернул ошибку',
  'bad-response': 'ответ не разобрался',
  aborted: 'вызов прерван',
  'server-off': 'помощник выключен на сервере',
  'no-database': 'нет базы или не применена миграция',
  'domain-off': 'помощник выключен для домена',
  misconfigured: 'настройки неполные',
};

/** Причина отказа человеческим языком; неизвестный код показываем как есть. */
export function errorLabel(kind: string | null): string {
  if (!kind) return '—';
  return ERROR_LABELS[kind] ?? kind;
}

/** Название возможности по технической: «summarize.message» -> «Краткое резюме». */
export function technicalTitle(features: readonly AiFeatureInfo[], technical: string): string {
  const owner = features.find((feature) => feature.technical.includes(technical));
  return owner ? owner.title : technical;
}

/* ------------------------------------------------------------------ */
/* Отрезок времени в фильтре журнала                                    */
/* ------------------------------------------------------------------ */

export const AI_AUDIT_RANGES = [
  { value: 'hour', label: 'За час', ms: 3_600_000 },
  { value: 'day', label: 'За сутки', ms: 86_400_000 },
  { value: 'week', label: 'За неделю', ms: 604_800_000 },
  { value: 'month', label: 'За 30 суток', ms: 2_592_000_000 },
  { value: 'all', label: 'За всё время', ms: null },
] as const;

export type AiAuditRange = (typeof AI_AUDIT_RANGES)[number]['value'];

/** Во что превращается выбор периода: ISO-время или ничего (без границы). */
export function rangeSince(range: AiAuditRange, now = Date.now()): string | undefined {
  const found = AI_AUDIT_RANGES.find((item) => item.value === range);
  if (!found || found.ms === null) return undefined;
  return new Date(now - found.ms).toISOString();
}
