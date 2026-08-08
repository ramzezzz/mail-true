/**
 * Что показывать в разделе «Перенос почты».
 *
 * Отдельный модуль, а не выражения внутри разметки, потому что здесь
 * решается главный вопрос раздела: КАК человек понимает, идёт перенос
 * или встал. Перенос ящика занимает часы, крутящийся кружок в этих
 * условиях не сообщает ничего — нужны числа и последнее движение.
 */
import type {
  MigrationItem,
  MigrationItemState,
  MigrationJob,
  MigrationJobState,
} from '../api/types';

/** Названия состояний задания на языке человека, а не базы. */
export const JOB_STATE_LABELS: Readonly<Record<MigrationJobState, string>> = {
  queued: 'В очереди',
  running: 'Идёт',
  done: 'Завершено',
  failed: 'Не выполнено',
  stopped: 'Остановлено',
};

export const ITEM_STATE_LABELS: Readonly<Record<MigrationItemState, string>> = {
  queued: 'ждёт',
  running: 'переносится',
  ok: 'перенесён',
  partial: 'с ошибками',
  failed: 'не перенесён',
  stopped: 'остановлен',
};

export type Tone = 'ok' | 'warn' | 'fail' | 'muted';

/**
 * Цвет состояния.
 *
 * «Остановлено» намеренно не красное: человек сам нажал кнопку, и красная
 * плашка в ответ на собственное действие читается как «сломалось».
 * «С ошибками» не зелёное: часть писем не доехала, и это надо открыть.
 */
export const JOB_STATE_TONES: Readonly<Record<MigrationJobState, Tone>> = {
  queued: 'muted',
  running: 'ok',
  done: 'ok',
  failed: 'fail',
  stopped: 'warn',
};

export const ITEM_STATE_TONES: Readonly<Record<MigrationItemState, Tone>> = {
  queued: 'muted',
  running: 'ok',
  ok: 'ok',
  partial: 'warn',
  failed: 'fail',
  stopped: 'warn',
};

/** Идёт ли задание — по нему решается, опрашивать ли сервер дальше. */
export function isJobLive(job: Pick<MigrationJob, 'state'>): boolean {
  return job.state === 'queued' || job.state === 'running';
}

/**
 * Доля выполнения задания, 0..1.
 *
 * Считается по ЯЩИКАМ и письмам текущего ящика вместе, а не по одним
 * ящикам: при переносе одного большого ящика счётчик по ящикам стоял бы
 * на нуле часами и выглядел бы намертво замершим.
 */
export function jobProgress(job: MigrationJob, items: readonly MigrationItem[]): number {
  if (job.total <= 0) return 0;
  const perMailbox = 1 / job.total;
  let done = 0;
  for (const item of items) {
    if (item.state === 'ok' || item.state === 'partial' || item.state === 'failed') {
      done += perMailbox;
    } else if ((item.state === 'running' || item.state === 'stopped') && item.total > 0) {
      // Остановленный ящик считается так же, как идущий: до остановки
      // часть писем переехала, и показывать по нему ноль — врать. Именно
      // это число человек и смотрит, решая, стоит ли продолжать.
      const inside = Math.min(1, (item.copied + item.skipped + item.failed) / item.total);
      done += perMailbox * inside;
    }
  }
  return Math.min(1, done);
}

/**
 * Строка «что происходит прямо сейчас».
 *
 * Без неё раздел отвечает на вопрос «сколько сделано», но не на вопрос
 * «оно вообще движется». Название текущей папки — самый дешёвый признак
 * движения: оно меняется на глазах.
 */
export function currentActivity(items: readonly MigrationItem[]): string | null {
  const running = items.find((item) => item.state === 'running');
  if (!running) return null;
  const folder = running.currentFolder;
  const seen = running.copied + running.skipped + running.failed;
  const of = running.total > 0 ? ` из ${String(running.total)}` : '';
  return folder
    ? `${running.sourceUser}: папка «${folder}», письмо ${String(seen)}${of}`
    : `${running.sourceUser}: подготовка (читается список папок)`;
}

/** Ящики, которые имеет смысл повторить. */
export function retryableItems(items: readonly MigrationItem[]): MigrationItem[] {
  return items.filter(
    (item) =>
      item.state === 'failed' ||
      item.state === 'partial' ||
      item.state === 'stopped' ||
      item.state === 'queued',
  );
}

/**
 * Чего не хватает разделу, чтобы работать, — человеческим языком.
 *
 * Пустой список означает «всё готово». Возвращается именно список, а не
 * одна строка: не настроено может быть сразу несколько вещей, и узнавать
 * о них по одной, перезапуская контейнер, — это три перезапуска вместо
 * одного.
 */
export function readinessProblems(settings: {
  masterConfigured: boolean;
  secretConfigured: boolean;
  schemaReady: boolean;
}): string[] {
  const problems: string[] = [];
  if (!settings.masterConfigured) {
    problems.push(
      'Не настроен служебный доступ Dovecot (DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD). ' +
        'Им перенос кладёт письма в ящики, не спрашивая пароли их владельцев.',
    );
  }
  if (!settings.secretConfigured) {
    problems.push(
      'Не задан ADMIN_SESSION_SECRET (или SESSION_SECRET). Пароли исходных ящиков нужны ' +
        'на всё время переноса, и храниться они будут только зашифрованными — а шифровать нечем.',
    );
  }
  if (!settings.schemaReady) {
    problems.push(
      'Не применена миграция infra/postgres/migrations/0001_baseline.sql — заданиям ' +
        'переноса негде храниться, и они не переживут перезапуск.',
    );
  }
  return problems;
}
