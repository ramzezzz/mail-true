/**
 * Шаблон подписи для групповой установки из админки.
 *
 * Зачем отдельный модуль, а не подстановка «в лоб» строкой на сервере:
 * подпись пишется в ЧУЖОЙ ящик, и цена ошибки здесь выше обычной. Три
 * случая, ради которых всё это и написано:
 *
 *   1. Опечатка в имени подстановки. Наивная замена оставляет `{{долность}}`
 *      как есть — и полторы сотни человек уходят подписывать письма
 *      двойными фигурными скобками. Поэтому неизвестные подстановки
 *      выделяются отдельно, а маршрут применения на них отказывает.
 *   2. Пустое значение. У половины ящиков не заполнено display_name, и
 *      шаблон «{{имя}}\n{{должность}}» даёт подпись, начинающуюся с пустой
 *      строки. Молча подставлять адрес вместо имени тоже нельзя — это
 *      уже не то, что просил администратор. Поэтому пустые подстановки
 *      перечисляются, а такие ящики по умолчанию пропускаются.
 *   3. Предпросмотр обязан показывать РОВНО то, что будет записано, —
 *      значит, отрисовкой должен заниматься один и тот же код и в
 *      предпросмотре, и при применении.
 *
 * Модуль лежит в packages/shared, потому что нужен обеим сторонам: сервер
 * пишет подписи, админка показывает предпросмотр и подсказывает список
 * доступных подстановок.
 */

/* ------------------------------------------------------------------ */
/* Список подстановок                                                   */
/* ------------------------------------------------------------------ */

/** Подстановки, значения которых берутся из карточки ящика. */
export const SIGNATURE_USER_VARIABLES = ['имя', 'адрес', 'логин', 'домен'] as const;

/**
 * Подстановки, которых в базе нет: должность, отдел и прочее нигде не
 * хранится. Их значение задаёт администратор один раз на всю рассылку —
 * иначе пришлось бы заводить в почтовом сервере кадровый учёт.
 */
export const SIGNATURE_EXTRA_VARIABLES = ['должность', 'отдел', 'компания', 'телефон'] as const;

export type SignatureUserVariable = (typeof SIGNATURE_USER_VARIABLES)[number];
export type SignatureExtraVariable = (typeof SIGNATURE_EXTRA_VARIABLES)[number];
export type SignatureVariable = SignatureUserVariable | SignatureExtraVariable;

/** Все известные подстановки одним списком — в порядке показа в интерфейсе. */
export const SIGNATURE_VARIABLES: readonly SignatureVariable[] = [
  ...SIGNATURE_USER_VARIABLES,
  ...SIGNATURE_EXTRA_VARIABLES,
];

/** Пояснение к каждой подстановке для подсказки в интерфейсе. */
export const SIGNATURE_VARIABLE_HINTS: Readonly<Record<SignatureVariable, string>> = {
  имя: 'Имя из карточки ящика (display_name)',
  адрес: 'Полный почтовый адрес',
  логин: 'Часть адреса до «собаки»',
  домен: 'Часть адреса после «собаки»',
  должность: 'Общее значение для всей рассылки',
  отдел: 'Общее значение для всей рассылки',
  компания: 'Общее значение для всей рассылки',
  телефон: 'Общее значение для всей рассылки',
};

/** Значения подстановок: имя подстановки -> подставляемый текст. */
export type SignatureValues = Readonly<Record<string, string>>;

/* ------------------------------------------------------------------ */
/* Разбор шаблона                                                       */
/* ------------------------------------------------------------------ */

/**
 * Что считается подстановкой: `{{имя}}`, `{{ имя }}`.
 *
 * Пробелы внутри скобок терпим намеренно: человек их ставит, а отказ
 * «неизвестная подстановка « имя »» выглядел бы издевательством.
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Имена всех подстановок шаблона в порядке появления, без повторов. */
export function signaturePlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Подстановки, которых мы не знаем. Пусто — шаблон можно применять. */
export function unknownSignaturePlaceholders(template: string): string[] {
  return signaturePlaceholders(template).filter(
    (name) => !(SIGNATURE_VARIABLES as readonly string[]).includes(name),
  );
}

/**
 * Отказ по шаблону человеческими словами; null — шаблон годится.
 * Возвращается интерфейсу как есть: у zod на всё одна общая фраза,
 * а тут важно назвать саму опечатку.
 */
