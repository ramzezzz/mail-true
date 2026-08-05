/**
 * Получение паролей для переноса, не оставляя их в списке процессов.
 *
 * Аргумент командной строки виден в системе КАЖДОМУ: `ps aux`,
 * `/proc/<pid>/cmdline` читаются любым непривилегированным пользователем.
 * Перенос большого ящика идёт часами, и всё это время пароли от чужого
 * почтового сервера и от нашего висят у всех на виду.
 *
 * Поэтому пароль можно передать (в порядке предпочтения):
 *   1. файлом — `--source-pass-file /root/kerio.pass` (читается первая строка);
 *   2. именем переменной окружения — `--source-pass-env KERIO_PASS`;
 *   3. переменной по умолчанию — MIGRATE_SOURCE_PASS / MIGRATE_DEST_PASS;
 *   4. как раньше, `--source-pass ...` — работает, но с предупреждением.
 */

import { chmod, readFile, writeFile } from 'node:fs/promises';

/**
 * Записать файл, который никто, кроме владельца, читать не должен.
 *
 * Выгрузка Kerio содержит пароли ОТКРЫТЫМ ТЕКСТОМ, а `kerio-users --out`
 * создавал файл с правами по умолчанию: при обычном umask 022 это 644,
 * то есть пароли всех сотрудников читались любым пользователем системы.
 *
 * `mode` у writeFile действует только при СОЗДАНИИ файла, поэтому права
 * выставляются ещё раз явно — иначе перезапись уже существующего файла
 * оставила бы прежние, возможно всеобщие, права.
 */
export async function writeSecretFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* Windows и часть файловых систем прав не поддерживают — не повод падать */
  }
}

/** Откуда пробовать взять пароль. */
export interface PasswordSources {
  /** Путь к файлу с паролем (--<prefix>-pass-file). */
  file?: string | undefined;
  /** Имя переменной окружения (--<prefix>-pass-env). */
  envName?: string | undefined;
  /** Имя переменной окружения по умолчанию. */
  defaultEnvName: string;
  /** Значение из --<prefix>-pass (небезопасно). */
  inline?: string | undefined;
  /** Окружение (для тестов). */
  env?: NodeJS.ProcessEnv | undefined;
  /** Куда писать предупреждение о небезопасном способе. */
  warn?: ((message: string) => void) | undefined;
  /** Чтение файла (для тестов). */
  readFileImpl?: ((path: string) => Promise<string>) | undefined;
}

/** Ошибка получения пароля — CLI превращает её в понятное сообщение. */
export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordError';
  }
}

/**
 * Взять пароль из самого безопасного доступного источника.
 * Бросает PasswordError, если пароля нет нигде.
 */
export async function resolvePassword(sources: PasswordSources): Promise<string> {
  const env = sources.env ?? process.env;
  const read = sources.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));

  if (sources.file !== undefined && sources.file.length > 0) {
    let text: string;
    try {
      text = await read(sources.file);
    } catch (err) {
      throw new PasswordError(
        `не удалось прочитать файл с паролем ${sources.file}: ${(err as Error).message}`,
      );
    }
    // Именно первая строка: файл, созданный `echo пароль > f`, оканчивается
    // переводом строки, и он не должен попасть в пароль.
    const value = text.split(/\r?\n/, 1)[0] ?? '';
    if (value.length === 0) throw new PasswordError(`файл с паролем пуст: ${sources.file}`);
    return value;
  }

  if (sources.envName !== undefined && sources.envName.length > 0) {
    const value = env[sources.envName];
    if (value === undefined || value.length === 0) {
      throw new PasswordError(`переменная окружения ${sources.envName} пуста или не задана`);
    }
    return value;
  }

  const fromDefaultEnv = env[sources.defaultEnvName];
  if (fromDefaultEnv !== undefined && fromDefaultEnv.length > 0) return fromDefaultEnv;

  if (sources.inline !== undefined && sources.inline.length > 0) {
    sources.warn?.(
      'пароль передан аргументом командной строки и виден в списке процессов ' +
        `любому пользователю системы; безопаснее файл или переменная ${sources.defaultEnvName}`,
    );
    return sources.inline;
  }

  throw new PasswordError(
    `пароль не задан: укажите файл (--pass-file), переменную окружения ` +
      `${sources.defaultEnvName} или (небезопасно) --pass`,
  );
}
