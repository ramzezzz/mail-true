/**
 * Письмо в очереди — чужая переписка, а не сводка о ней.
 *
 * В ответе GET /queue/:id/message лежит конверт, заголовки и начало тела:
 * от кого, кому, тема и первые строки текста живого человека. Панель
 * обращается с такими данными по одному правилу, и правило это уже
 * записано в двух местах:
 *
 *   — раздел «Журналы почты» закрыт правом audit.read с прямым
 *     обоснованием «журналы служб содержат адреса переписки»;
 *   — просмотр чужих фильтров пишется в аудит наравне с изменением,
 *     «владелец вправе узнать, что это делали» (usersettings.view).
 *
 * Чтение письма из очереди нарушало оба правила разом: право стояло
 * overview.read — самое слабое, какое есть у любой роли, то есть текст
 * письма читался ЛЕГЧЕ, чем строка журнала с одним адресом. И следа в
 * журнале аудита не оставалось никакого: вход администратора в ящик
 * виден владельцу, а чтение его же письма из очереди — нет.
 *
 * Проверяем оба свойства по исходнику маршрута: поднимать ради этого
 * посредника к Postfix пришлось бы целиком, а проверяемое утверждение —
 * ровно про объявление маршрута.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACTION_LABELS } from './audit.js';

/**
 * Исходник маршрута. Набор тестов запускается и из src (tsx), и из dist
 * (npm test), поэтому путь ищется в обоих местах, а не выводится из
 * расположения самого файла проверки.
 */
function readRouteSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'routes', 'queue.ts'), // запуск из src
    path.join(here, '..', '..', 'src', 'admin', 'routes', 'queue.ts'), // запуск из dist
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      /* пробуем следующий */
    }
  }
  throw new Error(`не найден исходник routes/queue.ts; искали: ${candidates.join(', ')}`);
}

const source = readRouteSource();

/** Объявление маршрута целиком: от app.get до конца тела обработчика. */
function routeBlock(marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `маршрут ${marker} пропал`);
  return source.slice(at, at + 1200);
}

void test('текст письма из очереди закрыт как вход в чужой ящик', () => {
  /*
   * Право поднималось дважды, и второй раз — потому что audit.read есть у
   * роли «Только чтение». Дежурному положено видеть состояние сервера:
   * очередь, журналы, адреса. Содержание переписки сотрудников — нет.
   *
   * В журнале видны метаданные, здесь — тема и начало текста. Прочитать
   * чужое письмо и войти в чужой ящик по существу одно действие, значит и
   * право одно: mailbox.impersonate.
   */
  const block = routeBlock("app.get('/queue/:id/message'");
  assert.match(
    block,
    /requireAdmin\(app, 'mailbox\.impersonate'\)/u,
    'чтение чужого письма требует того же права, что вход в чужой ящик',
  );
  assert.doesNotMatch(
    block,
    /requireAdmin\(app, '(overview|audit)\.read'\)/u,
    'эти права есть у роли «Только чтение» — ей содержание чужих писем не положено',
  );
});

void test('чтение письма из очереди оставляет след в журнале аудита', () => {
  const block = routeBlock("app.get('/queue/:id/message'");
  assert.match(block, /action: 'queue\.view'/u, 'просмотр чужого письма обязан записываться');
});

void test('сводка очереди остаётся доступной всем: в ней нет содержания писем', () => {
  // Не перекрыть лишнего: список очереди — это адреса и причины отсрочки,
  // он нужен дежурному и закрывать его правом аудита незачем.
  const block = routeBlock("app.get('/queue',");
  assert.match(block, /requireAdmin\(app, 'overview\.read'\)/u);
});

void test('действия над очередью названы в журнале по-русски, а не кодом', () => {
  // Записи писались и раньше, но в разделе «Журнал аудита» человек видел
  // строку «queue.flush» вместо описания того, что произошло.
  for (const action of ['queue.view', 'queue.flush', 'queue.delete']) {
    const label = ACTION_LABELS[action];
    assert.ok(label, `у действия ${action} нет названия для человека`);
    assert.doesNotMatch(label, /^[a-z.]+$/u, `название ${action} осталось служебным`);
  }
});