export function signatureTemplateProblem(template: string): string | null {
  if (template.trim() === '') return 'Шаблон подписи пуст';
  const unknown = unknownSignaturePlaceholders(template);
  if (unknown.length > 0) {
    return (
      `Неизвестные подстановки: ${unknown.map((n) => `{{${n}}}`).join(', ')}. ` +
      `Доступны: ${SIGNATURE_VARIABLES.map((n) => `{{${n}}}`).join(', ')}`
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Отрисовка                                                            */
/* ------------------------------------------------------------------ */

export interface RenderedSignature {
  /** Готовый текст подписи. */
  text: string;
  /** Использованные подстановки, значение которых пусто. */
  empty: string[];
  /** Использованные подстановки, которых мы не знаем (остались как есть). */
  unknown: string[];
}

/**
 * Подставляет значения в шаблон.
 *
 * Неизвестные подстановки НЕ вычищаются: их видно в предпросмотре, и это
 * лучше, чем тихо съеденный кусок текста. Применение такого шаблона
 * запрещено отдельно (см. signatureTemplateProblem).
 */
export function renderSignatureTemplate(
  template: string,
  values: SignatureValues,
): RenderedSignature {
  const empty: string[] = [];
  const unknown: string[] = [];
  const text = template.replace(PLACEHOLDER, (raw: string, rawName: string) => {
    const name = rawName.trim();
    if (name === '') return raw;
    if (!(SIGNATURE_VARIABLES as readonly string[]).includes(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      return raw;
    }
    const value = (values[name] ?? '').trim();
    if (value === '') {
      if (!empty.includes(name)) empty.push(name);
      return '';
    }
    return value;
  });
  return { text, empty, unknown };
}

/** Ящик в том виде, в каком его знает подстановка. */
export interface SignatureTemplateAccount {
  email: string;
  displayName: string | null;
}

/**
 * Значения подстановок для одного ящика.
 *
 * Общие значения (должность, отдел…) добавляются как есть — они одни
 * на всю рассылку. Значения из карточки ящика перекрыть нельзя: иначе
 * «предпросмотр на конкретном человеке» перестал бы что-либо доказывать.
 */
export function signatureValuesFor(
  account: SignatureTemplateAccount,
  extras: SignatureValues = {},
): Record<string, string> {
  const email = account.email.trim();
  const at = email.lastIndexOf('@');
  const values: Record<string, string> = {};
  for (const name of SIGNATURE_EXTRA_VARIABLES) values[name] = (extras[name] ?? '').trim();
  values['имя'] = (account.displayName ?? '').trim();
  values['адрес'] = email;
  values['логин'] = at > 0 ? email.slice(0, at) : email;
  values['домен'] = at > 0 ? email.slice(at + 1) : '';
  return values;
}

/** Отрисовка шаблона для конкретного ящика — то, что уйдёт в базу. */
export function renderSignatureFor(
  template: string,
  account: SignatureTemplateAccount,
  extras: SignatureValues = {},
): RenderedSignature {
  return renderSignatureTemplate(template, signatureValuesFor(account, extras));
}

/* ------------------------------------------------------------------ */
/* Что делать с уже существующими подписями                             */
/* ------------------------------------------------------------------ */

/**
 * Как поступить с подписями, которые у человека уже есть.
 *
 * Значения по умолчанию нет намеренно: молча затирать чужую подпись
 * нельзя, а любое из трёх поведений при выборе «за администратора»
 * оказалось бы затиранием либо неожиданным вторым экземпляром.
 */
export const SIGNATURE_BULK_MODES = ['replace', 'append', 'skip-existing'] as const;
export type SignatureBulkMode = (typeof SIGNATURE_BULK_MODES)[number];

/** Что произойдёт с ящиком при выбранном режиме. */
export type SignatureBulkOutcome = 'add' | 'replace' | 'skip-existing' | 'skip-incomplete';

export const SIGNATURE_BULK_MODE_LABELS: Readonly<Record<SignatureBulkMode, string>> = {
  replace: 'Заменить все существующие подписи',
  append: 'Добавить ещё одну подпись, существующие оставить',
  'skip-existing': 'Пропустить тех, у кого подпись уже есть',
};

/**
 * Что случится с одним ящиком: решение принимается ДО записи и
 * показывается в предпросмотре ровно в этом виде.
 *
 * `incomplete` — в шаблоне использована подстановка, значения которой у
 * этого человека нет (чаще всего незаполненное имя). Такой ящик
 * пропускается: подпись «\nМенеджер» хуже отсутствия подписи.
 */
export function signatureBulkOutcome(
  mode: SignatureBulkMode,
  hasSignatures: boolean,
  incomplete: boolean,
): SignatureBulkOutcome {
  if (incomplete) return 'skip-incomplete';
  if (!hasSignatures) return 'add';
  if (mode === 'skip-existing') return 'skip-existing';
  return mode === 'replace' ? 'replace' : 'add';
}

export const SIGNATURE_OUTCOME_LABELS: Readonly<Record<SignatureBulkOutcome, string>> = {
  add: 'подпись будет добавлена',
  replace: 'существующие подписи будут заменены',
  'skip-existing': 'пропущен: подпись уже есть',
  'skip-incomplete': 'пропущен: не хватает данных для подстановки',
};
