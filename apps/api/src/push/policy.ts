/**
 * Правила уведомлений: о чём уведомлять, когда молчать и что писать
 * в окне на каждом уровне подробности.
 *
 * Всё здесь — чистые функции без базы, IMAP и сети. Так и задумано:
 * именно эти правила должны быть проверены до последнего случая, а
 * проверять их через живой почтовый ящик — гадание.
 */
import type { MailAddress } from '@mail-true/shared';
import type {
  NotificationAction,
  NotificationLevel,
  NotificationPrefs,
  NotificationView,
  QuietHours,
} from './types.js';

/* ------------------------------------------------------------------ */
/* О чём НЕ уведомлять                                                  */
/* ------------------------------------------------------------------ */

/** Письмо, о котором сервер узнал по IMAP IDLE. */
export interface ArrivedMessage {
  id: string;
  folderId: string;
  from: MailAddress | null;
  subject: string;
  date: string;
  /** Письмо пришло уже прочитанным — так делает фильтр с действием «прочитано». */
  seen: boolean;
}

/**
 * Почему уведомления не будет. Отдельные значения, а не `false`:
 * причину видно в журнале сервера, и «не пришло уведомление» перестаёт
 * быть загадкой.
 */
export type SkipReason =
  | 'notifications-off'
  /** Не «Входящие»: спам и разложенное фильтрами сюда же. */
  | 'not-inbox'
  /** Своё же отправленное письмо (копия себе, список рассылки). */
  | 'own-message'
  /** Фильтр пометил письмо прочитанным — человек уже решил, что оно не срочное. */
  | 'already-read'
  | 'quiet-hours';

export interface NotifyDecision {
  notify: boolean;
  reason: SkipReason | null;
}

const ALLOW: NotifyDecision = { notify: true, reason: null };
const deny = (reason: SkipReason): NotifyDecision => ({ notify: false, reason });

export interface NotifyContext {
  prefs: NotificationPrefs;
  /** Все адреса самого пользователя: свой ящик и связанные с ним. */
  ownAddresses: readonly string[];
  now: Date;
}

/**
 * Уведомлять ли об этом письме.
 *
 * Порядок проверок не случаен: сначала то, что вообще выключено, потом
 * свойства письма, и только в самом конце — время. Так в журнале
 * оказывается самая содержательная причина: «выключено» полезнее, чем
 * «тихие часы», если верно и то и другое.
 */
export function shouldNotify(message: ArrivedMessage, ctx: NotifyContext): NotifyDecision {
  const { prefs } = ctx;
  if (!prefs.enabled) return deny('notifications-off');

  /*
   * Только «Входящие». Это закрывает сразу три случая из требований:
   * спам (Sieve кладёт его в «Спам» при доставке), письма, разложенные
   * фильтрами по папкам, и собственные отправленные (они попадают в
   * «Отправленные», а не во «Входящие»).
   *
   * Проверка стоит здесь, а не только в наблюдателе IMAP, потому что
   * наблюдатель — не единственный возможный источник событий, а тихо
   * уведомлять о спаме нельзя ни при каком источнике.
   */
  if (message.folderId !== 'inbox') return deny('not-inbox');

  // Своё же письмо во «Входящих» — это копия себе или возврат через
  // список рассылки. Уведомлять человека о том, что он только что
  // отправил сам, бессмысленно; настройки на это нет намеренно.
  const from = message.from?.address?.toLowerCase().trim() ?? '';
  if (from !== '' && ctx.ownAddresses.some((own) => own.toLowerCase().trim() === from)) {
    return deny('own-message');
  }

  if (message.seen && prefs.skipFiltered) return deny('already-read');

  if (inQuietHours(ctx.now, prefs.quietHours, prefs.timeZone)) return deny('quiet-hours');

  return ALLOW;
}

/* ------------------------------------------------------------------ */
/* Тихие часы                                                           */
/* ------------------------------------------------------------------ */

/** Минуты от полуночи в заданном поясе; null — пояс не разобрать. */
export function minutesOfDay(date: Date, timeZone: string | null): number | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    // Неизвестное имя пояса. Не авария: см. пояснение в inQuietHours.
    return null;
  }
}

