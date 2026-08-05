/**
 * Живой сквозной тест переноса на реальном стеке (infra/docker-compose.yml).
 *
 * Оба конца — наш Dovecot: ящик-источник наполняется письмами через
 * IMAP APPEND (разные папки, флаги, метки, даты, вложение, письмо без
 * Message-ID), затем выполняется перенос в ящик-приёмник и проверяется:
 *   1) число писем в каждой папке совпадает;
 *   2) вложенные папки созданы;
 *   3) флаги, пользовательские метки и INTERNALDATE сохранены;
 *   4) письмо с вложением дошло байт в байт (по размеру и структуре);
 *   5) повторный запуск не создаёт дублей (докачка по состоянию);
 *   6) запуск с потерянным файлом состояния тоже не создаёт дублей
 *      (дедупликация по содержимому приёмника);
 *   7) smoke-тест PgStateStore на реальном Postgres (если задан MIGRATE_PG_DSN).
 *
 * Запуск: bash packages/migrate/scripts/live-test.sh
 * (скрипт сам создаёт ящики и передаёт параметры через окружение).
 */

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { ImapFlow } from 'imapflow';
import { migrateMailbox } from './migrator.js';
import { FileStateStore, PgStateStore } from './state.js';
import type { ImapEndpoint, MailboxReport } from './types.js';

const HOST = process.env['MIGRATE_TEST_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['MIGRATE_TEST_PORT'] ?? '143', 10);
const SRC_USER = process.env['MIGRATE_TEST_SRC'] ?? 'migsrc@mail.local';
const DST_USER = process.env['MIGRATE_TEST_DST'] ?? 'migdst@mail.local';
const PASSWORD = process.env['MIGRATE_TEST_PASS'] ?? 'migr8-test-12345';
const PG_DSN = process.env['MIGRATE_PG_DSN'];

const SYSTEM_FOLDERS = new Set(['INBOX', 'Sent', 'Drafts', 'Spam', 'Trash']);

let failures = 0;
function check(name: string, ok: boolean, details = ''): void {
  const mark = ok ? 'OK  ' : 'FAIL';
  process.stdout.write(`  [${mark}] ${name}${details && !ok ? ` — ${details}` : ''}\n`);
  if (!ok) failures++;
}

function endpoint(user: string): ImapEndpoint {
  // Сертификат в dev самоподписанный — проверку отключаем
  return { host: HOST, port: PORT, secure: false, user, pass: PASSWORD, allowInsecureTls: true };
}

function client(user: string): ImapFlow {
  return new ImapFlow({
    host: HOST,
    port: PORT,
    secure: false,
    auth: { user, pass: PASSWORD },
    logger: false,
    tls: { rejectUnauthorized: false }, // самоподписанный сертификат dev-стека
  });
}

/** Собрать RFC822-письмо. */
function rfc822(opts: {
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId?: string;
  body?: string;
  attachment?: { filename: string; content: Buffer };
}): string {
  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date}`,
  ];
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`);
  lines.push('MIME-Version: 1.0');
  if (opts.attachment) {
    const boundary = 'lt-boundary-42';
    lines.push(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body ?? 'Текст письма с вложением.',
      '',
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${opts.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      '',
      opts.attachment.content.toString('base64'),
      `--${boundary}--`,
      '',
    );
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', opts.body ?? 'Тестовое письмо.', '');
  }
  return lines.join('\r\n');
}

/** Полностью очистить ящик: все письма, все несистемные папки. */
async function purgeMailbox(user: string): Promise<void> {
  const c = client(user);
  await c.connect();
  try {
    const folders = await c.list();
    // Сначала удаляем письма во всех выбираемых папках
    for (const f of folders) {
      if (f.flags.has('\\Noselect')) continue;
      const lock = await c.getMailboxLock(f.path);
      try {
        const mb = typeof c.mailbox === 'object' ? c.mailbox : null;
        if (mb && mb.exists > 0) await c.messageDelete('1:*');
      } finally {
        lock.release();
      }
    }
    // Затем удаляем несистемные папки, глубокие — первыми
    const custom = folders
      .filter((f) => !SYSTEM_FOLDERS.has(f.path) && f.path.toUpperCase() !== 'INBOX')
      .sort((a, b) => b.path.length - a.path.length);
    for (const f of custom) {
      try {
        await c.mailboxDelete(f.path);
      } catch {
        /* например, \Noselect-контейнер — не мешает */
      }
    }
  } finally {
    await c.logout();
  }
}

