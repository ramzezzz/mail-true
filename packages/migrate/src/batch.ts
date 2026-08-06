/**
 * Пакетный перенос: очередь ящиков с ограничением параллельности.
 *
 * Список ящиков принимается в CSV или JSON. Формат CSV (первая строка —
 * заголовок; разделитель «,» или «;» определяется автоматически):
 *
 *   source_host,source_port,source_secure,source_user,source_pass,dest_user,dest_pass[,dest_host,dest_port,dest_secure]
 *
 * Колонки dest_host/dest_port/dest_secure можно опустить и задать значения
 * по умолчанию параметром destDefaults (обычно наш сервер один для всех).
 *
 * Формат JSON — массив объектов BatchAccount (см. types.ts) или объектов
 * с теми же плоскими полями, что и в CSV.
 */

import { z } from 'zod';
import { parseCsvWithHeader } from './csv.js';
import { MailboxMigrator } from './migrator.js';
import type {
  BatchAccount,
  BatchReport,
  ImapEndpoint,
  MailboxReport,
  MigrateMailboxOptions,
  ProgressEvent,
} from './types.js';

/** Значения по умолчанию для приёмника (наш сервер). */
export interface DestDefaults {
  host?: string;
  port?: number;
  secure?: boolean;
  allowInsecureTls?: boolean;
}

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'да'].includes(v.trim().toLowerCase())));

const portish = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
  .pipe(z.number().int().min(1).max(65535));

/** Плоская строка задания (CSV или «плоский» JSON). */
const flatAccountSchema = z.object({
  source_host: z.string().min(1),
  source_port: portish.optional(),
  source_secure: boolish.optional(),
  source_user: z.string().min(1),
  source_pass: z.string().min(1),
  dest_host: z.string().min(1).optional(),
  dest_port: portish.optional(),
  dest_secure: boolish.optional(),
  dest_user: z.string().min(1),
  dest_pass: z.string().min(1),
});

/** Построить endpoint, не создавая undefined-полей (exactOptionalPropertyTypes). */
function endpoint(
  base: { host: string; port?: number | undefined; secure?: boolean | undefined },
  user: string,
  pass: string,
  allowInsecureTls: boolean,
): ImapEndpoint {
  return {
    host: base.host,
    ...(base.port !== undefined ? { port: base.port } : {}),
    ...(base.secure !== undefined ? { secure: base.secure } : {}),
    user,
    pass,
    ...(allowInsecureTls ? { allowInsecureTls: true } : {}),
  };
}

/**
 * Разобрать список ящиков из текста файла.
 * @param text содержимое файла
 * @param format 'csv' | 'json' | 'auto' (по первому непробельному символу)
 */
export function parseAccountsList(
  text: string,
  destDefaults: DestDefaults = {},
  format: 'csv' | 'json' | 'auto' = 'auto',
): BatchAccount[] {
  const trimmed = text.trim();
  const isJson = format === 'json' || (format === 'auto' && (trimmed.startsWith('[') || trimmed.startsWith('{')));

  const rows: Array<Record<string, unknown>> = isJson
    ? (JSON.parse(trimmed) as Array<Record<string, unknown>>)
    : parseCsvWithHeader(text);
  if (!Array.isArray(rows)) {
    throw new Error('JSON-список ящиков должен быть массивом объектов');
  }

  return rows.map((row, index) => {
    // Готовый вложенный формат BatchAccount ({source: {...}, dest: {...}})
    if (typeof row['source'] === 'object' && row['source'] !== null) {
      return row as unknown as BatchAccount;
    }
    const parsed = flatAccountSchema.safeParse(row);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`строка ${index + 1} списка ящиков: ${problems}`);
    }
    const a = parsed.data;
    const destHost = a.dest_host ?? destDefaults.host;
    if (!destHost) {
      throw new Error(`строка ${index + 1}: не задан dest_host (и нет значения по умолчанию)`);
    }
    return {
      source: endpoint(
        { host: a.source_host, port: a.source_port, secure: a.source_secure },
        a.source_user,
        a.source_pass,
        true, // у чужих серверов часто самоподписанные сертификаты
      ),
      dest: endpoint(
        {
          host: destHost,
          port: a.dest_port ?? destDefaults.port,
          secure: a.dest_secure ?? destDefaults.secure,
        },
        a.dest_user,
        a.dest_pass,
        destDefaults.allowInsecureTls ?? true,
      ),
    };
  });
}

/** Настройки пакетного переноса. */
export interface BatchOptions {
  accounts: BatchAccount[];
  /** Сколько ящиков переносить одновременно (по умолчанию 2). */
  concurrency?: number;
  /** Общие настройки переноса (state, batchSize, mapping и т.д.). */
  migrate?: Omit<MigrateMailboxOptions, 'source' | 'dest' | 'mapping' | 'onProgress'>;
  /** Прогресс: событие + к какому ящику оно относится. */
  onProgress?: (accountIndex: number, account: BatchAccount, event: ProgressEvent) => void;
  /** Вызывается после завершения каждого ящика. */
  onAccountDone?: (accountIndex: number, report: MailboxReport) => void;
}

/** Перенести список ящиков с ограничением параллельности. */
export async function migrateBatch(options: BatchOptions): Promise<BatchReport> {
  const startedAt = new Date();
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const queue = options.accounts.map((account, index) => ({ account, index }));
  const reports: MailboxReport[] = new Array<MailboxReport>(queue.length);

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      // Остановка задания: ящики, до которых очередь не дошла, не начинаем
      // вовсе. Отчёта у них не будет — и это честно: их не трогали.
      if (options.migrate?.signal?.aborted === true) return;
      const { account, index } = item;
      const migrator = new MailboxMigrator({
        ...options.migrate,
        source: account.source,
        dest: account.dest,
        ...(account.mapping ? { mapping: account.mapping } : {}),
        onProgress: (event) => options.onProgress?.(index, account, event),
      });
      const report = await migrator.run();
      reports[index] = report;
      options.onAccountDone?.(index, report);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  const finishedAt = new Date();
  // Дыры в массиве отчётов остаются после остановки: до части ящиков очередь
  // не дошла. В отчёт они попадать не должны — «ящик без отчёта» читается
  // как сломанный, а он просто не начинался.
  const done = reports.filter((r): r is MailboxReport => r !== undefined);
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    accounts: done,
    ok: done.filter((r) => r.status === 'ok').length,
    partial: done.filter((r) => r.status === 'partial').length,
    failed: done.filter((r) => r.status === 'failed').length,
    stopped: done.filter((r) => r.status === 'stopped').length,
  };
}
