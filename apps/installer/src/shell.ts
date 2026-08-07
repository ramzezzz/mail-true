/**
 * Запуск внешних команд.
 *
 * Всё, что установщик делает с системой, он делает ЧУЖИМИ руками: bash с
 * подключённым install/lib/common.sh и docker compose. Своей копии логики
 * установки здесь нет и быть не должно — иначе консольная установка и
 * браузерная разошлись бы, и разошлись бы молча.
 */
import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Предел вывода одной команды. Журнал установки идёт мимо — потоком. */
const MAX_BUFFER = 8 * 1024 * 1024;

export function run(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: MAX_BUFFER,
        env: options.env ?? process.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        // Код возврата важнее исключения: «команда вернула 1» — это ответ,
        // а не сбой. Молча превращать его в исключение значит терять текст,
        // который команда написала человеку.
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Выполнить фрагмент на bash с уже подключённым install/lib/common.sh.
 *
 * Это и есть переиспользование установщика: env_get, env_set, порты,
 * список MT_REQUIRED_PORTS, отметка «установлено» — всё берётся оттуда,
 * а не пишется здесь заново.
 */
export function bashWithCommon(
  repoDir: string,
  snippet: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const script = `set -uo pipefail\n. "${repoDir}/install/lib/common.sh"\n${snippet}\n`;
  return run('bash', ['-c', script], {
    ...options,
    env: { ...(options.env ?? process.env), NO_COLOR: '1' },
  });
}

/**
 * Долгий процесс с построчной выдачей.
 *
 * Возвращает функцию остановки и обещание с кодом возврата. Строки
 * отдаются как есть — разбором «\r» занимается журнал (logbuf.ts).
 */
export function spawnStreaming(
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string },
  onChunk: (chunk: string) => void,
): { done: Promise<number>; kill: () => void } {
  const child = spawn(file, [...args], {
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => onChunk(chunk));
  child.stderr.on('data', (chunk: string) => onChunk(chunk));

  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      onChunk(`\nне удалось запустить ${file}: ${err.message}\n`);
      resolve(127);
    });
  });
  return { done, kill: () => child.kill('SIGTERM') };
}