interface SeededMessage {
  folder: string;
  subject: string;
  flags: string[];
  internalDate: Date;
  size: number;
  hasAttachment?: boolean;
  noMessageId?: boolean;
}

/** Наполнить ящик-источник тестовым содержимым. */
async function seedSource(): Promise<SeededMessage[]> {
  const c = client(SRC_USER);
  await c.connect();
  const seeded: SeededMessage[] = [];
  try {
    await c.mailboxCreate('Projects').catch(() => undefined);
    await c.mailboxCreate('Projects/Alpha').catch(() => undefined);

    const put = async (
      folder: string,
      opts: Parameters<typeof rfc822>[0],
      flags: string[],
      internalDate: Date,
      extra: Partial<SeededMessage> = {},
    ): Promise<void> => {
      const raw = rfc822(opts);
      await c.append(folder, raw, flags, internalDate);
      seeded.push({
        folder,
        subject: opts.subject,
        flags,
        internalDate,
        size: Buffer.byteLength(raw),
        ...extra,
      });
    };

    await put(
      'INBOX',
      {
        from: 'partner@example.com',
        to: SRC_USER,
        subject: 'LT-1 прочитанное письмо',
        date: 'Fri, 15 Mar 2024 10:30:00 +0300',
        messageId: '<lt-1@example.com>',
        body: 'Первое письмо, прочитано.',
      },
      ['\\Seen'],
      new Date('2024-03-15T07:30:00Z'),
    );

    // Письмо БЕЗ Message-ID — дедупликация по хешу заголовков и размера
    await put(
      'INBOX',
      {
        from: 'noid@example.com',
        to: SRC_USER,
        subject: 'LT-2 письмо без Message-ID',
        date: 'Wed, 1 Nov 2023 09:00:00 +0300',
        body: 'У этого письма нет Message-ID.',
      },
      ['\\Flagged'],
      new Date('2023-11-01T06:00:00Z'),
      { noMessageId: true },
    );

    await put(
      'INBOX',
      {
        from: 'reports@example.com',
        to: SRC_USER,
        subject: 'LT-3 письмо с вложением',
        date: 'Mon, 20 Jan 2025 15:45:00 +0300',
        messageId: '<lt-3@example.com>',
        attachment: { filename: 'report.bin', content: Buffer.alloc(2048, 7) },
      },
      ['\\Answered', '\\Seen'],
      new Date('2025-01-20T12:45:00Z'),
      { hasAttachment: true },
    );

    await put(
      'Sent',
      {
        from: SRC_USER,
        to: 'partner@example.com',
        subject: 'LT-4 отправленное',
        date: 'Tue, 2 Apr 2024 11:00:00 +0300',
        messageId: '<lt-4@example.com>',
      },
      ['\\Seen'],
      new Date('2024-04-02T08:00:00Z'),
    );

    await put(
      'Drafts',
      {
        from: SRC_USER,
        to: 'someone@example.com',
        subject: 'LT-5 черновик',
        date: 'Thu, 5 Jun 2025 12:00:00 +0300',
        messageId: '<lt-5@example.com>',
      },
      ['\\Draft'],
      new Date('2025-06-05T09:00:00Z'),
    );

    await put(
      'Trash',
      {
        from: 'spammer@example.com',
        to: SRC_USER,
        subject: 'LT-6 удалённое',
        date: 'Sat, 10 Aug 2024 08:00:00 +0300',
        messageId: '<lt-6@example.com>',
      },
      ['\\Seen'],
      new Date('2024-08-10T05:00:00Z'),
    );

    await put(
      'Projects',
      {
        from: 'team@example.com',
        to: SRC_USER,
        subject: 'LT-7 проектное',
        date: 'Mon, 3 Feb 2025 10:00:00 +0300',
        messageId: '<lt-7@example.com>',
      },
      [],
      new Date('2025-02-03T07:00:00Z'),
    );

    // Пользовательская метка (keyword) MyLabel
    await put(
      'Projects/Alpha',
      {
        from: 'alpha@example.com',
        to: SRC_USER,
        subject: 'LT-8 с пользовательской меткой',
        date: 'Tue, 4 Feb 2025 10:00:00 +0300',
        messageId: '<lt-8@example.com>',
      },
      ['\\Seen', 'MyLabel'],
      new Date('2025-02-04T07:00:00Z'),
    );

    await put(
      'Projects/Alpha',
      {
        from: 'alpha@example.com',
        to: SRC_USER,
        subject: 'LT-9 вложенная папка',
        date: 'Wed, 5 Feb 2025 10:00:00 +0300',
        messageId: '<lt-9@example.com>',
      },
      [],
      new Date('2025-02-05T07:00:00Z'),
    );
  } finally {
    await c.logout();
  }
  return seeded;
}

