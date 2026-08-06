/**
 * Снимки счётчиков антиспама и разность по ним.
 *
 * Отдельным модулем, а не методами AdminDb, по той же причине, что и
 * metrics-store.ts: admin/db.ts — общий файл про ящики, домены и алиасы.
 * Работает через открытые query/one, то есть тем же пулом соединений.
 *
 * ------------------------------------------------------------------
 * ГЛАВНОЕ ПРО АРИФМЕТИКУ
 * ------------------------------------------------------------------
 * Счётчики rspamd накопительные и обнуляются при перезапуске процесса.
 * Поэтому «сколько было за сутки» — это не разность крайних снимков, а
 * СУММА приростов между соседними, где каждый прирост считается по
 * правилу:
 *
 *   время работы выросло  → прирост = новое − старое (обычный случай);
 *   время работы упало    → процесс перезапускали, старое значение больше
 *                           ни о чём не говорит; приростом считаем новое
 *                           абсолютное значение — это и есть «сколько
 *                           набежало с перезапуска», а перезапуск был
 *                           внутри окна;
 *   первый снимок окна    → прироста нет: не с чем сравнивать. Событий до
 *                           начала окна мы не приписываем окну.
 *
 * Считает это база оконной функцией: вытаскивать десятки тысяч снимков в
 * память ради шести чисел незачем (см. пояснение в metrics-store.ts).
 */
import type { AdminDb } from './db.js';
import type { RspamdStat } from './rspamd.js';

/** Что кладёт сборщик. */
export interface SpamSampleInput {
  uptimeSeconds: number;
  scanned: number;
  reject: number;
  addHeader: number;
  rewriteSubject: number;
  greylist: number;
  softReject: number;
  noAction: number;
  learned: number;
  spamCount: number;
  hamCount: number;
}

/** Разность за окно. */
export interface SpamPeriodTotals {
  scanned: number;
  reject: number;
  addHeader: number;
  rewriteSubject: number;
  greylist: number;
  softReject: number;
  noAction: number;
  learned: number;
  /** Сколько раз за окно счётчики уходили с нуля — то есть было перезапусков. */
  restarts: number;
  /** Границы, между которыми на самом деле есть снимки. */
  from: string | null;
  to: string | null;
  /** Сколько снимков попало в окно. Ноль означает «данных за период нет». */
  samples: number;
}

/** Имена действий rspamd → колонки таблицы. */
export function sampleFromStat(stat: RspamdStat): SpamSampleInput {
  const action = (name: string): number => stat.actions[name] ?? 0;
  return {
    uptimeSeconds: stat.uptimeSeconds,
    scanned: stat.scanned,
    reject: action('reject'),
    addHeader: action('add header'),
    rewriteSubject: action('rewrite subject'),
    greylist: action('greylist'),
    softReject: action('soft reject'),
    noAction: action('no action'),
    learned: stat.learned,
    spamCount: stat.spamCount,
    hamCount: stat.hamCount,
  };
}

/**
 * Признано спамом = отклонено на приёме + помечено заголовком.
 *
 * Складывать их в одно число можно и нужно: и то, и другое — решение
 * фильтра «это спам», разница лишь в том, дошло ли письмо до ящика.
 * Разбивка при этом остаётся рядом: администратору важно видеть, сколько
 * писем ОТКЛОНЕНО (отправитель об этом узнал) против сколько уехало в
 * папку «Спам» (не узнал никто).
 */
export function spamOf(totals: Pick<SpamPeriodTotals, 'reject' | 'addHeader'>): number {
  return totals.reject + totals.addHeader;
}

const int = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

interface TotalsRow {
  scanned: string | null;
  reject: string | null;
  add_header: string | null;
  rewrite_subject: string | null;
  greylist: string | null;
  soft_reject: string | null;
  no_action: string | null;
  learned: string | null;
  restarts: string | null;
  samples: string | null;
  first_at: Date | null;
  last_at: Date | null;
}

export class SpamStore {
  constructor(private readonly db: AdminDb) {}