/**
 * Попадает ли момент в «тихие часы».
 *
 * Про неизвестный пояс отдельно. Если пояс не задан или не разобран,
 * ответ — НЕТ, то есть уведомление показывается. Ошибиться можно в две
 * стороны, и они неравноценны: лишнее уведомление ночью раздражает,
 * а пропущенное письмо — это ровно то, ради чего человек уведомления и
 * включал. Молча промолчать хуже, чем лишний раз пикнуть; в настройках
 * при этом честно написано, что пояс не определён.
 */
export function inQuietHours(now: Date, quiet: QuietHours, timeZone: string | null): boolean {
  if (!quiet.enabled) return false;
  // Совпадающие границы — окно нулевой длины, а не «круглые сутки»:
  // «с 8:00 до 8:00» как «молчать всегда» было бы ловушкой.
  if (quiet.fromMinutes === quiet.toMinutes) return false;
  const minutes = minutesOfDay(now, timeZone);
  if (minutes === null) return false;
  return quiet.fromMinutes < quiet.toMinutes
    ? minutes >= quiet.fromMinutes && minutes < quiet.toMinutes
    : // Окно через полночь: «с 23:00 до 7:00»
      minutes >= quiet.fromMinutes || minutes < quiet.toMinutes;
}

/* ------------------------------------------------------------------ */
/* Текст уведомления                                                    */
/* ------------------------------------------------------------------ */

/** Склонение существительного при числе: 1 письмо, 2 письма, 5 писем. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Имя отправителя для заголовка окна. */
export function senderLabel(from: MailAddress | null): string {
  const name = from?.name?.trim();
  if (name) return name;
  const address = from?.address?.trim();
  if (address) return address;
  return 'Неизвестный отправитель';
}

export function subjectLabel(subject: string): string {
  const trimmed = subject.trim();
  return trimmed === '' ? '(без темы)' : trimmed;
}

/** Письмо со всем, что удалось собрать для уведомления. */
export interface NotificationItem {
  id: string;
  folderId: string;
  from: MailAddress | null;
  subject: string;
  date: string;
  /** Первые фразы письма. null — не удалось прочитать. */
  preview: string | null;
  /** Сводка от ИИ. null — не запрашивалась или не получилась. */
  summary: string | null;
  /**
   * Значок отправителя с НАШЕГО адреса (/api/sender-logos/…).
   * null — логотипа нет, выключен или он векторный: Chrome не рисует SVG
   * в уведомлениях вовсе, и такой значок обернулся бы пустым местом.
   */
  logoUrl: string | null;
}

/** Наш собственный значок — когда логотипа отправителя нет. */
export const FALLBACK_ICON = '/brand/notification-icon.png';
/** Силуэт для строки состояния Android. */
export const BADGE_ICON = '/brand/notification-badge.png';

/**
 * Ярлык окна.
 *
 * Один и тот же для всех уведомлений ящика — и в этом весь смысл:
 * браузер держит по одному окну на ярлык, поэтому десять писем подряд
 * ЗАМЕНЯЮТ друг друга одним окном «10 новых писем», а не выкладываются
 * стопкой из десяти. Ящик в ярлыке нужен для второго связанного ящика:
 * его письма не должны затирать уведомление первого.
 */
export function notificationTag(accountKey: string): string {
  return `mail-true:${accountKey}`;
}

/** Обрезка до целого слова: обрубленное на середине слова читается плохо. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Сколько писем перечисляем поимённо, прежде чем сказать «и ещё N». */
export const LISTED_IN_GROUP = 3;

export interface BuildViewOptions {
  items: readonly NotificationItem[];
  level: NotificationLevel;
  accountKey: string;
  degraded?: string | null;
}

/**
 * Собирает описание всплывающего окна.
 *
 * Одна функция на все уровни и на любое число писем — чтобы не вышло так,
 * что «отправитель и тема» показывает одно, а «то же самое, но пять писем»
 * внезапно другое.
 */