interface DestMessage {
  subject: string;
  flags: Set<string>;
  internalDate: Date | null;
  size: number;
}

/** Снять полное содержимое ящика: папка → письма. */
async function snapshot(user: string): Promise<Map<string, DestMessage[]>> {
  const c = client(user);
  await c.connect();
  const result = new Map<string, DestMessage[]>();
  try {
    const folders = await c.list();
    for (const f of folders) {
      if (f.flags.has('\\Noselect')) continue;
      const messages: DestMessage[] = [];
      const lock = await c.getMailboxLock(f.path);
      try {
        const mb = typeof c.mailbox === 'object' ? c.mailbox : null;
        if (mb && mb.exists > 0) {
          for await (const msg of c.fetch('1:*', {
            uid: true,
            flags: true,
            internalDate: true,
            envelope: true,
            size: true,
          })) {
            messages.push({
              subject: msg.envelope?.subject ?? '',
              flags: msg.flags ?? new Set(),
              internalDate:
                msg.internalDate instanceof Date
                  ? msg.internalDate
                  : msg.internalDate
                    ? new Date(msg.internalDate)
                    : null,
              size: msg.size ?? 0,
            });
          }
        }
      } finally {
        lock.release();
      }
      result.set(f.path, messages);
    }
  } finally {
    await c.logout();
  }
  return result;
}

function findMessage(snap: Map<string, DestMessage[]>, folder: string, subjectPrefix: string): DestMessage | undefined {
  return (snap.get(folder) ?? []).find((m) => m.subject.startsWith(subjectPrefix));
}

function totalMessages(snap: Map<string, DestMessage[]>): number {
  let total = 0;
  for (const msgs of snap.values()) total += msgs.length;
  return total;
}

async function runMigration(statePath: string | null): Promise<MailboxReport> {
  const state = statePath !== null ? new FileStateStore(statePath) : undefined;
  return migrateMailbox({
    source: endpoint(SRC_USER),
    dest: endpoint(DST_USER),
    ...(state ? { state } : {}),
  });
}

