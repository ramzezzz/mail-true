/**
 * Умолчание в compose обязано совпадать с умолчанием в коде.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО НЕ ПРИДИРКА
 * ------------------------------------------------------------------
 * Переменные приходят в контейнер так: `KEY: ${KEY:-значение}`. Значит
 * при пустом infra/.env до кода доезжает ЗНАЧЕНИЕ ИЗ COMPOSE, а не
 * умолчание из схемы. Умолчание в коде в этом случае не действует ни на
 * одной установке — оно просто мёртвая строка.
 *
 * Поймано живьём на HEALTH_CACHE_MS. В коде стояло 20 000 с подробным
 * разбором: пробу дёргают дашборд, «Наблюдение» и каждая открытая
 * вкладка, а при двух секундах Dovecot и Postfix записывают каждый стук,
 * и в журналах почты стоит сплошная лента «Disconnected: no auth
 * attempts», в которой тонет настоящая доставка. В compose при этом
 * осталось 2000 — то есть починка не подействовала НИГДЕ, а выглядела
 * сделанной: в коде правильное число и объяснение к нему.
 *
 * Расхождение не видно ни в панели, ни в журналах, ни при чтении кода —
 * ровно поэтому оно и живёт годами.
 *
 * ------------------------------------------------------------------
 * ВТОРАЯ ПРОВЕРКА: НАСТРОЙКА, КОТОРУЮ НЕЛЬЗЯ ЗАДАТЬ
 * ------------------------------------------------------------------
 * Обратный случай — ключ читается кодом, но в compose его нет вовсе.
 * Тогда написать его в infra/.env бесполезно: до контейнера он не
 * доедет. Так было с ADMIN_ACCOUNT_LOCK_FAILURES и ADMIN_KNOWN_IP_DAYS —
 * половиной защиты от распределённого подбора пароля к панели.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { loadAdminConfig } from './config.js';

const COMPOSE = readFileSync(
  fileURLToPath(new URL('../../../../infra/docker-compose.yml', import.meta.url)),
  'utf8',
);

/**
 * Умолчания из блока environment службы api.
 *
 * Берётся именно её блок: у postfix и dovecot свои переменные с теми же
 * именами бывают заданы иначе, и сравнивать их со схемой api нельзя.
 */
function apiComposeDefaults(): Map<string, string> {
  const start = COMPOSE.indexOf('\n  api:');
  assert.ok(start > 0, 'в compose не нашлась служба api');
  // Конец блока — следующая служба того же уровня отступа.
  const rest = COMPOSE.slice(start + 1);
  const nextService = rest.slice(1).search(/\n {2}\w[\w-]*:\n/);
  const block = nextService === -1 ? rest : rest.slice(0, nextService + 1);

  const defaults = new Map<string, string>();
  const line = /^\s{6}([A-Z][A-Z0-9_]*):\s*\$\{\1:-([^}]*)\}\s*$/gm;
  let match = line.exec(block);
  while (match !== null) {
    defaults.set(match[1] ?? '', match[2] ?? '');
    match = line.exec(block);
  }
  return defaults;
}

/** Минимум, без которого схема не соберётся: обязательные значения. */
const REQUIRED: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://mailserver:x@postgres:5432/mailserver',
  ADMIN_DATABASE_URL: 'postgres://mailserver:x@postgres:5432/mailserver',
  REDIS_URL: 'redis://redis:6379',
  SESSION_SECRET: 'x'.repeat(32),
  ADMIN_SESSION_SECRET: 'y'.repeat(32),
  MAIL_DOMAIN: 'mail.local',
};

test('умолчания в compose совпадают с умолчаниями в коде', () => {
  const composeDefaults = apiComposeDefaults();
  assert.ok(composeDefaults.size > 20, 'разбор блока api не нашёл переменных — проверка пуста');

  const config = loadConfig({ ...REQUIRED }) as unknown as Record<string, unknown>;
  const adminConfig = loadAdminConfig({ ...REQUIRED }) as unknown as Record<string, unknown>;

  const mismatched: string[] = [];
  for (const [key, composeValue] of composeDefaults) {
    const value = key in config ? config[key] : adminConfig[key];
    // Ключа нет в схемах — значит его читает не сервер приложения
    // (SMTP_HOST, IMAP_HOST и прочее уходит в другие модули). Не наше
    // дело: здесь сверяются только те, у кого умолчание есть в обоих
    // местах.
    if (value === undefined) continue;
    // Пустое умолчание в compose — это «переменной нет», а не значение.
    if (composeValue === '') continue;

    const asText =
      typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value as string | number);
    if (asText !== composeValue) {
      mismatched.push(`${key}: в compose ${composeValue}, в коде ${asText}`);
    }
  }

  assert.deepEqual(
    mismatched,
    [],
    'значение из compose доезжает до кода раньше умолчания схемы — ' +
      'значит умолчание в коде не действует ни на одной установке',
  );
});

test('настройки защиты панели от подбора доходят до контейнера', () => {
  /*
   * Ключ, который читает код, но не пробрасывает compose, задать в
   * infra/.env невозможно: до контейнера он не доедет, а панель и
   * описание обещают настройку.
   */
  const composeDefaults = apiComposeDefaults();
  for (const key of [
    'ADMIN_LOGIN_MAX_FAILURES',
    'ADMIN_LOCKOUT_MINUTES',
    'ADMIN_ACCOUNT_LOCK_FAILURES',
    'ADMIN_KNOWN_IP_DAYS',
  ]) {
    assert.ok(composeDefaults.has(key), `${key} не пробрасывается в контейнер api`);
  }
});
