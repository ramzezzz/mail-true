/**
 * Групповая установка подписей: перевод чисел предпросмотра в слова.
 *
 * Зачем отдельным модулем, а не строкой в разметке: это единственное
 * место, где администратор узнаёт, что произойдёт с ЧУЖИМИ подписями.
 * Требование звучало прямо — «молча затирать чужую подпись нельзя», —
 * а значит, текст должен называть число затираемых подписей всегда,
 * даже когда оно одно, и никогда не превращаться в бодрое «применится
 * к 12 ящикам» при 5 уничтоженных подписях. Такой текст проверяется
 * тестом, а разметка — нет.
 */
import type { SignatureBulkCounts, SignatureBulkMode, SignatureBulkOutcome } from '../api/types';

/** Склонение числительного: 1 ящик, 2 ящика, 5 ящиков. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export const MODE_LABELS: Readonly<Record<SignatureBulkMode, string>> = {
  replace: 'Заменить существующие подписи',
  append: 'Добавить ещё одну подпись',
  'skip-existing': 'Пропустить тех, у кого подпись уже есть',
};

export const OUTCOME_LABELS: Readonly<Record<SignatureBulkOutcome, string>> = {
  add: 'подпись будет добавлена',
  replace: 'существующие подписи будут заменены',
  'skip-existing': 'пропущен: подпись уже есть',
  'skip-incomplete': 'пропущен: не хватает данных',
};

/**
 * Опасна ли операция настолько, что нужна отдельная отмашка.
 *
 * Опасность здесь ровно одна: чужие подписи будут уничтожены и
 * восстановить их будет неоткуда. Число ящиков само по себе не опасно.
 */
export function bulkNeedsConfirmation(counts: SignatureBulkCounts): boolean {
  return counts.signaturesReplaced > 0;
}

/**
 * Что произойдёт — одной фразой, без округлений и умолчаний.
 * Порядок предложений от важного к второстепенному: сначала потери,
 * потом приобретения, потом пропуски.
 */
export function bulkSummaryText(counts: SignatureBulkCounts): string {
  if (counts.total === 0) return 'В выборке нет ни одного ящика.';

  const parts: string[] = [];

  if (counts.signaturesReplaced > 0) {
    parts.push(
      `Будет уничтожено ${String(counts.signaturesReplaced)} ` +
        `${plural(counts.signaturesReplaced, 'существующая подпись', 'существующие подписи', 'существующих подписей')} ` +
        `у ${String(counts.willReplace)} ${plural(counts.willReplace, 'ящика', 'ящиков', 'ящиков')}.`,
    );
  }

  const created = counts.willAdd + counts.willReplace;
  parts.push(
    created === 0
      ? 'Ни одному ящику подпись не достанется.'
      : `Подпись получат ${String(created)} ${plural(created, 'ящик', 'ящика', 'ящиков')} ` +
          `из ${String(counts.total)}.`,
  );

  if (counts.willSkipExisting > 0) {
    parts.push(
      `${String(counts.willSkipExisting)} ${plural(counts.willSkipExisting, 'ящик пропущен', 'ящика пропущены', 'ящиков пропущены')}: ` +
        'подпись у них уже есть.',
    );
  }
  if (counts.willSkipIncomplete > 0) {
    parts.push(
      `${String(counts.willSkipIncomplete)} ${plural(counts.willSkipIncomplete, 'ящик пропущен', 'ящика пропущены', 'ящиков пропущены')}: ` +
        'в карточке не хватает данных для подстановки.',
    );
  }

  return parts.join(' ');
}

/** Итог применения — теми же словами, что и предупреждение до него. */
export function bulkResultText(applied: number, total: number, failed: number): string {
  const base =
    `Подпись установлена в ${String(applied)} ` +
    `${plural(applied, 'ящик', 'ящика', 'ящиков')} из ${String(total)}.`;
  return failed === 0
    ? base
    : `${base} Не удалось: ${String(failed)} ${plural(failed, 'ящик', 'ящика', 'ящиков')}.`;
}
