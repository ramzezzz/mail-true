/**
 * В исходниках не должно быть управляющих символов.
 *
 * Поймано на живом проекте: в snooze-service.ts оказался настоящий нулевой
 * байт внутри строкового литерала — там, где задумывался «заведомо
 * несуществующий путь». Работать оно работало, но:
 *
 *   1. файл перестал считаться текстовым, и поиск по коду его пропускал —
 *      я потерял время, разыскивая функцию внутри собственного исходника;
 *   2. такой символ не видно глазом ни в редакторе, ни при просмотре
 *      изменений: строка выглядит пустой;
 *   3. попав в команду IMAP или в SQL, нулевой байт даёт отказ, который
 *      потом ищут часами.
 *
 * Проверка дешёвая и разовая: пробегает исходники и следит, чтобы в них не
 * было ничего, кроме печатных символов, табуляции и переводов строк.
 *
 * Смотрит ВЕСЬ монорепозиторий, а не только сервер приложения. Сначала
 * смотрела один каталог — и пропустила ровно то, ради чего написана:
 * в проверку интерфейса попал символ возврата на шаг (0x08), тест из-за
 * него искал в разметке несуществующую строку и падал «значок не того
 * размера» — при том, что размер не менялся вовсе. Полдня спустя стало
 * ясно, что дело не в значке.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень хранилища: отсюда apps/, packages/ и всё остальное. */
const REPO = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * Что просматриваем. Каталоги перечислены поимённо, а не «всё подряд»:
 * в корне лежат ещё выгрузка чужого сайта (research/) и картинки
 * руководства, где двоичное содержимое — норма.
 */
const AREAS = ['apps', 'packages', 'infra', 'install'];

/** Расширения, для которых управляющий символ — всегда случайность. */
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.css', '.sql', '.sh'];

/** Все исходники дерева, кроме собранного и стороннего. */
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'dist' || item.name === 'build') continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) out.push(...(await sources(path)));
    else if (EXTENSIONS.some((ext) => item.name.endsWith(ext))) out.push(path);
  }
  return out;
}

test('в исходниках нет нулевых байтов и прочих управляющих символов', async () => {
  const files: string[] = [];
  for (const area of AREAS) files.push(...(await sources(join(REPO, area))));
  // Порог с запасом: он ловит не число файлов, а обход, свернувшийся
  // до одного каталога, — то есть проверку, которая молча ничего не смотрит.
  assert.ok(files.length > 400, `подозрительно мало файлов: ${String(files.length)}`);

  const bad: string[] = [];
  for (const file of files) {
    const bytes = await readFile(file);
    for (const [index, byte] of bytes.entries()) {
      // Разрешено: табуляция (9), перевод строки (10), возврат каретки (13)
      // и всё, что печатается. Остальное в исходнике — случайность.
      if (byte < 9 || (byte > 13 && byte < 32) || byte === 11 || byte === 12) {
        const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
        bad.push(`${file.slice(REPO.length)}:${String(line)} — байт 0x${byte.toString(16)}`);
        break;
      }
    }
  }
  assert.deepEqual(bad, [], `управляющие символы в исходниках:\n${bad.join('\n')}`);
});
