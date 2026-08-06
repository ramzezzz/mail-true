/**
 * Разбор ящика: кто вам пишет и что занимает место.
 *
 * Отдельным файлом, а не внутри общего клиента API, по той же причине,
 * по какой отдельно живут метки и отложенные письма: возможность целиком
 * принадлежит работе со списком писем и не должна появляться в
 * интерфейсе, пока сервер не сказал, что она у него есть.
 *
 * ГЛАВНОЕ, ЧТО НАДО ЗНАТЬ ПРО ЭТОТ ФАЙЛ. Все числа здесь считает сервер,
 * а не браузер: сколько писем в группе, сколько они занимают, сколько
 * уедет в корзину. Пересчитывать их тут было бы легко и совершенно
 * неправильно — расчёт в двух местах разъезжается, а расходиться этим
 * числам нельзя: по ним человек нажимает «удалить».
 */

import { useMocks } from '../api/mockFlag';
import { apiFetch, buildQuery } from '../api/http';
/*
 * Размер и склонения берутся у нижней строки состояния, а не пишутся
 * заново. Там уже решено, как продукт говорит о байтах: «986 КБ», «3,2 ГБ»,
 * запятая вместо точки, дробная часть только когда что-то добавляет.
 * Второй формат в одном интерфейсе — это «1.00 ГБ» рядом с «1 ГБ», и
 * именно так и вышло, пока здесь был свой перевод байт в текст.
 */
import { formatBytes, plural } from '../layout/FooterStatus';

export { formatBytes };

/** Вид группы: рассылка со своим `List-Id` либо просто отправитель. */
export type MailingKind = 'list' | 'sender';

export interface MailingFolderShare {
  folderId: string;
  count: number;
}

/** Строка разбора: кто и сколько вам пишет. */
export interface MailingGroup {
  key: string;
  kind: MailingKind;
  title: string;
  address: string;
  /** Это рассылка (есть `List-Id` или адрес отписки), а не переписка. */
  mailing: boolean;
  count: number;
  unread: number;
  bytes: number;
  firstDate: string;
  lastDate: string;
  canUnsubscribe: boolean;
  /** Отписка пройдёт одним запросом с сервера, без открытия страницы. */
  oneClick: boolean;
  unsubscribeMessageId: string | null;
  folders: MailingFolderShare[];
  /** Доля от занятого места ящика, 0..1. Null — квота неизвестна. */
  quotaShare: number | null;
}

export interface ScanFolderStat {
  folderId: string;
  name: string;
  role: string;
  total: number;
  scanned: number;
  bytes: number;
}

export interface MailboxQuota {
  usedBytes: number;
  limitBytes: number;
}

/** Общая часть обоих ответов разбора: чего осмотр стоил и что нашёл. */
interface ReviewBase {
  /**
   * Отметка осмотра. Её же интерфейс присылает обратно при выполнении
   * уборки — так сервер убеждается, что человек видел ИМЕННО ЭТИ числа
   * (см. apps/api/src/mail/mailings-routes.ts).
   */
  at: string;
  scanned: number;
  total: number;
  /** Осмотр дошёл не до конца — часть ящика в числа не попала. */
  truncated: boolean;
  limit: number;
  quota: MailboxQuota | null;
  folders: ScanFolderStat[];
}

export interface MailingsState extends ReviewBase {
  available: boolean;
  reason: string | null;
  groups: MailingGroup[];
}

export interface HeavyMessage {
  id: string;
  folderId: string;
  subject: string;
  from: { name: string | null; address: string };
  date: string;
  size: number;
  seen: boolean;
  flagged: boolean;
}

export interface CleanupState extends ReviewBase {
  available: boolean;
  reason: string | null;
  heaviest: HeavyMessage[];
  staleMailings: MailingGroup[];
}

/** Условия уборки — ровно то, что человек выставил в окне. */
export interface SweepRequest {
  folderId?: string | undefined;
  olderThanDays?: number | undefined;
  keepUnread?: boolean;
  keepFlagged?: boolean;
  groupKey?: string | undefined;
  largerThanBytes?: number | undefined;
  keepLatest?: number | undefined;
  targetFolderId?: string;
  /** Только посчитать. */
  dryRun: boolean;
  /** Отметка разбора, который видел человек. Обязательна при выполнении. */
  scanAt?: string | undefined;
}

export interface SweepResult {
  dryRun: boolean;
  at: string;
  count: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  unread: number;
  flagged: number;
  moved: number;
  targetFolderId: string | null;
}

