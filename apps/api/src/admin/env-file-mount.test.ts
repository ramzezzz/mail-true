/**
 * infra/.env нельзя ЗАМЕНЯТЬ — только переписывать поверх.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ВАЖНО РОВНО ДЛЯ ЭТОГО ФАЙЛА
 * ------------------------------------------------------------------
 * infra/.env примонтирован в посредник ОТДЕЛЬНЫМ ФАЙЛОМ
 * (infra/.env -> /env/.env). Такой bind-mount держит не имя, а конкретный
 * файл на диске. Достаточно один раз заменить файл, а не переписать его
 * содержимое, — «sed -i», «mv поверх», install(1), распаковка архива, —
 * и в контейнере остаётся СТАРЫЙ файл, которого в каталоге уже нет: тот
 * же путь, разное содержимое.
 *
 * Дальше всё ломается тихо, и в этом вся беда. Панель сохраняет
 * настройку, посредник честно пишет её в свой файл-призрак, отвечает
 * «готово», служба пересоздаётся — и поднимается с прежним окружением.
 * Ни ошибки, ни расхождения на экране: панель показывает сохранённое
 * значение, потому что оно и правда сохранено, только в базе.
 *
 * Поймано живьём на стенде: у посредника 551 строка, на хосте 552, а
 * источник монтирования один и тот же.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗДЕСЬ ЗАКРЕПЛЕНО
 * ------------------------------------------------------------------
 * 1. Ни один скрипт обслуживания не заменяет infra/.env новым файлом.
 * 2. Посредник умеет заметить, что остался с файлом-призраком, и
 *    отказывается писать вместо тихой записи в никуда.
 * 3. Самопроверка сверяет, тот ли файл видит посредник.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Строки скрипта без комментариев: в них запрет и проверяется. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Команды, которые ЗАМЕНЯЮТ файл, а не переписывают его содержимое.
 *
 * Все они делают одно и то же: создают новый файл и ставят его на место
 * прежнего. Для обычного файла разницы нет — для примонтированного есть.
 * `sed -i` в списке даже без разбора цели: он всегда пишет через
 * временный файл, и правильного применения к .env у него не бывает.
 */
const REPLACERS: ReadonlyArray<{ command: RegExp; what: string; anyTarget?: boolean }> = [
  { command: /(^|[|;&(]\s*)sed\s+(-\S+\s+)*-\S*i/, what: 'sed -i', anyTarget: true },
  { command: /(^|[|;&(]\s*)mv\s/, what: 'mv поверх .env' },
  { command: /(^|[|;&(]\s*)install\s/, what: 'install(1)' },
];

/** Куда команда пишет: последнее слово строки без кавычек. */
function target(line: string): string {
  const words = line.split(/\s+/).filter((word) => word !== '');
  return (words[words.length - 1] ?? '').replace(/["']/g, '');
}

/** Это сам infra/.env, а не производный от него файл (.env.before-restore). */
function isEnvFile(word: string): boolean {
  return word === '$ENV_FILE' || word === '${ENV_FILE}' || word.endsWith('/.env');
}

test('скрипты обслуживания не заменяют infra/.env новым файлом', () => {
  const dirs = ['install', 'install/lib', 'infra/scripts'];
  const offenders: string[] = [];

  for (const dir of dirs) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.sh')) continue;
      const relative = `${dir}/${name}`;
      for (const line of codeLines(read(relative))) {
        // Интересуют только строки, работающие с самим .env.
        if (!line.includes('ENV_FILE') && !line.includes('.env')) continue;
        for (const { command, what, anyTarget } of REPLACERS) {
          if (!command.test(line)) continue;
          // Копии (.env.before-restore и подобные) — другой файл: их
          // создавать заменой можно и нужно.
          if (anyTarget !== true && !isEnvFile(target(line))) continue;
          offenders.push(`${relative}: ${what} — ${line}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'замена файла отвяжет посредник от infra/.env, и настройки из панели молча ' +
      'перестанут доходить до служб; пишите поверх: cat новый > "$ENV_FILE"',
  );
});

test('посредник отказывается писать в файл-призрак', () => {
  const agent = read('infra/service-agent/agent.pl');
  const writeEnv = agent.slice(agent.indexOf('sub write_env'));

  assert.match(
    writeEnv,
    /stat\(\$ENV_FILE\)\)\[3\]/,
    'счётчик имён файла — единственный дешёвый способ отличить живой файл от призрака',
  );
  assert.match(
    writeEnv,
    /заменён новым/,
    'отказ обязан называть причину: иначе человек будет искать поломку в панели',
  );
  // Отказ идёт ДО записи: писать в призрак и потом жаловаться бессмысленно.
  assert.ok(
    writeEnv.indexOf('stat($ENV_FILE))[3]') < writeEnv.indexOf('truncate($wh'),
    'проверка обязана стоять до записи',
  );
});

test('самопроверка сверяет, тот ли infra/.env видит посредник', () => {
  const selfcheck = read('install/selfcheck.sh');
  assert.match(selfcheck, /stat -c %i "\$ENV_FILE"/, 'номер файла снаружи');
  assert.match(selfcheck, /stat -c %i \/env\/\.env/, 'номер файла изнутри посредника');
  assert.match(
    selfcheck,
    /посредник видит ЧУЖОЙ infra\/\.env/,
    'расхождение обязано быть ошибкой, а не тихой строкой в выводе',
  );
});
