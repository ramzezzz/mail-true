/**
 * Три раздела владельца ящика: «Вход и действия», «Выгрузка ящика»
 * и «Восстановление писем».
 *
 * Общее у всех трёх правило: сервер отвечает состоянием `{available,
 * reason}` ДО того, как интерфейс покажет хоть одну кнопку. Не применена
 * миграция, не настроен служебный вход в Dovecot, выгрузка выключена на
 * закрытом контуре — раздел не показывается вовсе, а причина видна там,
 * где её ищут. То же правило у меток (mail/labelsApi.ts) и отложенных
 * писем: кнопка появляется вместе с поведением.
 *
 * На заглушечных данных запроса нет вовсе. Своей истории входов, своего
 * ящика и своих архивов у заглушек нет, а сходить на настоящий адрес
 * нельзя: без сессии он отвечает 401, и общий обработчик уводит на экран
 * входа из режима, где входа не предполагается.
 */

import { apiFetch, buildQuery } from '../api/http';
import { useMocks } from '../api/mockFlag';

/* ------------------------------------------------------------------ */
/* Вход и действия                                                      */
/* ------------------------------------------------------------------ */

/** Каким способом попали в ящик. */
export type AccessChannel = 'web' | 'imap' | 'pop3' | 'smtp';

export interface AccessEvent {
  at: string;
  channel: AccessChannel;
  success: boolean;
  ip: string | null;
  /** Вид адреса словами: «локальная сеть», «интернет», «сам сервер». */
  where: string;
  userAgent: string | null;
  /** Подключение самого веб-интерфейса, а не человека. */
  service: boolean;
  detail: string;
  origin: 'app' | 'dovecot' | 'postfix';
}

export interface AccessLogState {
  available: boolean;
  reason: string | null;
  retentionDays: number;
  items: AccessEvent[];
  hasMore: boolean;
}

export const ACCESS_UNAVAILABLE: AccessLogState = {
  available: false,
  reason: null,
  retentionDays: 0,
  items: [],
  hasMore: false,
};

const ACCESS_ON_MOCKS: AccessLogState = {
  ...ACCESS_UNAVAILABLE,
  reason: 'На заглушечных данных история входов не ведётся',
};

/** Названия способов входа для колонки таблицы. */
export const CHANNEL_TITLES: Record<AccessChannel, string> = {
  web: 'Веб',
  imap: 'IMAP',
  pop3: 'POP3',
  smtp: 'SMTP',
};

/* ------------------------------------------------------------------ */
/* Выгрузка ящика                                                       */
/* ------------------------------------------------------------------ */

export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'expired';

export interface ExportJob {
  id: number;
  state: ExportState;
  includeSpam: boolean;
  includeTrash: boolean;
  totalMessages: number;
  doneMessages: number;
  doneBytes: number;
  skipped: number;
  fileBytes: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export interface ExportPageState {
  available: boolean;
  reason: string | null;
  ttlHours: number;
  maxBytes?: number;
  jobs: ExportJob[];
}

export const EXPORT_UNAVAILABLE: ExportPageState = {
  available: false,
  reason: null,
  ttlHours: 0,
  jobs: [],
};

const EXPORT_ON_MOCKS: ExportPageState = {
  ...EXPORT_UNAVAILABLE,
  reason: 'На заглушечных данных выгружать нечего: настоящего ящика здесь нет',
};

/** Идёт ли задание прямо сейчас — от этого зависит частота опроса. */
export function isExportLive(job: ExportJob): boolean {
  return job.state === 'queued' || job.state === 'running';
}

/* ------------------------------------------------------------------ */
/* Восстановление писем                                                 */
/* ------------------------------------------------------------------ */

export interface RecoveryItem {
  id: number;
  subject: string;
  from: string;
  sentAt: string | null;
  sizeBytes: number;
  deletedAt: string;
  purgeAt: string;
}

export interface RecoveryPageState {
  available: boolean;
  reason: string | null;
  /** Сколько дней ящик хранит очищенное; 0 — не хранить. */
  days: number;
  /** Потолок, заданный администратором сервера. */
  maxDays: number;
  /** Удаление по сроку работает (настроен служебный вход в Dovecot). */
  scheduledPurge: boolean;
  items: RecoveryItem[];
  totals: { count: number; bytes: number };
}

export const RECOVERY_UNAVAILABLE: RecoveryPageState = {
  available: false,
  reason: null,
  days: 0,
  maxDays: 0,
  scheduledPurge: false,
  items: [],
  totals: { count: 0, bytes: 0 },
};

const RECOVERY_ON_MOCKS: RecoveryPageState = {
  ...RECOVERY_UNAVAILABLE,
  reason: 'На заглушечных данных очищать и восстанавливать нечего',
};

/* ------------------------------------------------------------------ */

export const ownerApi = {
  getAccessLog: (before?: string): Promise<AccessLogState> => {
    if (useMocks) return Promise.resolve(ACCESS_ON_MOCKS);
    return apiFetch(`/api/settings/access-log${buildQuery({ before })}`);
  },

  getExports: (): Promise<ExportPageState> => {
    if (useMocks) return Promise.resolve(EXPORT_ON_MOCKS);
    return apiFetch('/api/settings/export');
  },

  startExport: (options: { includeSpam: boolean; includeTrash: boolean }): Promise<ExportJob> =>
    apiFetch('/api/settings/export', { method: 'POST', body: JSON.stringify(options) }),

  cancelExport: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/api/settings/export/${id}/cancel`, { method: 'POST' }),

  /**
   * Удалить готовый архив, не дожидаясь срока хранения.
   *
   * В архиве лежит вся переписка ящика, и до этой возможности убрать его
   * с сервера было нечем: отмена работает только с идущей выгрузкой, а
   * готовый файл ждал своих двух суток и попадал во все резервные копии,
   * снятые за это время.
   */
  deleteExport: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/api/settings/export/${id}`, { method: 'DELETE' }),

