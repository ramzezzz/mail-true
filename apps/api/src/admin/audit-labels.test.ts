/**
 * У каждого записываемого действия есть название по-русски.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТА ПРОВЕРКА
 * ------------------------------------------------------------------
 * Журнал аудита читают не те, кто писал код: администратор организации,
 * служба безопасности, человек, разбирающий спорный случай через полгода.
 * Строка «branding.texts» для них ровно то же, что «ошибка 0x80070005».
 *
 * Четырнадцать действий показывались именно так — их писали, но названий
 * им не завели, а пара названий («admin.create», «admin.update») висела
 * мёртвым грузом: обработчик пишет «admins.create», с буквой «s».
 * Разъезжается это молча и незаметно, поэтому проверка идёт ПО ИСХОДНОМУ
 * КОДУ: она находит все `action: '…'`, которые уходят в журнал, и требует
 * названия для каждого.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ACTION_LABELS } from './audit.js';

/** Корень исходников API — от собранного файла до src. */
function sourceRoot(): string {
  for (const candidate of [resolve(process.cwd(), 'apps/api/src'), resolve(process.cwd(), 'src')]) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // пробуем следующий
    }
  }
  throw new Error('не найден каталог исходников API');
}

function allSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) allSources(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/**
 * Действия, которые пишет audit(). Отбор по вызову, а не по слову
 * `action:` вообще: одноимённые поля есть и у совсем других запросов.
 */
function writtenActions(): Set<string> {
  const found = new Set<string>();
  for (const file of allSources(sourceRoot())) {
    const text = readFileSync(file, 'utf8');
    for (const call of text.matchAll(/audit\w*\([\s\S]{0,900}?\)/g)) {
      /*
       * Только имена с точкой. Внутри той же записи бывает поле
       * `after: { action: 'view' }` — это часть содержимого записи, а не
       * её вид, и названия ему не нужно.
       */
      for (const hit of call[0].matchAll(/action:\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/g)) {
        found.add(hit[1] ?? '');
      }
    }
  }
  found.delete('');
  return found;
}

test('каждое действие, попадающее в журнал, названо по-русски', () => {
  const actions = writtenActions();
  assert.ok(actions.size > 30, `действий найдено подозрительно мало: ${String(actions.size)}`);

  const nameless = [...actions].filter((a) => !(a in ACTION_LABELS)).sort();
  assert.deepEqual(
    nameless,
    [],
    `в журнале эти действия видны машинным именем: ${nameless.join(', ')}`,
  );
});
