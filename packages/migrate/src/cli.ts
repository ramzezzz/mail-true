#!/usr/bin/env node
/**
 * CLI переноса почты.
 *
 * Команды:
 *   run          — перенос одного ящика
 *   batch        — пакетный перенос по списку (CSV/JSON)
 *   kerio-users  — разбор выгрузки пользователей Kerio Connect
 *
 * Примеры:
 *   mail-true-migrate run \
 *     --source-host kerio.example.com --source-port 993 --source-secure \
 *     --source-user ivanov --source-pass '...' \
 *     --dest-host 127.0.0.1 --dest-port 143 \
 *     --dest-user ivanov@mail.local --dest-pass '...' \
 *     --state ./migrate-state/ivanov.jsonl
 *
 *   mail-true-migrate batch --file accounts.csv --concurrency 2 \
 *     --dest-host 127.0.0.1 --dest-port 143 --state-dir ./migrate-state
 *
 *   mail-true-migrate kerio-users --file users_example.com_2026.csv \
 *     --domain mail.local --out users.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { migrateMailbox } from './migrator.js';
import { migrateBatch, parseAccountsList } from './batch.js';
import { createStateStore } from './state.js';
import { resolvePassword, writeSecretFile, PasswordError } from './secrets.js';
import { CsvParseError } from './csv.js';
import {
  parseKerioUsersCsv,
  parseKerioUsersCfg,
  toMailboxList,
  domainFromKerioFilename,
} from './kerio-users.js';
import type {
  FolderMappingOptions,
  ImapEndpoint,
  MailboxReport,
  ProgressEvent,
} from './types.js';

/** Простейший разбор аргументов: --key value, --flag, повторяющиеся --map. */
function parseArgs(argv: string[]): { positional: string[]; options: Map<string, string[]> } {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    let value = 'true';
    if (next !== undefined && !next.startsWith('--')) {
      value = next;
      i++;
    }
    const list = options.get(key) ?? [];
    list.push(value);
    options.set(key, list);
  }
  return { positional, options };
}

function opt(options: Map<string, string[]>, key: string): string | undefined {
  return options.get(key)?.at(-1);
}

function optAll(options: Map<string, string[]>, key: string): string[] {
  return options.get(key) ?? [];
}

function required(options: Map<string, string[]>, key: string): string {
  const value = opt(options, key);
  if (value === undefined) {
    fail(`не задан обязательный параметр --${key}`);
  }
  return value;
}

function fail(message: string): never {
  process.stderr.write(`Ошибка: ${message}\n`);
  process.exit(2);
}