  /**
   * Адрес скачивания архива.
   *
   * Именно адрес, а не запрос: файл бывает на гигабайты, и тянуть его
   * через fetch в память браузера, чтобы потом отдать ссылкой на blob, —
   * верный способ уронить вкладку. Браузер качает такое сам, показывая
   * свой же ход загрузки.
   */
  exportFileUrl: (id: number): string => `/api/settings/export/${id}/file`,

  getRecovery: (): Promise<RecoveryPageState> => {
    if (useMocks) return Promise.resolve(RECOVERY_ON_MOCKS);
    return apiFetch('/api/settings/recovery');
  },

  setRecoveryDays: (days: number): Promise<{ ok: boolean; days: number }> =>
    apiFetch('/api/settings/recovery', { method: 'PUT', body: JSON.stringify({ days }) }),

  /**
   * Вернуть выбранные письма в корзину.
   *
   * Ответ читается целиком, а не ради одного `restored`: вернуться может
   * не всё. `missing` — писем уже нет в ящике (унесли почтовой программой,
   * вернули из соседней вкладки), `failed` — почтовый сервер отказал
   * (кончилось место, папка исчезла). Раньше результат мутации не читался
   * вовсе, и «выбрал 40, вернулось 12» выглядело на экране как полный
   * успех: список просто становился короче.
   */
  restoreMessages: (
    ids: number[],
  ): Promise<{ restored: number; missing: number; failed: number }> =>
    apiFetch('/api/settings/recovery/restore', { method: 'POST', body: JSON.stringify({ ids }) }),

  purgeMessages: (ids: number[] | 'all'): Promise<{ purged: number; failed: number }> =>
    apiFetch('/api/settings/recovery/purge', {
      method: 'POST',
      body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
    }),
};

/* ------------------------------------------------------------------ */
/* Показ значений                                                       */
/* ------------------------------------------------------------------ */

/**
 * Размер по-человечески.
 *
 * Отдельная функция, а не `toFixed` по месту: размеры показываются в двух
 * разделах из трёх, и «1.5 GB» рядом с «1,5 ГБ» выглядело бы небрежностью.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // До мегабайт дробная часть не нужна: «512,3 КБ» никому ничего не говорит.
  const digits = unit >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(digits).replace('.', ',')} ${units[unit]}`;
}

/** Дата и время события — в поясе браузера, потому что читает их человек. */
export function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * «Осталось столько-то» — до момента в будущем.
 *
 * Дни и часы, без минут: точность до минуты здесь ложная — работник
 * ходит раз в минуту, и обещать «осталось 3 минуты» значит обещать
 * лишнего.
 */
export function formatLeft(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'вот-вот';
  const hours = Math.floor(ms / 3600_000);
  /*
   * Двое суток, а не одни: при сроке в 48 часов «через 1 день» звучало бы
   * вдвое тревожнее правды, а «через 47 часов» — ровно правда. Округление
   * вниз оставлено намеренно: обещать человеку больше времени, чем у него
   * есть, нельзя ни при каком округлении.
   */
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  if (hours >= 1) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
}

/** Склонение по-русски: 1 день, 2 дня, 5 дней. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
