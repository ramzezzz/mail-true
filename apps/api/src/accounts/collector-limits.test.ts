/**
 * Сбор чужой почты: настройка не должна тихо приводить к дублям.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Замок «идёт сбор» сам по себе правильный: пометка ставится одним
 * атомарным запросом, и второй сбор её видит. Но пометка считается
 * брошенной через COLLECTOR_STALE_MINUTES, а предел на один сбор
 * (COLLECTOR_TIMEOUT_MS) допускает до часа. Настроил «дать сбору час»
 * при сроке молчания в полчаса — и живой сбор через тридцать минут
 * считается брошенным: рядом запускается второй, и письма из чужого
 * ящика копируются дважды.
 *
 * Настройка при этом выглядит совершенно разумной, а последствие —
 * дубли — с ней не связывается никак. По отдельности каждое значение в
 * своих границах, и поймать это может только сверка их между собой.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAccountsConfig } from './config.js';

/** Окружение с минимумом обязательного. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ACCOUNTS_DATABASE_URL: 'postgres://ignored/ignored',
    SESSION_SECRET: 'x'.repeat(48),
    ...extra,
  } as NodeJS.ProcessEnv;
}

test('умолчания согласованы между собой', () => {
  // Десять минут на сбор при сроке молчания в полчаса — запас втрое.
  const config = loadAccountsConfig(env());
  assert.ok(config.COLLECTOR_TIMEOUT_MS / 60_000 < config.COLLECTOR_STALE_MINUTES);
});

test('час на сбор при получасе молчания — отказ с объяснением', () => {
  assert.throws(
    () =>
      loadAccountsConfig(
        env({ COLLECTOR_TIMEOUT_MS: String(60 * 60_000), COLLECTOR_STALE_MINUTES: '30' }),
      ),
    /копируются дважды/u,
    'настройка, дающая дубли писем, принята молча',
  );
});

test('равные значения тоже отвергаются: сбор ровно на границе — уже риск', () => {
  assert.throws(
    () =>
      loadAccountsConfig(
        env({ COLLECTOR_TIMEOUT_MS: String(30 * 60_000), COLLECTOR_STALE_MINUTES: '30' }),
      ),
    /COLLECTOR_STALE_MINUTES/u,
  );
});

test('разумная пара принимается: час молчания на сорок минут сбора', () => {
  const config = loadAccountsConfig(
    env({ COLLECTOR_TIMEOUT_MS: String(40 * 60_000), COLLECTOR_STALE_MINUTES: '60' }),
  );
  assert.equal(config.COLLECTOR_STALE_MINUTES, 60);
});

test('в отказе названы оба ключа и сказано, что делать', () => {
  // Отказ на старте сервера читают в консоли, и он обязан отвечать на
  // вопрос «что править», а не только «что не так».
  try {
    loadAccountsConfig(
      env({ COLLECTOR_TIMEOUT_MS: String(60 * 60_000), COLLECTOR_STALE_MINUTES: '15' }),
    );
    assert.fail('настройка принята');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /COLLECTOR_TIMEOUT_MS/u);
    assert.match(message, /COLLECTOR_STALE_MINUTES/u);
    assert.match(message, /Поднимите|уменьшите/u);
  }
});
