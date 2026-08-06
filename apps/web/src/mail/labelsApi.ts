/**
 * Свои метки: обращения к API и словарь цветов.
 *
 * Метка живёт в письме ключевым словом IMAP, а её имя и цвет — в справочнике
 * на сервере (`GET /api/labels`). Поэтому в строке списка нельзя показать
 * метку, пока справочник не приехал: у ключа `mt-oplatit` нет ни имени, ни
 * цвета, а придумывать их интерфейс не вправе.
 */

import { apiFetch, buildQuery } from '../api/http';

/**
 * Цвет метки — идентификатор из закрытого набора, а не строка `#ff0000`.
 * Тот же набор проверяет сервер (apps/api/src/mail/labels.ts): цвет
 * попадает в разметку, и произвольное значение из базы означало бы, что
 * туда доезжает ввод пользователя.
 */
export const LABEL_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'gray',
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const DEFAULT_LABEL_COLOR: LabelColor = 'blue';

/** Названия цветов для выбора в настройках и для подсказки к пилюле. */
export const LABEL_COLOR_TITLES: Record<LabelColor, string> = {
  red: 'Красный',
  orange: 'Оранжевый',
  yellow: 'Жёлтый',
  green: 'Зелёный',
  teal: 'Бирюзовый',
  blue: 'Синий',
  violet: 'Фиолетовый',
  pink: 'Розовый',
  gray: 'Серый',
};

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && (LABEL_COLORS as readonly string[]).includes(value);
}

export interface MailLabel {
  /** Ключевое слово IMAP, лежащее в письме. Не меняется никогда. */
  key: string;
  name: string;
  color: LabelColor;
  position: number;
}

/**
 * Состояние возможности целиком.
 *
 * `available: false` значит, что справочника нет (не настроена база или не
 * применена миграция). Тогда интерфейс УБИРАЕТ раздел и пункты меню, а не
 * показывает их и потом отказывает — то же правило, что у отложенных писем.
 */
export interface LabelsState {
  available: boolean;
  reason: string | null;
  items: MailLabel[];
}

export interface LabelDraft {
  name: string;
  color: LabelColor;
}

/** Что сделали с письмами при удалении метки — это показывается человеку. */
export interface LabelDeleteResult {
  ok: boolean;
  key: string;
  purged: boolean;
  removedFromMessages: number;
}

export interface ApplyLabelsRequest {
  ids: string[];
  add?: string[];
  remove?: string[];
}

export interface ApplyLabelsResult {
  updated: number;
  added: string[];
  removed: string[];
}

export const labelsApi = {
  getLabels: (): Promise<LabelsState> => apiFetch('/api/labels'),

  createLabel: (draft: LabelDraft): Promise<MailLabel> =>
    apiFetch('/api/labels', { method: 'POST', body: JSON.stringify(draft) }),

  updateLabel: (key: string, patch: Partial<LabelDraft>): Promise<MailLabel> =>
    apiFetch(`/api/labels/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * Удаление метки. `purge` — это ответ человека на вопрос «что будет
   * с помеченными письмами»: снять слово с писем или оставить его там.
   * Значения по умолчанию нет намеренно — вопрос обязан быть задан.
   */
  deleteLabel: (key: string, purge: boolean): Promise<LabelDeleteResult> =>
    apiFetch(
      `/api/labels/${encodeURIComponent(key)}${buildQuery({ purge: purge ? '1' : '0' })}`,
      { method: 'DELETE' },
    ),

  applyLabels: (request: ApplyLabelsRequest): Promise<ApplyLabelsResult> =>
    apiFetch('/api/messages/labels', { method: 'POST', body: JSON.stringify(request) }),
};

/** Метки письма в порядке справочника — по ключевым словам письма. */
export function labelsOfMessage(
  keywords: readonly string[],
  dictionary: readonly MailLabel[],
): MailLabel[] {
  const lower = new Set(keywords.map((k) => k.toLowerCase()));
  return dictionary.filter((label) => lower.has(label.key.toLowerCase()));
}

/**
 * Состояние метки на выделенных письмах: у всех, у части или ни у кого.
 *
 * Три состояния, а не два, потому что выделены бывают разные письма.
 * Показывать «не отмечено» там, где метка стоит на половине выделения,
 * значило бы врать: нажатие сняло бы её с той половины, где она была.
 */
export type LabelPresence = 'all' | 'some' | 'none';

export function labelPresence(
  messages: readonly { labels: readonly string[] }[],
  key: string,
): LabelPresence {
  if (messages.length === 0) return 'none';
  const lower = key.toLowerCase();
  let hits = 0;
  for (const message of messages) {
    if (message.labels.some((l) => l.toLowerCase() === lower)) hits += 1;
  }
  if (hits === 0) return 'none';
  return hits === messages.length ? 'all' : 'some';
}

/*
 * Метки СТРОКИ списка (у переписки — объединение по всему разговору)
 * живут в mail/threadList.ts, рядом с флажком и скрепкой строки: правило
 * у них одно на троих, и считает его сервер в сводке переписки.
 */

/**
 * Что сделает нажатие по метке в меню.
 *
 * «Часть писем помечена» превращается в «пометить все»: человек, нажавший
 * на метку в наполовину помеченном выделении, хочет пометить остальные,
 * а не снять со всех. Так же ведут себя Gmail и Thunderbird.
 */
export function nextLabelAction(presence: LabelPresence): 'add' | 'remove' {
  return presence === 'all' ? 'remove' : 'add';
}