export function buildNotificationView(options: BuildViewOptions): NotificationView {
  const { items, level, accountKey } = options;
  const tag = notificationTag(accountKey);
  const base = {
    tag,
    badge: BADGE_ICON,
    ids: items.map((item) => item.id),
    degraded: options.degraded ?? null,
  };

  if (items.length === 0) {
    // Такого быть не должно, но показать пустое окно нельзя: Chrome
    // требует показать хоть что-то на каждое push-сообщение, иначе сам
    // выведет «сайт обновился в фоне» — то есть чужой текст вместо нашего.
    return {
      ...base,
      title: 'Новое письмо',
      body: 'Откройте почту, чтобы прочитать',
      icon: FALLBACK_ICON,
      actions: [{ action: 'open', title: 'Открыть почту' }],
      url: '/inbox/',
    };
  }

  const newest = items[0]!;

  if (items.length === 1) {
    return {
      ...base,
      ...singleView(newest, level),
      /*
       * Значок — логотип отправителя, если он у нас уже есть; иначе наш.
       *
       * На уровне «только факт» логотипа не будет никогда, и это не
       * придирка: адрес логотипа — /api/sender-logos/<ДОМЕН>/image, то
       * есть сам значок называет отправителя. Человек, выбравший не
       * показывать отправителя, увидел бы на экране логотип банка —
       * ровно то, чего просил не показывать.
       */
      icon: (level === 'minimal' ? null : newest.logoUrl) ?? FALLBACK_ICON,
      actions: singleActions(level),
      // Щелчок открывает ИМЕННО ЭТО письмо, а не почту вообще.
      url: messageUrl(newest),
    };
  }

  const listed = items.slice(0, LISTED_IN_GROUP);
  const rest = items.length - listed.length;
  const lines = listed.map(
    (item) => `${senderLabel(item.from)}: ${clip(subjectLabel(item.subject), 60)}`,
  );
  if (rest > 0) lines.push(`и ещё ${String(rest)} ${plural(rest, 'письмо', 'письма', 'писем')}`);

  return {
    ...base,
    title: `${String(items.length)} ${plural(items.length, 'новое письмо', 'новых письма', 'новых писем')}`,
    // На уровне «только факт» перечислять отправителей нельзя: человек
    // выбрал не показывать даже их.
    body: level === 'minimal' ? 'Откройте почту, чтобы прочитать' : lines.join('\n'),
    // Логотип одного из многих ввёл бы в заблуждение: показываем свой.
    icon: FALLBACK_ICON,
    // Пометить прочитанными или убрать в архив десяток писем одним
    // касанием по уведомлению — не то, что можно предложить вслепую.
    actions: [{ action: 'open', title: 'Открыть почту' }],
    url: '/inbox/',
  };
}

function messageUrl(item: NotificationItem): string {
  return `/${item.folderId}/${encodeURIComponent(item.id)}`;
}

/** Заголовок и тело для одного письма на выбранном уровне. */
function singleView(item: NotificationItem, level: NotificationLevel): { title: string; body: string } {
  const sender = senderLabel(item.from);
  const subject = clip(subjectLabel(item.subject), 90);

  switch (level) {
    case 'minimal':
      // Ни отправителя, ни темы — даже в заголовке. Иначе уровень
      // «только факт» не был бы уровнем «только факт».
      return { title: 'Новое письмо', body: 'Откройте почту, чтобы прочитать' };
    case 'sender-subject':
      return { title: sender, body: subject };
    case 'preview': {
      const preview = item.preview ? clip(item.preview, 140) : '';
      return { title: sender, body: preview === '' ? subject : `${subject}\n${preview}` };
    }
    case 'ai-summary': {
      const summary = item.summary ? clip(item.summary, 180) : '';
      // Сводки нет (предел исчерпан, сервис молчит) — показываем первые
      // фразы, а не пустоту: человек включал уведомление ради содержания.
      const fallback = item.preview ? clip(item.preview, 140) : '';
      const text = summary === '' ? fallback : summary;
      return { title: sender, body: text === '' ? subject : `${subject}\n${text}` };
    }
  }
}

/**
 * Кнопки в окне.
 *
 * Смысл в том, чтобы не открывать почту ради одного щелчка: половина
 * писем — это то, что достаточно пометить прочитанным или убрать.
 * На уровне «только факт» кнопок с действиями нет: человек не видит,
 * что именно пришло, а «пометить прочитанным вслепую» — плохая сделка.
 */
function singleActions(level: NotificationLevel): NotificationAction[] {
  if (level === 'minimal') return [{ action: 'open', title: 'Открыть' }];
  return [
    { action: 'read', title: 'Прочитано' },
    { action: 'archive', title: 'В архив' },
  ];
}