  /** Применена ли миграция 0022. Без неё раздел работает, но без «за период». */
  async schemaReady(): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT to_regclass('public.rspamd_stat_samples') IS NOT NULL AS ok`,
    );
    return row?.ok === true;
  }

  async insertSample(sample: SpamSampleInput): Promise<void> {
    await this.db.query(
      `INSERT INTO rspamd_stat_samples
         (uptime_seconds, scanned, act_reject, act_add_header, act_rewrite_subject,
          act_greylist, act_soft_reject, act_no_action, learned, spam_count, ham_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        Math.round(sample.uptimeSeconds),
        sample.scanned,
        sample.reject,
        sample.addHeader,
        sample.rewriteSubject,
        sample.greylist,
        sample.softReject,
        sample.noAction,
        sample.learned,
        sample.spamCount,
        sample.hamCount,
      ],
    );
  }

  /**
   * Сумма приростов за окно.
   *
   * Правило перезапуска (см. шапку файла) записано один раз в SQL-выражении
   * и применяется ко всем счётчикам одинаково — руками его не повторяем,
   * иначе один из счётчиков рано или поздно посчитается иначе.
   */
  async totals(from: Date, to: Date): Promise<SpamPeriodTotals> {
    // GREATEST(...,0) страхует от невозможного, но не смертельного случая:
    // счётчик уменьшился, а время работы не упало. Отрицательный прирост в
    // сумме означал бы «спама стало минус пять писем», и это хуже, чем
    // потерять несколько событий.
    const delta = (column: string): string =>
      `SUM(CASE
             WHEN prev_uptime IS NULL THEN 0
             WHEN uptime_seconds < prev_uptime THEN ${column}
             ELSE GREATEST(${column} - prev_${column}, 0)
           END)`;
    const rows = await this.db.query<TotalsRow>(
      `WITH windowed AS (
         SELECT taken_at, uptime_seconds, scanned, act_reject, act_add_header,
                act_rewrite_subject, act_greylist, act_soft_reject, act_no_action, learned,
                LAG(uptime_seconds)      OVER w AS prev_uptime,
                LAG(scanned)             OVER w AS prev_scanned,
                LAG(act_reject)          OVER w AS prev_act_reject,
                LAG(act_add_header)      OVER w AS prev_act_add_header,
                LAG(act_rewrite_subject) OVER w AS prev_act_rewrite_subject,
                LAG(act_greylist)        OVER w AS prev_act_greylist,
                LAG(act_soft_reject)     OVER w AS prev_act_soft_reject,
                LAG(act_no_action)       OVER w AS prev_act_no_action,
                LAG(learned)             OVER w AS prev_learned
           FROM rspamd_stat_samples
          WHERE taken_at >= $1 AND taken_at <= $2
         WINDOW w AS (ORDER BY taken_at)
       )
       SELECT ${delta('scanned')}::text             AS scanned,
              ${delta('act_reject')}::text          AS reject,
              ${delta('act_add_header')}::text      AS add_header,
              ${delta('act_rewrite_subject')}::text AS rewrite_subject,
              ${delta('act_greylist')}::text        AS greylist,
              ${delta('act_soft_reject')}::text     AS soft_reject,
              ${delta('act_no_action')}::text       AS no_action,
              ${delta('learned')}::text             AS learned,
              SUM(CASE WHEN prev_uptime IS NOT NULL AND uptime_seconds < prev_uptime
                       THEN 1 ELSE 0 END)::text     AS restarts,
              COUNT(*)::text                        AS samples,
              MIN(taken_at)                         AS first_at,
              MAX(taken_at)                         AS last_at
         FROM windowed`,
      [from, to],
    );
    const row = rows[0];
    return {
      scanned: int(row?.scanned),
      reject: int(row?.reject),
      addHeader: int(row?.add_header),
      rewriteSubject: int(row?.rewrite_subject),
      greylist: int(row?.greylist),
      softReject: int(row?.soft_reject),
      noAction: int(row?.no_action),
      learned: int(row?.learned),
      restarts: int(row?.restarts),
      samples: int(row?.samples),
      from: row?.first_at ? row.first_at.toISOString() : null,
      to: row?.last_at ? row.last_at.toISOString() : null,
    };
  }

  /**
   * Сколько раз обучали ВРУЧНУЮ и кто.
   *
   * Считается по журналу аудита, а не по счётчику rspamd, и это не обход
   * лёгким путём. Счётчик `learned` в /stat складывает ручное обучение с
   * автоматическим (autolearn = true), то есть на живом сервере он растёт
   * сам по себе и о работе администратора не говорит ничего. Ответ на
   * вопрос «сколько разобрали руками» есть только в аудите — там же видно,
   * кто именно разбирал.
   */
  async manualLearns(from: Date, to: Date): Promise<{ spam: number; ham: number }> {
    const rows = await this.db.query<{ action: string; count: string }>(
      `SELECT action, count(*)::text AS count
         FROM admin_audit_log
        WHERE created_at >= $1 AND created_at <= $2
          AND action IN ('antispam.learn.spam', 'antispam.learn.ham')
        GROUP BY action`,
      [from, to],
    );
    const of = (action: string): number =>
      int(rows.find((row) => row.action === action)?.count);
    return { spam: of('antispam.learn.spam'), ham: of('antispam.learn.ham') };
  }

  /** С какого момента вообще есть снимки — чтобы не врать про «за 30 суток». */
  async collectingSince(): Promise<string | null> {
    const row = await this.db.one<{ first_at: Date | null }>(
      `SELECT MIN(taken_at) AS first_at FROM rspamd_stat_samples`,
    );
    return row?.first_at ? row.first_at.toISOString() : null;
  }

  /** Уборка старых снимков — теми же пределами, что и у остальных показателей. */
  async prune(retentionDays: number, maxRows: number): Promise<number> {
    let removed = 0;
    if (retentionDays > 0) {
      const rows = await this.db.query<{ id: string }>(
        `DELETE FROM rspamd_stat_samples
          WHERE taken_at < now() - ($1 || ' days')::interval
          RETURNING id`,
        [String(retentionDays)],
      );
      removed += rows.length;
    }
    if (maxRows > 0) {
      const rows = await this.db.query<{ id: string }>(
        `DELETE FROM rspamd_stat_samples
          WHERE id IN (
            SELECT id FROM rspamd_stat_samples ORDER BY taken_at DESC OFFSET $1
          )
          RETURNING id`,
        [maxRows],
      );
      removed += rows.length;
    }
    return removed;
  }
}
