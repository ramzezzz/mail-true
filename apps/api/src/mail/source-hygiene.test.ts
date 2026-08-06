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
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Все .ts-файлы дерева, кроме собранного и стороннего. */
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'dist') continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) out.push(...(await sources(path)));
    else if (item.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('в исходниках нет нулевых байтов и прочих управляющих символов', async () => {
  const files = await sources(ROOT);
  assert.ok(files.length > 50, `подозрительно мало файлов: ${String(files.length)}`);

  const bad: string[] = [];
  for (const file of files) {
    const bytes = await readFile(file);
    for (const [index, byte] of bytes.entries()) {
      // Разрешено: табуляция (9), перевод строки (10), возврат каретки (13)
      // и всё, что печатается. Остальное в исходнике — случайность.
      if (byte < 9 || (byte > 13 && byte < 32) || byte === 11 || byte === 12) {
        const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
        bad.push(`${file.slice(ROOT.length)}:${String(line)} — байт 0x${byte.toString(16)}`);
        break;
      }
    }
  }
  assert.deepEqual(bad, [], `управляющие символы в исходниках:\n${bad.join('\n')}`);
});
