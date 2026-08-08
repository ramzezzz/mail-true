/**
 * Проверки, для которых достаточно ЧИТАТЬ два каталога.
 *
 * Обе долго стояли в списке «чего этот раздел не проверяет» с честной
 * причиной: «каталог в контейнере отсутствует». Причина устранима — это
 * не секреты и не сокет Docker, а файлы миграций продукта и одна строка
 * с датой. Оба каталога смонтированы только на чтение (см. api.volumes
 * в infra/docker-compose.yml).
 *
 * Вопросы, на которые они отвечают, задают чаще прочих:
 *
 *   «Схема базы соответствует версии продукта?» — после обновления это
 *   первое, что нужно знать: непримененная миграция проявляется не сразу
 *   и не там, а разделом, который отвечает 500 через неделю.
 *
 *   «Когда в последний раз снимали копию?» — вопрос, на который нельзя
 *   отвечать «наверное, недавно».
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckState, HealthCheck } from './selfcheck.js';

/** Сколько суток резервная копия считается свежей. */
export const BACKUP_WARN_DAYS = 7;
export const BACKUP_FAIL_DAYS = 30;

/** Имя файла, в который install/backup.sh пишет время последней копии. */
const LAST_BACKUP_FILE = 'last-backup';

export interface MigrationCheckInput {
  /** Каталог с файлами миграций. Пусто — не смонтирован. */
  dir: string;
  /** Имена файлов, отмеченных в журнале schema_migrations. */
  applied: ReadonlySet<string>;
}

/**
 * Сверка файлов миграций с журналом.
 *
 * Сравнивается ИМЕНАМИ, а не содержимым: контрольные суммы уже сверяет
 * установщик при накатке (см. apply_migrations в install/lib/common.sh),
 * и повторять это на каждое открытие страницы незачем. Здесь отвечают на
 * другой вопрос: не отстала ли база от продукта после обновления кода.
 */
export function gradeMigrations(input: {
  files: readonly string[];
  applied: ReadonlySet<string>;
}): HealthCheck {
  const { files, applied } = input;

  if (files.length === 0) {
    return {
      id: 'migrations',
      group: 'Обновление',
      title: 'Схема базы и файлы миграций',
      state: 'unknown',
      detail: 'Каталог миграций не виден серверу приложения.',
      hint: 'Проверьте, что том ./postgres/migrations смонтирован в контейнер api.',
    };
  }

  const missing = files.filter((name) => !applied.has(name));
  if (missing.length === 0) {
    return {
      id: 'migrations',
      group: 'Обновление',
      title: 'Схема базы и файлы миграций',
      state: 'ok',
      detail: `Все ${String(files.length)} миграций применены.`,
    };
  }

  /*
   * Отказ, а не предупреждение. Непримененная миграция — это не «мелкое
   * расхождение»: код уже ждёт таблицу или колонку, которых нет, и
   * узнается это отказом раздела в самый неподходящий момент.
   */
  const shown = missing.slice(0, 3).join(', ');
  return {
    id: 'migrations',
    group: 'Обновление',
    title: 'Схема базы и файлы миграций',
    state: 'fail',
    detail:
      `Не применено миграций: ${String(missing.length)} из ${String(files.length)} — ${shown}` +
      (missing.length > 3 ? ' и другие' : '') +
      '.',
    hint:
      'Накатить их умеет установщик, повторный запуск безопасен: ' +
      'sudo bash install/install.sh --prepare-only && sudo bash install/install.sh',
  };
}

/** Свежесть резервной копии по времени из отметки. */
export function gradeBackup(input: { at: Date | null; now?: Date }): HealthCheck {
  const now = input.now ?? new Date();

  if (input.at === null) {
    return {
      id: 'backup',
      group: 'Обновление',
      title: 'Резервная копия',
      state: 'warn',
      detail: 'Отметки о резервной копии нет: похоже, её ни разу не снимали.',
      hint: 'Снять и проверить восстановление: sudo bash install/backup.sh',
    };
  }

  const days = Math.floor((now.getTime() - input.at.getTime()) / 86_400_000);
  const when = input.at.toISOString().slice(0, 10);
  let state: CheckState = 'ok';
  if (days >= BACKUP_FAIL_DAYS) state = 'fail';
  else if (days >= BACKUP_WARN_DAYS) state = 'warn';

  const detail =
    days <= 0
      ? `Последняя копия снята сегодня (${when}).`
      : `Последняя копия снята ${String(days)} сут. назад (${when}).`;

  if (state === 'ok') {
    return { id: 'backup', group: 'Обновление', title: 'Резервная копия', state, detail };
  }
  return {
    id: 'backup',
    group: 'Обновление',
    title: 'Резервная копия',
    state,
    detail,
    hint:
      'Копия старше месяца равносильна её отсутствию: за это время меняются и письма, и ' +
      'настройки. Снять: sudo bash install/backup.sh',
  };
}

/** Имена файлов миграций в каталоге. Нет каталога — пустой список. */
export async function readMigrationFiles(dir: string): Promise<string[]> {
  if (dir === '') return [];
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

/**
 * Время последней резервной копии.
 *
 * Внутри файла — строка ISO, её и читаем; если содержимое испорчено,
 * берём время изменения самого файла. Врать «копий нет» из-за одной
 * кривой строки нельзя: копия-то есть.
 */
export async function readLastBackup(dir: string): Promise<Date | null> {
  if (dir === '') return null;
  const path = join(dir, LAST_BACKUP_FILE);
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  } catch {
    return null;
  }
  try {
    return (await stat(path)).mtime;
  } catch {
    return null;
  }
}
