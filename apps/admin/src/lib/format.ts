/**
 * Чистые вспомогательные функции интерфейса: форматирование и разбор.
 * Вынесены отдельно, чтобы покрывались тестами без рендера компонентов.
 */

const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'] as const;

/** Размер по-человечески: 1073741824 -> «1 ГБ». 0 — «без ограничения». */
export function formatBytes(bytes: number, unlimitedLabel = 'без ограничения'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return unlimitedLabel;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${UNITS[unit]}`;
}

/**
 * Обратное преобразование: «1 ГБ», «500M», «1073741824» -> байты.
 * null — не удалось разобрать (интерфейс покажет ошибку рядом с полем).
 */
export function parseBytes(raw: string): number | null {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, '');
  if (value === '') return null;
  const match = /^(\d+(?:[.,]\d+)?)(b|k|m|g|t|kb|mb|gb|tb|б|кб|мб|гб|тб)?$/u.exec(value);
  if (!match) return null;
  const amount = Number.parseFloat((match[1] ?? '0').replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const factors: Record<string, number> = {
    '': 1, b: 1, б: 1,
    k: 1024, kb: 1024, кб: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, мб: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, гб: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, тб: 1024 ** 4,
  };
  const factor = factors[match[2] ?? ''];
  return factor === undefined ? null : Math.round(amount * factor);
}

/** Дата и время в местном виде: «05.08.2026, 14:32». */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «только что», «5 мин назад», «вчера» — для колонок «когда». */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'никогда';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 0) return formatDateTime(iso);
  if (seconds < 60) return 'только что';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} дн назад`;
  return formatDateTime(iso);
}

/** Правильное окончание: 1 ящик, 2 ящика, 5 ящиков. */
export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Число со словом: «5 ящиков». */
export function pluralize(count: number, one: string, few: string, many: string): string {
  return `${count} ${plural(count, one, few, many)}`;
}