/** Пароль эндпоинта: файл, переменная окружения или (небезопасно) аргумент. */
async function passwordFromArgs(
  options: Map<string, string[]>,
  prefix: 'source' | 'dest',
): Promise<string> {
  const flag = (name: string): string | undefined => {
    const v = opt(options, name);
    return v === undefined || v === 'true' ? undefined : v;
  };
  try {
    return await resolvePassword({
      file: flag(`${prefix}-pass-file`),
      envName: flag(`${prefix}-pass-env`),
      defaultEnvName: prefix === 'source' ? 'MIGRATE_SOURCE_PASS' : 'MIGRATE_DEST_PASS',
      inline: flag(`${prefix}-pass`),
      warn: (m) => void process.stderr.write(`Предупреждение (${prefix}): ${m}\n`),
    });
  } catch (err) {
    fail(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function endpointFromArgs(
  options: Map<string, string[]>,
  prefix: 'source' | 'dest',
): Promise<ImapEndpoint> {
  const port = opt(options, `${prefix}-port`);
  const secure = options.has(`${prefix}-secure`);
  return {
    host: required(options, `${prefix}-host`),
    ...(port !== undefined ? { port: Number.parseInt(port, 10) } : {}),
    secure,
    user: required(options, `${prefix}-user`),
    pass: await passwordFromArgs(options, prefix),
    // В dev и при самоподписанных сертификатах проверку отключаем;
    // --strict-tls возвращает строгую проверку.
    allowInsecureTls: !options.has('strict-tls'),
  };
}

function mappingFromArgs(options: Map<string, string[]>): FolderMappingOptions {
  const overrides: Record<string, string> = {};
  for (const pair of optAll(options, 'map')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) fail(`--map ожидает формат 'Источник=Приёмник', получено: ${pair}`);
    overrides[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const exclude = optAll(options, 'exclude');
  return {
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

/** Печать прогресса в консоль. */
function printProgress(prefix: string, event: ProgressEvent): void {
  const out = (s: string): void => void process.stdout.write(`${prefix}${s}\n`);
  switch (event.type) {
    case 'folders':
      out(`план папок (${event.mappings.length}):`);
      for (const m of event.mappings) {
        const role = m.role ? ` [${m.role}]` : '';
        out(`  ${m.source.path} -> ${m.destPath}${role} (${m.reason})`);
      }
      break;
    case 'start':
      out(`старт: ${event.folders} папок, ~${event.messages} писем`);
      break;
    case 'folder-start':
      out(`папка ${event.sourcePath} -> ${event.destPath}: к переносу ${event.toCopy} из ${event.total}`);
      break;
    case 'message':
      if (event.status === 'failed' || (event.copied + event.failed) % 100 === 0) {
        out(
          `  ${event.destPath}: скопировано ${event.copied}, пропущено ${event.skipped}, ошибок ${event.failed}`,
        );
      }
      break;
    case 'folder-done':
      out(
        `папка готова ${event.sourcePath}: скопировано ${event.copied}, пропущено (дубли) ${event.skipped}, ошибок ${event.failed}`,
      );
      break;
    case 'retry': {
      const where = event.sourcePath !== undefined ? ` в папке «${event.sourcePath}»` : '';
      out(`сбой${where}, попытка ${event.attempt}/${event.maxAttempts}: ${event.error}`);
      break;
    }
    case 'folder-renamed':
      out(
        `имя папки «${event.destPath}» приёмник не принял (${event.reason}); ` +
          `перенос в «${event.usedPath}»`,
      );
      break;
    case 'done':
      break;
    default:
      break;
  }
}

function printReport(report: MailboxReport): void {
  const out = (s: string): void => void process.stdout.write(`${s}\n`);
  out('');
  out(`Итог для ${report.sourceUser} -> ${report.destUser}: ${report.status}`);
  out(
    `  всего писем: ${report.totalMessages}, скопировано: ${report.copied}, пропущено (уже были): ${report.skipped}, ошибок: ${report.failed}`,
  );
  out(`  время: ${(report.durationMs / 1000).toFixed(1)} с`);
  for (const f of report.folders) {
    if (f.errors.length > 0) {
      out(`  ошибки в ${f.sourcePath}:`);
      for (const e of f.errors) out(`    - ${e}`);
    }
  }
  if (report.error !== undefined) out(`  ошибка: ${report.error}`);
}

async function cmdRun(options: Map<string, string[]>): Promise<number> {
  const statePath = opt(options, 'state');
  const batchSize = opt(options, 'batch-size');
  const maxAttempts = opt(options, 'max-attempts');
  const report = await migrateMailbox({
    source: await endpointFromArgs(options, 'source'),
    dest: await endpointFromArgs(options, 'dest'),
    mapping: mappingFromArgs(options),
    ...(statePath !== undefined ? { state: createStateStore(statePath) } : {}),
    ...(batchSize !== undefined ? { batchSize: Number.parseInt(batchSize, 10) } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts: Number.parseInt(maxAttempts, 10) } : {}),
    ...(options.has('dry-run') ? { dryRun: true } : {}),
    onProgress: (e) => printProgress('', e),
  });
  printReport(report);
  const jsonOut = opt(options, 'report');
  if (jsonOut !== undefined) await writeFile(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  return report.status === 'failed' ? 1 : 0;
}

async function cmdBatch(options: Map<string, string[]>): Promise<number> {
  const file = required(options, 'file');
  const text = await readFile(file, 'utf8');
  const destHost = opt(options, 'dest-host');
  const destPort = opt(options, 'dest-port');
  const accounts = parseAccountsList(text, {
    ...(destHost !== undefined ? { host: destHost } : {}),
    ...(destPort !== undefined ? { port: Number.parseInt(destPort, 10) } : {}),
    secure: options.has('dest-secure'),
  });
  const stateDir = opt(options, 'state-dir');
  const stateSpec = opt(options, 'state');
  const concurrency = opt(options, 'concurrency');

  // Состояние: общее (--state, обычно pg:...) или файл в каталоге --state-dir.
  // Записи в хранилище ключуются парой источник->приёмник, поэтому одно
  // хранилище безопасно делить между всеми ящиками пакета.
  const sharedState =
    stateSpec !== undefined
      ? createStateStore(stateSpec)
      : stateDir !== undefined
        ? createStateStore(join(stateDir, 'batch-state.jsonl'))
        : undefined;

  const report = await migrateBatch({
    accounts,
    ...(concurrency !== undefined ? { concurrency: Number.parseInt(concurrency, 10) } : {}),
    migrate: sharedState ? { state: sharedState } : {},
    onProgress: (_i, account, e) => printProgress(`[${account.dest.user}] `, e),
    onAccountDone: (_i, r) => printReport(r),
  });

  await sharedState?.close();
  process.stdout.write(
    `\nПакет завершён: ok=${report.ok}, partial=${report.partial}, failed=${report.failed}\n`,
  );
  const jsonOut = opt(options, 'report');
  if (jsonOut !== undefined) await writeFile(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  return report.failed > 0 ? 1 : 0;
}

async function cmdKerioUsers(options: Map<string, string[]>): Promise<number> {
  const file = required(options, 'file');
  const text = await readFile(file, 'utf8');
  const users = file.endsWith('.cfg') || text.trimStart().startsWith('<')
    ? parseKerioUsersCfg(text)
    : parseKerioUsersCsv(text);
  // Домен: параметр --domain или имя файла выгрузки users_<домен>_<дата>.csv
  const domain = opt(options, 'domain') ?? domainFromKerioFilename(file) ?? undefined;
  // Пароли в выгрузке Kerio лежат открытым текстом — в вывод они попадают
  // только по явному флагу --with-passwords (для немедленного создания ящиков).
  const withPasswords = options.has('with-passwords');
  const result =
    domain !== undefined
      ? toMailboxList(users, domain, withPasswords)
      : users.map((u) => (withPasswords ? u : { ...u, password: u.password !== null ? '<скрыт>' : null }));
  const json = JSON.stringify(result, null, 2);
  const outFile = opt(options, 'out');
  if (outFile !== undefined) {
    // Внутри — пароли открытым текстом из выгрузки Kerio. Раньше файл
    // создавался с правами по умолчанию (при обычном umask 022 — 644),
    // то есть был доступен на чтение всем пользователям системы.
    await writeSecretFile(outFile, json);
    process.stdout.write(`Разобрано пользователей: ${users.length}, результат в ${outFile}\n`);
    if (withPasswords) {
      process.stdout.write(
        `ВНИМАНИЕ: в ${outFile} лежат пароли открытым текстом (права 600). ` +
          `Создайте ящики и удалите файл: shred -u ${outFile}\n`,
      );
    }
  } else {
    process.stdout.write(json + '\n');
  }
  return 0;
}

const HELP = `Перенос почты Mail.True (IMAP -> IMAP)

Команды:
  run          перенос одного ящика
  batch        пакетный перенос по списку ящиков (CSV или JSON)
  kerio-users  разбор выгрузки пользователей Kerio Connect (CSV или users.cfg)

Параметры run:
  --source-host --source-port --source-secure --source-user
  --dest-host   --dest-port   --dest-secure   --dest-user

  Пароли (аргумент командной строки виден в списке процессов всем
  пользователям системы, а перенос идёт часами — предпочитайте файл):
  --source-pass-file ФАЙЛ / --dest-pass-file ФАЙЛ   первая строка файла
  --source-pass-env ИМЯ   / --dest-pass-env ИМЯ     имя переменной окружения
  MIGRATE_SOURCE_PASS / MIGRATE_DEST_PASS           переменные по умолчанию
  --source-pass ... / --dest-pass ...               небезопасно, с предупреждением

  --state <файл.jsonl | pg:postgres://...>   состояние для докачки
  --map 'Источник=Приёмник'                  переопределение папки (повторяемый)
  --exclude 'Папка'                          не переносить папку (повторяемый)
  --batch-size N        писем между записями курсора (50)
  --max-attempts N      попыток при обрыве (5)
  --dry-run             только показать план и объёмы
  --strict-tls          строгая проверка сертификатов
  --report файл.json    сохранить отчёт в JSON

Параметры batch:
  --file список.csv|json   [--concurrency N] [--state ... | --state-dir каталог]
  --dest-host/--dest-port/--dest-secure     значения приёмника по умолчанию
  --report файл.json

Параметры kerio-users:
  --file users_домен_дата.csv | users.cfg
  --domain mail.local    домен новых ящиков (по умолчанию — из имени файла)
  --with-passwords       включить пароли из выгрузки (открытый текст!) в вывод
  --out файл.json        сохранить результат
`;

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  let code: number;
  switch (command) {
    case 'run':
      code = await cmdRun(options);
      break;
    case 'batch':
      code = await cmdBatch(options);
      break;
    case 'kerio-users':
      code = await cmdKerioUsers(options);
      break;
    default:
      process.stdout.write(HELP);
      code = command === undefined || command === 'help' ? 0 : 2;
      break;
  }
  process.exit(code);
}

main().catch((err: unknown) => {
  // Ошибки во входных данных (битый CSV, недоступный файл пароля) — это не
  // сбой программы: показываем человеку суть, а не стек вызовов.
  if (err instanceof CsvParseError) {
    process.stderr.write(`Ошибка в CSV: ${err.message}\n`);
    process.stderr.write(
      'Разбор прерван намеренно: иначе остаток файла молча попал бы в одно поле, ' +
        'и ящики для всех последующих строк не были бы созданы.\n',
    );
    process.exit(2);
  }
  if (err instanceof PasswordError) {
    process.stderr.write(`Ошибка: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`Сбой: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
