/**
 * Установка не имеет права обрываться молча.
 *
 * ------------------------------------------------------------------
 * КАК ЭТО ВЫГЛЯДИТ
 * ------------------------------------------------------------------
 * Скрипты установки работают под `set -euo pipefail`. В таком режиме
 * присваивание вида
 *
 *     VAR="$(команда | обработка)"
 *
 * убивает скрипт, если ЛЮБОЕ звено конвейера вернуло ненулевой код. Без
 * единого слова: ни строки в вывод, ни объяснения — установка просто
 * заканчивается на середине.
 *
 * Проверено опытом: `X="$(false | tr -d '\r')"` под этим режимом
 * останавливает скрипт с кодом 1 и не печатает ничего.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ХУЖЕ, ЧЕМ КАЖЕТСЯ
 * ------------------------------------------------------------------
 * Обрывались как раз те места, где значение НЕОБЯЗАТЕЛЬНО и где рядом
 * заботливо написано, что делать при неудаче:
 *
 *   * хэш пароля администратора — ниже стояла проверка «не удалось
 *     посчитать хэш» с внятным текстом, и она была недостижима: скрипт
 *     умирал раньше, на самом непонятном для обрыва шаге;
 *   * чтение CN сертификата — повреждённый сертификат обрывал установку
 *     вместо строки «сертификат уже есть (CN=?)»;
 *   * пересчёт доменов и ящиков ПОСЛЕ восстановления из копии — лежащая
 *     база и есть причина, по которой запускали восстановление;
 *   * размер выгрузки и опрос Redis в резервном копировании — копия
 *     обрывалась на середине уже после удачной выгрузки базы;
 *   * отметка об установке в базе: у функции в шапке прямо написано
 *     «Молчит, если базы нет», а она вместо этого валила вызывающего.
 *
 * ------------------------------------------------------------------
 * ЧТО ПРОВЕРЯЕТСЯ
 * ------------------------------------------------------------------
 * Что таких мест не осталось. Значение может быть пустым — это штатный
 * случай, и рядом всегда есть его разбор; недопустимо именно молчаливое
 * прекращение работы.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Скрипты, работающие под `set -e`: только им грозит молчаливый обрыв. */
function scriptsWithErrExit(): string[] {
  const found: string[] = [];
  for (const dir of ['install', 'install/lib', 'infra/scripts']) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.sh')) continue;
      const relative = `${dir}/${name}`;
      const text = readFileSync(path.join(ROOT, relative), 'utf8');
      if (/^set -[a-z]*e[a-z]*\b/m.test(text)) found.push(relative);
    }
  }
  return found;
}

/**
 * Опасное присваивание: конвейер в подстановке без запасного выхода.
 *
 * Строки внутри условий (`if VAR=...`, `... && VAR=...`) пропускаются:
 * там `set -e` не действует, и обрыва не будет.
 */
function risky(line: string): boolean {
  const code = line.trim();
  if (code === '' || code.startsWith('#')) return false;
  if (/^(if|while|until|elif)\b/.test(code)) return false;
  if (/&&|\|\|/.test(code)) return false;
  return /^(local\s+|export\s+)?[A-Za-z_][A-Za-z0-9_]*="?\$\(.*\|/.test(code);
}

test('в скриптах под set -e не осталось молчаливых обрывов', () => {
  const scripts = scriptsWithErrExit();
  assert.ok(scripts.length >= 5, 'проверка пуста: скрипты под set -e не найдены');

  const offenders: string[] = [];
  for (const relative of scripts) {
    const lines = readFileSync(path.join(ROOT, relative), 'utf8').split('\n');
    lines.forEach((line, index) => {
      // Подстановка может занимать несколько строк — тогда запасной выход
      // стоит на её последней строке. Смотрим вперёд до закрывающей `)"`.
      if (!risky(line)) return;
      let whole = line;
      for (let i = index + 1; i < lines.length && !/\)"/.test(whole); i += 1) {
        whole += `\n${lines[i] ?? ''}`;
      }
      if (/\|\|\s*(true|echo|:)/.test(whole)) return;
      offenders.push(`${relative}:${String(index + 1)}: ${line.trim().slice(0, 90)}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'под set -euo pipefail такое присваивание обрывает скрипт без единого слова; ' +
      'если пустое значение допустимо — допишите «|| true», если нет — проверьте и объясните',
  );
});

test('хэш пароля администратора: проверка «не удалось» достижима', () => {
  const install = readFileSync(path.join(ROOT, 'install/install.sh'), 'utf8');
  const block = install.slice(install.indexOf('ADMIN_HASH="$('));
  const assignment = block.slice(0, block.indexOf('if [ -z "$ADMIN_HASH" ]'));
  assert.match(
    assignment,
    /\|\|\s*true/,
    'без запасного выхода скрипт умирает раньше собственной проверки',
  );
  assert.match(block, /не удалось посчитать хэш пароля администратора/);
});