async function pgSmokeTest(dsn: string): Promise<void> {
  process.stdout.write('\nШаг 6. Smoke-тест PgStateStore на реальном Postgres\n');
  const store = new PgStateStore(dsn);
  try {
    await store.init();
    const acc = `livetest-${Date.now()}`;
    await store.markMigrated(acc, 'INBOX', 'mid:pg-1');
    check('запись и чтение отметки о переносе', await store.wasMigrated(acc, 'INBOX', 'mid:pg-1'));
    check('чужой ключ не найден', !(await store.wasMigrated(acc, 'INBOX', 'mid:pg-2')));
    await store.setCursor(acc, 'INBOX', { uidValidity: '7', lastUid: 99 });
    const cursor = await store.getCursor(acc, 'INBOX');
    check('курсор сохраняется', cursor?.uidValidity === '7' && cursor.lastUid === 99);
    await store.setCursor(acc, 'INBOX', { uidValidity: '7', lastUid: 120 });
    const cursor2 = await store.getCursor(acc, 'INBOX');
    check('курсор обновляется', cursor2?.lastUid === 120);
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const statePath = join(tmpdir(), 'mail-true-migrate-livetest', 'state.jsonl');
  await rm(statePath, { force: true });

  process.stdout.write(`Живой тест переноса: ${SRC_USER} -> ${DST_USER} через ${HOST}:${PORT}\n`);

  process.stdout.write('\nШаг 0. Очистка обоих ящиков\n');
  await purgeMailbox(SRC_USER);
  await purgeMailbox(DST_USER);
  check('ящики очищены', true);

  process.stdout.write('\nШаг 1. Наполнение источника\n');
  const seeded = await seedSource();
  check(`в источник положено ${seeded.length} писем`, seeded.length === 9);

  process.stdout.write('\nШаг 2. Перенос source -> dest\n');
  const report1 = await runMigration(statePath);
  check('статус ok', report1.status === 'ok', `status=${report1.status}, error=${report1.error ?? '-'}`);
  check(`скопировано ${report1.copied} из 9`, report1.copied === 9);
  check('ошибок нет', report1.failed === 0, `failed=${report1.failed}`);

  process.stdout.write('\nШаг 3. Проверка приёмника\n');
  const snap = await snapshot(DST_USER);

  // Папки и количество писем
  const expectByFolder: Record<string, number> = {
    INBOX: 3,
    Sent: 1,
    Drafts: 1,
    Trash: 1,
    Projects: 1,
    'Projects/Alpha': 2,
  };
  for (const [folder, count] of Object.entries(expectByFolder)) {
    const actual = snap.get(folder)?.length ?? -1;
    check(`папка ${folder}: ${count} писем`, actual === count, `фактически ${actual}`);
  }
  check('вложенная папка Projects/Alpha существует', snap.has('Projects/Alpha'));

  // Флаги, метки, даты
  for (const s of seeded) {
    const msg = findMessage(snap, s.folder, s.subject.slice(0, 5));
    if (!msg) {
      check(`письмо «${s.subject}» найдено в ${s.folder}`, false);
      continue;
    }
    const flagsOk = s.flags.every((f) => msg.flags.has(f));
    check(
      `«${s.subject}»: флаги [${s.flags.join(', ') || 'нет'}] сохранены`,
      flagsOk,
      `фактически [${[...msg.flags].join(', ')}]`,
    );
    const dateOk =
      msg.internalDate !== null &&
      Math.abs(msg.internalDate.getTime() - s.internalDate.getTime()) <= 2000;
    check(
      `«${s.subject}»: INTERNALDATE сохранена`,
      dateOk,
      `ожидалось ${s.internalDate.toISOString()}, фактически ${msg.internalDate?.toISOString() ?? 'нет'}`,
    );
    if (s.hasAttachment === true) {
      check(`«${s.subject}»: размер с вложением совпадает`, msg.size === s.size, `ожидалось ${s.size}, фактически ${msg.size}`);
    }
  }
  const labeled = findMessage(snap, 'Projects/Alpha', 'LT-8');
  check('пользовательская метка MyLabel перенесена', labeled?.flags.has('MyLabel') === true);

  process.stdout.write('\nШаг 4. Повторный запуск (докачка по состоянию) — дублей быть не должно\n');
  const before = totalMessages(snap);
  const report2 = await runMigration(statePath);
  check('повторно скопировано 0 писем', report2.copied === 0, `copied=${report2.copied}`);
  const snapAfter2 = await snapshot(DST_USER);
  check(
    `число писем не изменилось (${before})`,
    totalMessages(snapAfter2) === before,
    `стало ${totalMessages(snapAfter2)}`,
  );

  process.stdout.write('\nШаг 5. Запуск с потерянным состоянием — дедупликация по приёмнику\n');
  await rm(statePath, { force: true });
  const report3 = await runMigration(statePath);
  check('скопировано 0 писем (все распознаны как дубли)', report3.copied === 0, `copied=${report3.copied}`);
  check(`пропущено как дубли: ${report3.skipped} из 9`, report3.skipped === 9);
  const snapAfter3 = await snapshot(DST_USER);
  check(
    `число писем не изменилось (${before})`,
    totalMessages(snapAfter3) === before,
    `стало ${totalMessages(snapAfter3)}`,
  );

  if (PG_DSN !== undefined && PG_DSN.length > 0) {
    await pgSmokeTest(PG_DSN);
  } else {
    process.stdout.write('\nШаг 6 пропущен: MIGRATE_PG_DSN не задан (smoke-тест Postgres)\n');
  }

  process.stdout.write(`\n${failures === 0 ? 'ЖИВОЙ ТЕСТ ПРОЙДЕН' : `ЖИВОЙ ТЕСТ ПРОВАЛЕН: ${failures} ошибок`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`Сбой живого теста: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
