/**
 * «Сохранено» не значит «работает»: файл правил мог не доехать.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Раскладывать почту по папкам, отвечать в отпуске и заглушать переписки
 * умеет НЕ база, а файл правил в ящике (Sieve). Сохранение настройки и
 * запись этого файла — разные действия, и второе отказывает буднично:
 * выключен транспорт (`SIEVE_TRANSPORT=off`), недоступен контейнер
 * Dovecot, не скомпилировался скрипт, не записался файл.
 *
 * Служба это знала: `syncSieve` намеренно не бросает, а возвращает
 * состояние с причиной — «чтобы „правило есть, а не работает“ было видно
 * сразу». Но все меняющие маршруты звали её как `await
 * service.syncSieve(...)` и результат ВЫБРАСЫВАЛИ.
 *
 * Человек сохранял автоответчик, видел зелёное «Настройки сохранены»,
 * уезжал в отпуск — а отвечать было некому. Или заводил фильтр, видел его
 * в списке — а почта не раскладывалась. Причина существовала, была
 * сформирована и оставалась в журнале сервера.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withSieveWarning } from './routes.js';
import type { SieveSyncState } from './service.js';

function state(patch: Partial<SieveSyncState> = {}): SieveSyncState {
  return {
    transport: 'docker',
    path: '/var/mail/vhosts/mail.local/user/sieve/active.sieve',
    activeRules: 2,
    ok: true,
    written: true,
    error: '',
    ...patch,
  };
}

test('всё записалось — ответ не меняется ни на байт', () => {
  const payload = { id: '5', enabled: true };
  const result = withSieveWarning(payload, state());
  assert.deepEqual(result, payload);
  assert.equal('sieveWarning' in result, false, 'лишнее поле в обычном ответе — это шум');
});

test('файл правил не записался — в ответе есть предупреждение с причиной', () => {
  const result = withSieveWarning(
    { ok: true },
    state({ ok: false, written: false, error: 'Контейнер Dovecot недоступен' }),
  ) as { sieveWarning?: string };
  assert.match(result.sieveWarning ?? '', /не применяются/);
  // Причина обязана дойти дословно: «что-то пошло не так» не говорит
  // человеку ни что сломалось, ни к кому идти.
  assert.match(result.sieveWarning ?? '', /Контейнер Dovecot недоступен/);
});

test('причина неизвестна — предупреждение всё равно есть', () => {
  // Молчание здесь хуже общей формулировки: настройка уже сохранена, и
  // человек уверен, что она работает.
  const result = withSieveWarning({ ok: true }, state({ ok: false, error: '   ' })) as {
    sieveWarning?: string;
  };
  assert.match(result.sieveWarning ?? '', /не применяются/);
});
