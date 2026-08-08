/**
 * Оценки раздела «Наблюдение».
 *
 * Проверяется главное свойство раздела: он должен краснеть ЗАРАНЕЕ и по
 * тем признакам, которые не видны ни в одном графике. Истёкший сертификат,
 * заполненный на 91 % том и письмо, лежащее в очереди полсмены, не меняют
 * ни одного показателя нагрузки — а почта из-за них встаёт.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISK_FAIL_PERCENT,
  DISK_WARN_PERCENT,
  gradeCertificate,
  gradeDisk,
  gradeQueue,
  QUEUE_OLD_SECONDS,
  SHELL_ONLY_CHECKS,
  summarize,
  worstState,
  type HealthCheck,
} from './selfcheck.js';

test('место на диске: ступени совпадают с теми, что в install/selfcheck.sh', () => {
  assert.equal(gradeDisk(10), 'ok');
  assert.equal(gradeDisk(DISK_WARN_PERCENT - 0.1), 'ok');
  assert.equal(gradeDisk(DISK_WARN_PERCENT), 'warn');
  assert.equal(gradeDisk(DISK_FAIL_PERCENT), 'fail');
  assert.equal(gradeDisk(100), 'fail');
});

test('сертификат: истёкший — отказ, истекающий — предупреждение', () => {
  assert.equal(gradeCertificate(90, 21), 'ok');
  assert.equal(gradeCertificate(21, 21), 'warn');
  assert.equal(gradeCertificate(1, 21), 'warn');
  assert.equal(gradeCertificate(0, 21), 'fail');
  assert.equal(gradeCertificate(-3, 21), 'fail');
});

test('сертификат: непрочитанный срок — «неизвестно», а не «в порядке»', () => {
  // Зелёный на непрочитанном сроке — худший из возможных ответов: он
  // означает «я не смотрел», а читается как «всё хорошо».
  assert.equal(gradeCertificate(null, 21), 'unknown');
});

test('очередь: старое письмо важнее большого числа писем', () => {
  // Тысяча писем возрастом в минуту — это всплеск рассылки, он рассосётся.
  assert.equal(gradeQueue(1000, 30), 'warn');
  // Одно письмо, лежащее полсмены, — это сломанный адресат, и само оно
  // не починится.
  assert.equal(gradeQueue(1, QUEUE_OLD_SECONDS), 'fail');
  assert.equal(gradeQueue(0, null), 'ok');
});

test('очередь: недоступный посредник — «неизвестно», а не «пусто»', () => {
  assert.equal(gradeQueue(null, null), 'unknown');
});

test('итог раздела — по худшей проверке', () => {
  assert.equal(worstState(['ok', 'ok']), 'ok');
  assert.equal(worstState(['ok', 'warn']), 'warn');
  assert.equal(worstState(['warn', 'fail']), 'fail');
  // «Неизвестно» хуже «в порядке»: непроверенное не значит исправное.
  assert.equal(worstState(['ok', 'unknown']), 'unknown');
});

test('сводка считает каждую ступень отдельно', () => {
  const checks: HealthCheck[] = [
    { id: 'a', group: 'Службы', title: 'a', state: 'ok', detail: '' },
    { id: 'b', group: 'Службы', title: 'b', state: 'warn', detail: '' },
    { id: 'c', group: 'Место', title: 'c', state: 'fail', detail: '' },
    { id: 'd', group: 'DNS', title: 'd', state: 'unknown', detail: '' },
  ];
  assert.deepEqual(summarize(checks), { state: 'fail', ok: 1, warn: 1, fail: 1, unknown: 1 });
});

test('раздел обязан называть то, чего он не проверяет', () => {
  /*
   * Без этого списка зелёный экран панели читается как «проверено всё»,
   * хотя внешних адресов, прав на .env и сквозной отправки письма панель
   * не видит принципиально.
   *
   * Порога «не меньше пяти» здесь больше нет, и это не послабление.
   * Список СОКРАЩАЕТСЯ по мере того, как пункты закрываются по-настоящему:
   * соответствие схемы миграциям и свежесть копии закрыты монтированием
   * двух каталогов на чтение, состояние контейнеров — посредником.
   * Требовать «пусть в списке всегда будет не меньше пяти отговорок»
   * значит мешать самому себе их убирать.
   *
   * Требование осталось одно и настоящее: каждый ОСТАВШИЙСЯ пункт назван
   * человеческими словами и объясняет причину. Пустой список — тоже
   * законный исход: он будет означать, что панель проверяет всё.
   */
  for (const item of SHELL_ONLY_CHECKS) {
    assert.ok(item.title.length > 10);
    // Причина обязательна: «нельзя» без объяснения выглядит недоделкой.
    assert.ok(item.why.length > 30);
  }
});
