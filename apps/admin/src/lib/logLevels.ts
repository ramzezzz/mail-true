/**
 * Уровни журнала и их цвета — единый источник истины.
 *
 * Отсюда берут значения:
 *   - раскраска строк журнала (styles/logLevels.css, переменные --mt-log-*);
 *   - подписи уровней в интерфейсе и порядок в переключателе;
 *   - проверка контраста tests/logContrast.test.ts, которая СЧИТАЕТ пары по
 *     формуле WCAG, а не сверяет строки: цвет, подкрученный «на глаз», она
 *     заметит.
 *
 * ------------------------------------------------------------------
 * ОТКУДА ЦВЕТА
 * ------------------------------------------------------------------
 * Из палитры токенов, а не с потолка. Основа:
 *   ошибка         --mt-color-accent-red    #ED330A
 *   предупреждение --mt-color-accent-orange #FF9E00
 *   событие        --mt-color-text-primary
 *   подробность    --mt-color-text-secondary
 *
 * Сырые акцентные цвета подобраны под крупный текст и заливку кнопок, а
 * строка журнала — это 12px моноширинного текста на цветной подложке.
 * Поэтому берутся те же цвета, доведённые до нормы 4,5:1, — ровно так же,
 * как это уже сделано для значков состояния (--mt-admin-ok/warn/fail
 * в styles/admin.css). Для тёмной темы цвета не «инвертированы», а взяты
 * светлыми оттенками тех же тонов на тёмной подложке: светлых подложек
 * negative-tint/warning-tint в тёмной теме нет вовсе, и оставить их
 * означало бы почти белую полосу посреди тёмного экрана.
 *
 * ------------------------------------------------------------------
 * ЦВЕТ — НЕ ЕДИНСТВЕННЫЙ ПРИЗНАК
 * ------------------------------------------------------------------
 * У каждой строки, кроме цвета, есть подпись уровня словом и полоса слева.
 * Человек, не различающий красный и зелёный, читает журнал ровно так же:
 * цветом здесь ничего не сообщается ЕДИНСТВЕННЫМ способом.
 */

/** Уровень строки журнала. Те же четыре ступени, что у сервера. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Пара «текст на подложке» для одной темы. */
export interface LevelColors {
  /** Цвет текста строки. */
  text: string;
  /** Подложка строки. */
  background: string;
}

export interface LevelMeta {
  id: LogLevel;
  /** Как называется уровень в переключателе. */
  title: string;
  /** Короткая пометка в самой строке. */
  short: string;
  /** Что значит выбрать этот порог. */
  hint: string;
  light: LevelColors;
  dark: LevelColors;
}

/**
 * Уровни от важного к подробному. Порядок значимый: выбранный уровень
 * показывает себя и всё, что выше него в этом списке.
 */
export const LOG_LEVELS: readonly LevelMeta[] = [
  {
    id: 'error',
    title: 'Ошибки',
    short: 'ошибка',
    hint: 'Только то, из-за чего почта не дошла',
    // #C42500 — тот же тон, что --mt-color-accent-red, доведённый до нормы;
    // подложка — штатный --mt-color-background-negative-tint.
    light: { text: '#c42500', background: '#feefeb' },
    dark: { text: '#ff9c85', background: '#3b1f1a' },
  },
  {
    id: 'warn',
    title: 'Предупреждения',
    // Коротко и не «предупреждение»: длинное слово в 11px занимало полстроки
    // и на 768 наезжало на сам текст сообщения — проверено на стенде.
    short: 'внимание',
    hint: 'Ошибки и то, что отложено или отбито на приёме',
    // #8A5200 — --mt-color-accent-orange, доведённый до нормы;
    // подложка — штатный --mt-color-background-warning-tint.
    light: { text: '#8a5200', background: '#fffce0' },
    dark: { text: '#f5c164', background: '#362b12' },
  },
  {
    id: 'info',
    title: 'События',
    short: 'событие',
    hint: 'Обычная жизнь сервера: приём, доставка, отправка',
    // Обычная строка не красится вовсе: фон карточки и основной текст.
    light: { text: '#2c2d2e', background: '#ffffff' },
    dark: { text: '#e1e3e6', background: '#232324' },
  },
  {
    id: 'debug',
    title: 'Подробности',
    short: 'отладка',
    hint: 'Всё, включая отладочные записи служб',
    light: { text: '#63666b', background: '#f6f7f8' },
    dark: { text: '#9ea1a6', background: '#2a2b2c' },
  },
];

export const LEVEL_IDS: readonly LogLevel[] = LOG_LEVELS.map((level) => level.id);

const BY_ID = new Map(LOG_LEVELS.map((level) => [level.id, level]));

export function levelMeta(id: LogLevel): LevelMeta {
  const meta = BY_ID.get(id);
  if (!meta) throw new Error(`Неизвестный уровень журнала: ${id}`);
  return meta;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && BY_ID.has(value as LogLevel);
}

/** Подпись уровня для строки журнала. */
export function levelShort(id: LogLevel): string {
  return levelMeta(id).short;
}

/* ------------------------------------------------------------------ */
/* Источники журналов                                                   */
/* ------------------------------------------------------------------ */

export type LogSource = 'postfix' | 'dovecot' | 'api';

export interface SourceMeta {
  id: LogSource;
  title: string;
  /** Чем этот журнал полезен — чтобы не гадать, куда смотреть. */
  hint: string;
}

export const LOG_SOURCES: readonly SourceMeta[] = [
  {
    id: 'postfix',
    title: 'Приём и отправка (Postfix)',
    hint: 'Кто прислал, кому доставлено, что отбито и почему отложено',
  },
  {
    id: 'dovecot',
    title: 'Ящики и доступ (Dovecot)',
    hint: 'Раскладка писем по папкам, вход по IMAP и POP3, квоты',
  },
  {
    id: 'api',
    title: 'Сервер приложения',
    hint: 'Веб-интерфейс, админка, сборщик почты с внешних ящиков',
  },
];

export function sourceTitle(id: string): string {
  return LOG_SOURCES.find((source) => source.id === id)?.title ?? id;
}