export type UnsubscribeResult =
  | { ok: true; method: 'one-click'; url: string; key: string; title: string }
  | { ok: true; method: 'mailto'; address: string; key: string; title: string }
  | { ok: false; method: 'link'; url: string | null; key: string; title: string };

const EMPTY_BASE: ReviewBase = {
  at: '',
  scanned: 0,
  total: 0,
  truncated: false,
  limit: 0,
  quota: null,
  folders: [],
};

/**
 * Разбора нет — с причиной, которую можно показать человеку.
 *
 * Отдельная константа, а не «пустой список групп»: пустой список значит
 * «в ящике никого нет», и окно разбора при нём открывается и работает.
 */
export const MAILINGS_UNAVAILABLE: MailingsState = {
  ...EMPTY_BASE,
  available: false,
  reason: null,
  groups: [],
};

export const CLEANUP_UNAVAILABLE: CleanupState = {
  ...EMPTY_BASE,
  available: false,
  reason: null,
  heaviest: [],
  staleMailings: [],
};

/*
 * На заглушках интерфейса запроса нет вовсе — то же правило, что у меток
 * и отложенных писем. Своего ящика у заглушек нет, а сходить на настоящий
 * адрес нельзя: без сессии он ответит 401, и общий обработчик уведёт на
 * экран входа из режима, где входа не предполагается. Значит, кнопки
 * «Разобрать ящик» в этом режиме просто не будет — за ней действительно
 * ничего не стоит.
 */
const ON_MOCKS_REASON = 'На заглушечных данных ящик разбирать нечего';

export const mailingsApi = {
  getMailings: (refresh = false): Promise<MailingsState> => {
    if (useMocks) {
      return Promise.resolve({ ...MAILINGS_UNAVAILABLE, reason: ON_MOCKS_REASON });
    }
    return apiFetch<Omit<MailingsState, 'available' | 'reason'>>(
      `/api/mailings${buildQuery({ refresh: refresh ? '1' : undefined })}`,
      // Осмотр ящика — заведомо долгая работа: на большом ящике это
      // тысячи писем. Общего получаса ждать незачем, но и обычных
      // тридцати секунд может не хватить.
      { timeoutMs: 120_000 },
    ).then((data) => ({ ...data, available: true, reason: null }));
  },

  getCleanup: (refresh = false): Promise<CleanupState> => {
    if (useMocks) {
      return Promise.resolve({ ...CLEANUP_UNAVAILABLE, reason: ON_MOCKS_REASON });
    }
    return apiFetch<Omit<CleanupState, 'available' | 'reason'>>(
      `/api/cleanup${buildQuery({ refresh: refresh ? '1' : undefined })}`,
      { timeoutMs: 120_000 },
    ).then((data) => ({ ...data, available: true, reason: null }));
  },

  unsubscribe: (key: string): Promise<UnsubscribeResult> =>
    apiFetch('/api/mailings/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ key }),
      // Отписку делает сервер запросом наружу — он ждёт чужую службу
      timeoutMs: 60_000,
    }),

  sweep: (request: SweepRequest): Promise<SweepResult> =>
    apiFetch('/api/cleanup/sweep', {
      method: 'POST',
      body: JSON.stringify(request),
      timeoutMs: 120_000,
    }),
};

/* ------------------------------------------------------------------ */
/* Слова и числа для показа                                            */
/* ------------------------------------------------------------------ */

/**
 * «12 писем» — с правильным окончанием.
 *
 * Мелочь, которую замечают все: «12 письма» в окне, где решают удалить
 * пятьсот штук, читается как небрежность ровно там, где нужно доверие.
 */
export function messagesWord(count: number): string {
  return `${String(count)} ${plural(count, ['письмо', 'письма', 'писем'])}`;
}

/**
 * «Пишет с 2019 года, последнее — вчера» одной строкой.
 *
 * Считается по часам БРАУЗЕРА, потому что показывается человеку: сервер
 * прислал моменты времени, а «вчера» зависит от того, где человек сидит.
 */
export function lastSeenText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 30) return `${String(days)} ${plural(days, ['день', 'дня', 'дней'])} назад`;
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${String(months)} ${plural(months, ['месяц', 'месяца', 'месяцев'])} назад`;
  }
  const years = Math.floor(days / 365);
  return `${String(years)} ${plural(years, ['год', 'года', 'лет'])} назад`;
}

/** Готовые сроки для уборки — ровно то, что человек видит в окне. */
export const SWEEP_AGES: ReadonlyArray<{ days: number; title: string }> = [
  { days: 30, title: 'старше месяца' },
  { days: 180, title: 'старше полугода' },
  { days: 365, title: 'старше года' },
  { days: 1095, title: 'старше трёх лет' },
];
