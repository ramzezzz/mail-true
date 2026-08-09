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

/* ------------------------------------------------------------------ */
/* Куда вообще можно подключиться                                       */
/* ------------------------------------------------------------------ */

/**
 * ГОТОВЫЕ ВАРИАНТЫ.
 *
 * Поле называлось «Адрес совместимого API», и это всё, что человек о нём
 * узнавал. Совместимого с чем? Что туда писать — «claude», «chatgpt»,
 * «ollama»? Ответ был только в документации, а до неё из этого экрана
 * ничего не вело.
 *
 * Совместимость здесь одна: OpenAI Chat Completions — тот самый формат,
 * ради которого рядом стоит поле «Путь метода» со значением
 * /chat/completions. Поэтому вместо пустого поля — список того, что
 * действительно подходит, с готовыми адресами и примерами моделей.
 *
 * Сервисы со СВОИМ форматом (GigaChat, YandexGPT) сюда не годятся, и
 * честнее сказать это списком, чем оставить человека выяснять опытным
 * путём.
 */
export interface AiPreset {
  id: string;
  title: string;
  /** Адрес, который подставится в поле. */
  baseUrl: string;
  /** Пример названия модели — его человек всё равно уточняет у себя. */
  model: string;
  /** Нужен ли ключ доступа. */
  needsKey: boolean;
  /** Уходят ли письма за пределы сервера. */
  local: boolean;
  /** Что это и когда выбирать. */
  hint: string;
}

export const AI_PRESETS: readonly AiPreset[] = [
  {
    id: 'ollama',
    title: 'Ollama на этом же сервере',
    baseUrl: 'http://host.docker.internal:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    local: true,
    hint:
      'Модель работает рядом с почтой, переписка не покидает сервер. Нужны свободная память ' +
      'и место под модель: 7B в четырёхбитном сжатии — около 5 ГБ.',
  },
  {
    id: 'lmstudio',
    title: 'LM Studio на этом же сервере',
    baseUrl: 'http://host.docker.internal:1234/v1',
    model: 'qwen2.5-7b-instruct',
    needsKey: false,
    local: true,
    hint: 'То же самое, если модель поднята через LM Studio.',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    local: false,
    hint: 'Внешний сервис: содержимое писем уходит за пределы вашего сервера. Нужен ключ доступа.',
  },
  {
    id: 'anthropic',
    title: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    needsKey: true,
    local: false,
    hint:
      'Внешний сервис. Работает через совместимый с OpenAI слой Anthropic — отдельной настройки ' +
      'это не требует, но ключ нужен.',
  },
  {
    id: 'custom',
    title: 'Другой совместимый сервис',
    baseUrl: '',
    model: '',
    needsKey: false,
    local: false,
    hint:
      'Любой сервис, отвечающий в формате OpenAI Chat Completions: vLLM, llama.cpp server, ' +
      'локальный шлюз организации. GigaChat и YandexGPT напрямую НЕ подходят — у них свой формат.',
  },
];

/**
 * ПОКИДАЮТ ЛИ ПИСЬМА ПЕРИМЕТР — вычисляется, а не объявляется.
 *
 * Раньше это была галочка, которую администратор ставил сам, и она не
 * проверяла ничего: меняла только текст, который видит пользователь
 * почты — «письма не покидают периметр» против «уйдёт наружу». То есть
 * можно было указать api.openai.com, поставить галочку и сказать людям
 * неправду ровно там, где они решают, доверить письмо или нет.
 *
 * Теперь ответ следует из адреса: петля и частные сети — внутри
 * периметра, всё остальное — снаружи. Обмануть это можно только уведя
 * трафик через свой прокси в частной сети, но тогда за периметр отвечает
 * тот, кто этот прокси поставил, — и он знает, что делает.
 *
 * ЗДЕСЬ — ТОЛЬКО ПОДСКАЗКА В ФОРМЕ. Пока вывод жил в одном лишь браузере,
 * а маршрут принимал признак булевым полем, запрос мимо формы (curl,
 * старая сборка админки, скрипт) записывал «внутри периметра» при
 * внешнем адресе — и обещание на экране согласия становилось неправдой
 * сразу для всего домена. Настоящий ответ теперь даёт сервер: тот же
 * вывод сделан в пакете помощника (packages/ai/src/perimeter.ts), поле
 * `local` в запросе не принимается вовсе, а показанное здесь значение
 * ни на что не влияет, кроме текста рядом с полем адреса. Правки надо
 * вносить в оба места разом — их сходство закреплено тестами
 * (tests/aiPresets.test.ts и packages/ai assistant.test.ts).
 */
export function isInsidePerimeter(baseUrl: string): boolean {
  const text = baseUrl.trim();
  if (text === '') return false;
  let host = '';
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return false;
  }

  // Имена, которыми контейнер зовёт соседей и саму машину.
  if (host === 'localhost' || host === 'host.docker.internal') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // Имя без точек — это сосед по сети контейнеров (ollama, llm, gateway).
  if (!host.includes('.') && !host.includes(':')) return true;

  if (host === '::1' || host === '[::1]') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  return false;
}
