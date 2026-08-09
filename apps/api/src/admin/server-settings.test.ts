/**
 * Проверки хранилища настроек сервера.
 *
 * Здесь закрыты те дефекты, которые в этой затее возможны и дорого стоят:
 *
 *   1. Панель показывает не то, чем сервер живёт. Перечень настроек хранит
 *      собственные умолчания, и разойтись со схемами окружения им ничего
 *      не мешает: одна правка zod-схемы — и человек читает в панели «14
 *      дней», а история чистится по семи. Проверяется сверкой каждого
 *      ключа с тем, что выдаёт настоящий загрузчик конфигурации.
 *   2. Строка в базе подменяет то, что подменять нельзя. Хранилище обязано
 *      читать ТОЛЬКО ключи из перечня и только не-locked: иначе доступ
 *      к базе превращается в подмену строки подключения и секретов.
 *   3. Негодное значение останавливает работу. Настройка обязана быть
 *      безопасной в отказе: опечатка в базе не должна ронять создание
 *      ящиков — берётся умолчание.
 *   4. Пустая переменная окружения превращается в ноль. Number('') === 0,
 *      и стёртый MAIL_FLOW_RETENTION_DAYS означал бы «хранить ноль дней»,
 *      то есть тихую потерю всей истории доставки.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { loadAdminConfig } from './config.js';
import { loadSettingsConfig } from '../settings/config.js';
import { loadPushConfig } from '../push/config.js';
import { loadLogoConfig } from '../logos/config.js';
import { loadAccountsConfig } from '../accounts/config.js';
import { loadAiConfig } from '../ai/config.js';
import {
  EDITABLE_KEYS,
  findSetting,
  isEditable,
  SETTING_SECTIONS,
  SETTING_SPECS,
} from './server-settings-registry.js';
import { generateSecret, ROTATABLE_SECRETS } from './secret-rotation.js';
import { findTarget } from './restart-targets.js';
import {
  applyRowsToEnv,
  forgetStoredEnv,
  parseSettingValue,
  ServerSettings,
  typedValue,
} from './server-settings.js';

/** Подделка базы: отдаёт заданные строки и помнит выполненные запросы. */
class FakeDb {
  rows: Array<{ key: string; value: string; updated_by: string | null; updated_at: Date }> = [];
  queries: Array<{ text: string; values: unknown[] }> = [];
  fail: Error | null = null;

  async query<T>(text: string, values: unknown[] = []): Promise<T[]> {
    this.queries.push({ text, values });
    if (this.fail) throw this.fail;
    if (text.startsWith('SELECT')) return this.rows as unknown as T[];
    if (text.startsWith('INSERT')) {
      const [key, value, by] = values as [string, string, string];
      const existing = this.rows.find((r) => r.key === key);
      if (existing) {
        existing.value = value;
        existing.updated_by = by;
      } else {
        this.rows.push({ key, value, updated_by: by, updated_at: new Date() });
      }
      return [];
    }
    if (text.startsWith('DELETE')) {
      const [key] = values as [string];
      this.rows = this.rows.filter((r) => r.key !== key);
      return [];
    }
    return [];
  }
}

function make(
  rows: Array<{ key: string; value: string }> = [],
  env: NodeJS.ProcessEnv = {},
): { db: FakeDb; settings: ServerSettings } {
  const db = new FakeDb();
  db.rows = rows.map((r) => ({ ...r, updated_by: 'osmotr', updated_at: new Date() }));
  // Кэш выключен: проверки меняют значения и тут же читают их снова.
  return { db, settings: new ServerSettings({ db, env, cacheMs: 0 }) };
}

/* ------------------------------------------------------------------ */
/* 1. Перечень не расходится со схемами окружения                       */
/* ------------------------------------------------------------------ */

void test('умолчание каждой настройки совпадает с умолчанием схемы окружения', () => {
  const empty = {} as NodeJS.ProcessEnv;
  // Все загрузчики, которые разбирают окружение сервера приложения.
  const loaded: Record<string, unknown> = {
    ...loadConfig(empty),
    ...loadAdminConfig(empty),
    ...loadSettingsConfig(empty),
    ...loadPushConfig(empty),
    ...loadLogoConfig(empty),
    ...loadAccountsConfig(empty),
    ...loadAiConfig(empty),
  };

  const mismatched: string[] = [];
  for (const spec of SETTING_SPECS) {
    const actual = loaded[spec.key];
    // Ключа нет ни в одной схеме — значит его читает другой контейнер
    // (autoconfig, rspamd, unbound) или сам docker compose. Такие ключи
    // в перечне обязаны стоять как locked, и это проверяется ниже.
    if (actual === undefined) continue;
    const expected = typedValue(spec, spec.def);
    // TRUSTED_PROXIES схема разворачивает в список — сверяем по строке.
    const normalized = Array.isArray(actual) ? actual.join(',') : actual;
    if (normalized !== expected) {
      mismatched.push(`${spec.key}: в перечне ${String(expected)}, в схеме ${String(normalized)}`);
    }
  }
  assert.deepEqual(mismatched, [], `Умолчания разошлись:\n${mismatched.join('\n')}`);
});

void test('ключ, которого нет ни в одной схеме окружения api, применяется чужой службой', () => {
  const empty = {} as NodeJS.ProcessEnv;
  const loaded: Record<string, unknown> = {
    ...loadConfig(empty),
    ...loadAdminConfig(empty),
    ...loadSettingsConfig(empty),
    ...loadPushConfig(empty),
    ...loadLogoConfig(empty),
    ...loadAccountsConfig(empty),
    ...loadAiConfig(empty),
  };
  /*
   * Ключ, которого нет ни в одной схеме окружения сервера приложения,
   * читает КТО-ТО ДРУГОЙ. Раньше это означало «менять из панели
   * бессмысленно», и такие ключи обязаны были стоять как locked. С
   * появлением посредника перезапуска у них есть второй законный путь:
   * группа recreate плюс явное указание, чей контейнер пересоздать.
   *
   * Чего быть НЕ должно — так это ключа, который обещает изменяемость и
   * при этом не имеет ни читателя внутри процесса, ни службы, которая бы
   * его подхватила. Это и есть «настройка, которая молча не работает».
   */
  const lying = SETTING_SPECS.filter((s) => {
    if (s.group === 'locked') return false;
    if (loaded[s.key] !== undefined) return false;
    // Необязательный ключ схемы (PUSH_CONTACT и подобные) при пустом
    // окружении в разобранной конфигурации просто отсутствует — это
    // не «его не читают», а «значение не задано». Такие помечены
    // allowEmpty: пустота у них осмысленна.
    if (s.allowEmpty === true) return false;
    /*
     * Настройку, которой нет в схемах, применяет ПЕРЕСОЗДАНИЕ контейнера —
     * своего или чужого. Чужого: значение читает другая служба из своего
     * окружения. Своего: есть ключи, которые сервер приложения не читает
     * и прочитать не может, потому что их читает процесс Node ДО того,
     * как появится хоть какой-нибудь наш код, — NODE_OPTIONS ровно такой.
     * Раньше здесь стояло `a.target !== 'api'`, и такой ключ считался
     * «молча не работающим», хотя пересоздание его применяет.
     */
    return !(s.applies ?? []).some((a) => a.action === 'recreate');
  }).map((s) => s.key);
  assert.deepEqual(
    lying,
    [],
    'Эти настройки обещают, что их можно менять, но сервер приложения их не читает, ' +
      `и ни одна служба их не подхватывает: ${lying.join(', ')}`,
  );
});

/* ------------------------------------------------------------------ */
/* 1а. Обещание «применится» подкреплено настоящей кнопкой              */
/* ------------------------------------------------------------------ */

void test('у каждой настройки групп restart и recreate сказано, что её применяет', () => {
  const silent = SETTING_SPECS.filter(
    (s) => (s.group === 'restart' || s.group === 'recreate') && (s.applies ?? []).length === 0,
  ).map((s) => s.key);
  assert.deepEqual(
    silent,
    [],
    'Эти настройки сообщают «подействует после перезапуска», но не говорят, какого ' +
      `именно: ${silent.join(', ')}`,
  );
});

void test('живая настройка ничего не обещает применять', () => {
  const noisy = SETTING_SPECS.filter(
    (s) => (s.group === 'live' || s.group === 'locked') && (s.applies ?? []).length > 0,
  ).map((s) => s.key);
  assert.deepEqual(noisy, [], `Применять тут нечего, а обещано: ${noisy.join(', ')}`);
});

void test('каждая служба из applies есть в перечне перезапускаемых и умеет это действие', () => {
  const broken: string[] = [];
  for (const spec of SETTING_SPECS) {
    for (const apply of spec.applies ?? []) {
      const target = findTarget(apply.target);
      if (!target) {
        broken.push(`${spec.key}: службы «${apply.target}» нет в перечне перезапускаемых`);
        continue;
      }
      if (!target.actions.includes(apply.action)) {
        broken.push(`${spec.key}: служба «${apply.target}» не умеет «${apply.action}»`);
      }
    }
  }
  assert.deepEqual(broken, [], `Настройка ссылается на кнопку, которой нет:\n${broken.join('\n')}`);
});

/**
 * Список того, что посреднику разрешено писать в infra/.env, продублирован
 * в самом посреднике — намеренно, как последний рубеж. Дублирование
 * опасно ровно одним: списки разойдутся, и настройка, добавленная сюда,
 * будет молча отвергаться посредником уже после того, как человек её
 * сохранил и нажал «применить».
 *
 * Поэтому перечень сверяется с настоящим файлом посредника. Проверка
 * читает его как текст: тащить ради этого разбор Perl незачем, а формат
 * таблицы в нём простой и нарочно неизменный.
 */
void test('каждый ключ группы recreate разрешён посреднику для своей службы', async () => {
  const path = new URL('../../../../infra/service-agent/agent.pl', import.meta.url);
  const source = await readFile(path, 'utf8');
  const table = source.slice(source.indexOf('my %ENV_KEYS'), source.indexOf('if ($TOKEN eq'));
  assert.ok(table.length > 100, 'таблица %ENV_KEYS в посреднике не найдена');

  // Раскладываем «служба => { КЛЮЧ => 1, ... }» в пары «служба:КЛЮЧ».
  const allowed = new Set<string>();
  for (const block of table.matchAll(/(\w+)\s*=>\s*\{([^}]*)\}/gu)) {
    const service = block[1] ?? '';
    for (const key of (block[2] ?? '').matchAll(/([A-Z][A-Z0-9_]+)\s*=>\s*1/gu)) {
      allowed.add(`${service}:${String(key[1])}`);
    }
  }
  assert.ok(allowed.size > 5, `в посреднике разобрано слишком мало ключей: ${allowed.size}`);

  const missing: string[] = [];
  for (const spec of SETTING_SPECS) {
    for (const apply of spec.applies ?? []) {
      if (apply.action !== 'recreate') continue;
      if (!allowed.has(`${apply.target}:${spec.key}`)) {
        missing.push(`${spec.key} для службы ${apply.target}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'Панель обещает применить эти настройки пересозданием, но посредник откажется ' +
      `записывать их в infra/.env — списки разошлись:\n${missing.join('\n')}`,
  );
});

void test('посреднику не разрешён ни один ключ, которого нет в перечне настроек', async () => {
  const path = new URL('../../../../infra/service-agent/agent.pl', import.meta.url);
  const source = await readFile(path, 'utf8');
  const table = source.slice(source.indexOf('my %ENV_KEYS'), source.indexOf('if ($TOKEN eq'));
  /*
   * Сверка ОБРАТНАЯ предыдущей, и нужна она отдельно.
   *
   * Та проверяет, что обещанное панелью посредник умеет. Эта — что он не
   * умеет НИЧЕГО СВЕРХ обещанного: у службы с сокетом Docker лишнее право
   * записи в infra/.env — это не неаккуратность, а тихо расширенная
   * поверхность. Сверяется ПАРА «служба + ключ», а не один ключ: право
   * записать CLAMAV_ENABLED «через autoconfig» так же лишне, как право
   * записать туда пароль базы, хотя сам ключ в перечне есть.
   */
  const promised = new Set<string>();
  for (const spec of SETTING_SPECS) {
    for (const apply of spec.applies ?? []) {
      if (apply.action === 'recreate') promised.add(`${apply.target}:${spec.key}`);
    }
  }
  /*
   * Перевыпускаемые секреты — вторая законная причина писать в файл.
   *
   * Записывает их ПЕРВАЯ служба списка (у общего секрета двух служб это
   * та, которая его проверяет), остальные только пересоздаются: ключ уже
   * в файле. Поэтому в разрешённые попадает ровно одна пара на секрет —
   * право писать SESSION_SECRET «через postfix» так же лишне, как право
   * писать туда пароль базы.
   */
  for (const secret of ROTATABLE_SECRETS) {
    const first = secret.applies[0];
    if (first) promised.add(`${first.target}:${secret.key}`);
  }
  const stray: string[] = [];
  for (const block of table.matchAll(/(\w+)\s*=>\s*\{([^}]*)\}/gu)) {
    const service = block[1] ?? '';
    for (const key of (block[2] ?? '').matchAll(/([A-Z][A-Z0-9_]+)\s*=>\s*1/gu)) {
      const name = key[1] ?? '';
      if (!promised.has(`${service}:${name}`)) stray.push(`${name} (служба ${service})`);
    }
  }
  assert.deepEqual(
    stray,
    [],
    'Посреднику разрешено писать в infra/.env то, чего перечень настроек ему не поручал. ' +
      `Это лишнее право у службы с сокетом Docker:\n${stray.join('\n')}`,
  );
});

void test('в списке посредника у каждой службы ровно одна запись', async () => {
  /*
   * Поймано живьём: в %ENV_KEYS стояли ДВЕ записи «postfix» и две
   * «nginx» — сначала с BIND_ADDRESS, потом пустые. В Perl побеждает
   * последняя, поэтому обе пустышки молча отменяли разрешения выше:
   * панель сохраняла BIND_ADDRESS и показывала его применённым, а
   * посредник отказывался его записывать.
   *
   * Проверки выше этого не видели по устройству: они разбирают таблицу
   * регулярным выражением и складывают ВСЕ найденные пары, то есть
   * моделируют объединение, а не перезапись. Отсюда отдельная проверка
   * на сам факт повтора имени.
   */
  const path = new URL('../../../../infra/service-agent/agent.pl', import.meta.url);
  const source = await readFile(path, 'utf8');
  const table = source.slice(source.indexOf('my %ENV_KEYS'), source.indexOf('if ($TOKEN eq'));

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const block of table.matchAll(/^\s{4}(\w+)\s*=>\s*\{/gmu)) {
    const service = block[1] ?? '';
    if (seen.has(service)) duplicates.push(service);
    seen.add(service);
  }
  assert.deepEqual(
    duplicates,
    [],
    'Служба перечислена в %ENV_KEYS дважды — последняя запись затирает предыдущие, ' +
      `и разрешения из них молча пропадают: ${duplicates.join(', ')}`,
  );
});

void test('перевыпуск секретов: только секреты, только известные службы', () => {
  for (const secret of ROTATABLE_SECRETS) {
    const spec = SETTING_SPECS.find((s) => s.key === secret.key);
    assert.ok(spec, `${secret.key} перевыпускается, но в перечне настроек его нет`);
    // Перевыпуск не превращает секрет в обычную настройку: значение
    // по-прежнему не отдаётся и не вводится руками.
    assert.equal(spec.secret, true, `${secret.key} перевыпускается, но не помечен секретом`);
    assert.equal(spec.group, 'locked', `${secret.key} обязан оставаться в locked`);
    assert.ok(secret.applies.length > 0, `${secret.key} перевыпускается, но никого не пересоздаёт`);
    for (const apply of secret.applies) {
      const target = findTarget(apply.target);
      assert.ok(target, `${secret.key}: службы «${apply.target}» нет в перечне перезапускаемых`);
      assert.ok(
        target.actions.includes(apply.action),
        `${secret.key}: служба «${apply.target}» не умеет «${apply.action}»`,
      );
    }
    // Цена нажатия обязана быть названа словами: кнопка, выкидывающая
    // всех администраторов, не имеет права выглядеть как «обновить».
    assert.ok(secret.impact.length > 60, `${secret.key}: не описано, что сломается`);
  }
});

void test('ключи шифрования не перевыпускаются: ими закрыто уже записанное', () => {
  /*
   * Поймано живьём и стоило бы данных. В списке перевыпускаемых стоял
   * ADMIN_SESSION_SECRET — по имени он читается как «подпись сессий
   * панели». На деле cookie панели подписана общим SESSION_SECRET, а
   * этим ключом ЗАШИФРОВАНЫ пароли импорта, пароли исходных ящиков в
   * заданиях переноса и приватный ключ DKIM при смене домена. Кнопка
   * ничего из обещанного не делала (проверено: старая cookie после
   * перевыпуска продолжала работать) и молча делала бы зашифрованное
   * нечитаемым навсегда.
   *
   * Отсюда правило: ключ, которым что-то ЗАШИФРОВАНО в базе, в этот
   * список не попадает. Решение принимается по тому, кто ключ читает,
   * а не по тому, как он назван.
   */
  const encryptionKeys = [
    'ADMIN_SESSION_SECRET',
    'AI_ENCRYPTION_KEY',
    'EXTERNAL_ACCOUNTS_KEY',
    'PUSH_VAPID_PRIVATE_KEY',
  ];
  const wrong = ROTATABLE_SECRETS.filter((s) => encryptionKeys.includes(s.key)).map((s) => s.key);
  assert.deepEqual(
    wrong,
    [],
    'Этими ключами зашифрованы данные в базе — перевыпуск делает их нечитаемыми: ' +
      wrong.join(', '),
  );
});

void test('подпись сессий не перевыпускается, пока она же служит ключом шифрования', () => {
  // На сервере без отдельного ADMIN_SESSION_SECRET шифрование идёт на
  // SESSION_SECRET (admin/config.ts, importSecret). Там перевыпуск — та
  // же потеря данных, только с другой стороны.
  const session = ROTATABLE_SECRETS.find((s) => s.key === 'SESSION_SECRET');
  assert.ok(session, 'SESSION_SECRET должен быть в списке перевыпускаемых');
  assert.ok(session.guard, 'у SESSION_SECRET обязана быть проверка перед перевыпуском');

  const blocked = session.guard({} as NodeJS.ProcessEnv);
  assert.ok(blocked, 'без ADMIN_SESSION_SECRET перевыпуск обязан отказывать');
  // Отказ обязан говорить, что делать: «нельзя» без выхода — тупик.
  assert.match(blocked, /ADMIN_SESSION_SECRET/);

  const allowed = session.guard({ ADMIN_SESSION_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv);
  assert.equal(allowed, null, 'с отдельным ключом шифрования перевыпуск разрешён');
});

void test('новый секрет проходит собственную проверку схемы', () => {
  /*
   * SESSION_SECRET проверяется схемой на минимум 32 символа. Секрет
   * короче уронил бы сервер приложения при следующем запуске — то есть
   * кнопка «перевыпустить» превратилась бы в кнопку «сломать вход».
   */
  for (const secret of ROTATABLE_SECRETS) {
    const value = generateSecret(secret.bytes);
    assert.ok(value.length >= 32, `${secret.key}: секрет короче 32 символов`);
    // Значение попадает в infra/.env построчно и в командные строки
    // контейнеров: пробелы, кавычки и знаки доллара там ломают разбор.
    assert.match(value, /^[A-Za-z0-9_-]+$/u, `${secret.key}: в секрете есть опасные символы`);
  }
  // Два вызова подряд не дают одинакового значения — иначе «перевыпуск»
  // ничего бы не перевыпускал.
  assert.notEqual(generateSecret(32), generateSecret(32));
});

void test('раздел каждой настройки существует, ключи не повторяются', () => {
  const sections = new Set(SETTING_SECTIONS.map((s) => s.id));
  const seen = new Set<string>();
  for (const spec of SETTING_SPECS) {
    assert.ok(sections.has(spec.section), `неизвестный раздел «${spec.section}» у ${spec.key}`);
    assert.ok(!seen.has(spec.key), `ключ ${spec.key} встречается дважды`);
    seen.add(spec.key);
    assert.ok(spec.description.length > 10, `у ${spec.key} нет человеческого описания`);
    if (spec.group === 'locked') {
      assert.ok(spec.reason, `у ${spec.key} не сказано, почему его нельзя менять`);
    }
  }
});

void test('ни один секрет не попал в список изменяемого', () => {
  const secrets = SETTING_SPECS.filter((s) => s.secret === true);
  assert.ok(secrets.length > 0, 'секреты должны быть перечислены — иначе их негде запретить');
  for (const spec of secrets) {
    assert.equal(spec.group, 'locked', `${spec.key} — секрет, а лежит в изменяемых`);
    assert.equal(isEditable(spec.key), false);
    assert.equal(EDITABLE_KEYS.includes(spec.key), false);
  }
});

/* ------------------------------------------------------------------ */
/* 2. Порядок разрешения: база > окружение > умолчание                  */
/* ------------------------------------------------------------------ */

void test('значение из базы побеждает переменную окружения', async () => {
  const { settings } = make([{ key: 'MAIL_FLOW_RETENTION_DAYS', value: '30' }], {
    MAIL_FLOW_RETENTION_DAYS: '14',
  });
  const item = await settings.resolve('MAIL_FLOW_RETENTION_DAYS');
  assert.equal(item.raw, '30');
  assert.equal(item.source, 'db');
  assert.equal(await settings.int('MAIL_FLOW_RETENTION_DAYS'), 30);
});

void test('без строки в базе действует окружение, без окружения — умолчание', async () => {
  const withEnv = make([], { MAIL_FLOW_RETENTION_DAYS: '21' });
  const fromEnv = await withEnv.settings.resolve('MAIL_FLOW_RETENTION_DAYS');
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.raw, '21');

  const bare = make([], {});
  const fromDefault = await bare.settings.resolve('MAIL_FLOW_RETENTION_DAYS');
  assert.equal(fromDefault.source, 'default');
  assert.equal(fromDefault.raw, '14');
});

void test('пустая переменная окружения не превращается в ноль', async () => {
  // Number('') === 0: без этой защиты стёртый ключ означал бы «хранить
  // ноль дней», то есть немедленную потерю всей истории доставки.
  const { settings } = make([], { MAIL_FLOW_RETENTION_DAYS: '' });
  assert.equal(await settings.int('MAIL_FLOW_RETENTION_DAYS'), 14);
  assert.equal((await settings.resolve('MAIL_FLOW_RETENTION_DAYS')).source, 'default');
});

void test('пустая строка остаётся значением там, где пустота осмысленна', async () => {
  const { settings } = make([], { DNS_CHECK_RESOLVERS: '' });
  const item = await settings.resolve('DNS_CHECK_RESOLVERS');
  assert.equal(item.source, 'env');
  assert.equal(item.raw, '');
});

void test('негодное значение в базе не роняет запрос — берётся умолчание', async () => {
  const { settings } = make([
    { key: 'ADMIN_DEFAULT_QUOTA_BYTES', value: 'не-число' },
    { key: 'ADMIN_LOGIN_MAX_FAILURES', value: '999999' },
  ]);
  assert.equal(await settings.int('ADMIN_DEFAULT_QUOTA_BYTES'), 1073741824);
  // Выход за предел перечня — тоже негодное значение.
  assert.equal(await settings.int('ADMIN_LOGIN_MAX_FAILURES'), 5);
});

void test('отказ базы не обнуляет настройки: работаем по окружению', async () => {
  const { db, settings } = make([], { ADMIN_LOGIN_MAX_FAILURES: '7' });
  db.fail = Object.assign(new Error('база лежит'), { code: '08006' });
  assert.equal(await settings.int('ADMIN_LOGIN_MAX_FAILURES'), 7);
});

void test('отсутствие таблицы (миграция не применена) не мешает работать', async () => {
  const { db, settings } = make([], { ADMIN_LOGIN_MAX_FAILURES: '9' });
  db.fail = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  assert.equal(await settings.int('ADMIN_LOGIN_MAX_FAILURES'), 9);
});

void test('строка с ключом вне перечня не действует ни на что', async () => {
  // Ровно то, ради чего перечень живёт в коде: доступ к базе не должен
  // давать подмену строки подключения и секретов.
  const { settings } = make(
    [
      { key: 'DATABASE_URL', value: 'postgres://chuzhoy/host' },
      { key: 'SESSION_SECRET', value: 'подменённый-секрет' },
      { key: 'MAIL_DOMAIN', value: 'zloy.example' },
    ],
    { MAIL_DOMAIN: 'mail.local' },
  );
  const domain = await settings.resolve('MAIL_DOMAIN');
  assert.equal(domain.raw, 'mail.local', 'locked-настройку строка в базе подменять не должна');
  assert.equal(domain.source, 'env');
  assert.equal(findSetting('DATABASE_URL'), undefined);
  assert.equal(findSetting('SESSION_SECRET')?.group, 'locked');
});

/* ------------------------------------------------------------------ */
/* 3. Проверка вводимых значений                                        */
/* ------------------------------------------------------------------ */

void test('число проверяется по пределам перечня', () => {
  const spec = findSetting('ADMIN_LOGIN_MAX_FAILURES')!;
  assert.equal(parseSettingValue(spec, 10), '10');
  assert.equal(parseSettingValue(spec, '10'), '10');
  assert.throws(() => parseSettingValue(spec, 0), /минимум 1/u);
  assert.throws(() => parseSettingValue(spec, 1000), /максимум 100/u);
  assert.throws(() => parseSettingValue(spec, '3.5'), /целое число/u);
  assert.throws(() => parseSettingValue(spec, 'пять'), /целое число/u);
});

void test('да/нет принимается в человеческих написаниях, мусор — нет', () => {
  const spec = findSetting('PUSH_ENABLED')!;
  for (const yes of [true, 'true', '1', 'yes', 'ON']) {
    assert.equal(parseSettingValue(spec, yes), 'true');
  }
  for (const no of [false, 'false', '0', 'no', 'Off']) {
    assert.equal(parseSettingValue(spec, no), 'false');
  }
  assert.throws(() => parseSettingValue(spec, 'может быть'), /да или нет/u);
});

void test('панель и сервер одинаково читают «да», как бы оно ни было записано', async () => {
  /*
   * Разошлись — и панель соврала ровно наоборот.
   *
   * `typedValue` готовит значение ДЛЯ ЭКРАНА, `bool()` — для кода
   * сервера. Первая принимала только true/1, вторая ещё yes/on. А в
   * infra/.env штатно лежат `DOVECOT_DISABLE_PLAINTEXT_AUTH=yes` и
   * `UNBOUND_DNSSEC=yes` — так их пишет установщик и так их читают сами
   * службы. Панель показывала оба переключателя выключенными, то есть
   * сообщала, что пароль ходит по нешифрованному соединению и подписи
   * DNS не проверяются. Обе настройки при этом работали.
   */
  const spec = findSetting('PUSH_ENABLED')!;
  for (const yes of ['true', '1', 'yes', 'YES', 'on', ' On ']) {
    const { settings } = make([], { PUSH_ENABLED: yes });
    assert.equal(typedValue(spec, yes), true, `панель не поняла «${yes}»`);
    assert.equal(await settings.bool('PUSH_ENABLED'), true, `сервер не понял «${yes}»`);
  }
  for (const no of ['false', '0', 'no', 'Off']) {
    const { settings } = make([], { PUSH_ENABLED: no });
    assert.equal(typedValue(spec, no), false, `панель не поняла «${no}»`);
    assert.equal(await settings.bool('PUSH_ENABLED'), false, `сервер не понял «${no}»`);
  }
});

void test('перечисление принимает только известные значения', () => {
  const spec = findSetting('LOG_LEVEL')!;
  assert.equal(parseSettingValue(spec, 'debug'), 'debug');
  assert.throws(() => parseSettingValue(spec, 'подробно'), /принимает одно из/u);
});

void test('перевод строки в значении не принимается', () => {
  // Иначе одна настройка подсунула бы вторую тому, кто разбирает
  // окружение построчно.
  const spec = findSetting('AI_REDIS_PREFIX')!;
  assert.throws(() => parseSettingValue(spec, 'mt:ai:\nSESSION_SECRET=x'), /перевод строки/u);
});

void test('пустое значение принимается только там, где пустота осмысленна', () => {
  assert.equal(parseSettingValue(findSetting('DNS_CHECK_RESOLVERS')!, ''), '');
  assert.throws(() => parseSettingValue(findSetting('SESSION_COOKIE_NAME')!, ''), /не может быть/u);
});

/* ------------------------------------------------------------------ */
/* 4. Запись, возврат к умолчанию и запрет на locked                    */
/* ------------------------------------------------------------------ */

void test('запись сохраняет значение и показывает, что было до неё', async () => {
  const { db, settings } = make([], { ADMIN_DEFAULT_QUOTA_BYTES: '1073741824' });
  const { before, after } = await settings.set('ADMIN_DEFAULT_QUOTA_BYTES', 5368709120, 'osmotr');
  assert.equal(before.raw, '1073741824');
  assert.equal(before.source, 'env');
  assert.equal(after.raw, '5368709120');
  assert.equal(after.source, 'db');
  assert.equal(db.rows[0]?.updated_by, 'osmotr');
});

void test('возврат к умолчанию убирает строку и возвращает окружение', async () => {
  const { db, settings } = make([{ key: 'ADMIN_DEFAULT_QUOTA_BYTES', value: '5368709120' }], {
    ADMIN_DEFAULT_QUOTA_BYTES: '1073741824',
  });
  const { after } = await settings.reset('ADMIN_DEFAULT_QUOTA_BYTES');
  assert.equal(after.raw, '1073741824');
  assert.equal(after.source, 'env');
  assert.equal(db.rows.length, 0);
});

/*
 * ГЛАВНАЯ ЛОВУШКА СБРОСА.
 *
 * При старте все незалоченные значения из базы подмешиваются прямо в
 * `process.env` (applyStoredEnv) — так их видят те части сервера, которые
 * читают окружение. После «вернуть к умолчанию» строка из базы уходила, а
 * значение оставалось в окружении: сброс не возвращал НИЧЕГО.
 *
 * Для настройки группы «действует сразу» это значит, что она продолжала
 * работать со старым значением до перезапуска процесса. А панель при этом
 * подписывала его «из окружения (infra/.env)» — администратор шёл искать
 * эту строку в файле и не находил.
 */
void test('сброс убирает значение и из окружения, куда его положил сам сервер', async () => {
  const env: NodeJS.ProcessEnv = {};
  const db = new FakeDb();
  db.rows = [
    {
      key: 'ADMIN_SESSION_TTL_SECONDS',
      value: '3600',
      updated_by: 'osmotr',
      updated_at: new Date(),
    },
  ];
  // Так делает старт сервера: значения из базы попадают в окружение.
  applyRowsToEnv([{ key: 'ADMIN_SESSION_TTL_SECONDS', value: '3600' }], env);
  assert.equal(env.ADMIN_SESSION_TTL_SECONDS, '3600', 'значение не подмешалось — проверять нечего');

  const settings = new ServerSettings({ db, env, cacheMs: 0 });
  const { after } = await settings.reset('ADMIN_SESSION_TTL_SECONDS');

  assert.equal(env.ADMIN_SESSION_TTL_SECONDS, undefined, 'значение осталось в окружении');
  assert.equal(after.source, 'default', 'сброс вернул не умолчание, а прежнее значение');
  assert.equal(after.raw, '28800');
});

void test('значение, прописанное человеком в infra/.env, сброс не трогает', () => {
  // Оно и есть то умолчание, к которому возвращает сброс: удалять его
  // значило бы стирать чужую настройку из файла.
  const env: NodeJS.ProcessEnv = { ADMIN_SESSION_TTL_SECONDS: '7200' };
  assert.equal(forgetStoredEnv('ADMIN_SESSION_TTL_SECONDS', env), false);
  assert.equal(env.ADMIN_SESSION_TTL_SECONDS, '7200');
});

/*
 * ВТОРАЯ ЛОВУШКА СБРОСА: СТРОКА В infra/.env ПОД НАШИМ ЗНАЧЕНИЕМ.
 *
 * Случай самый обычный на живом сервере: строку в infra/.env написал
 * установщик, потом её перекрыли в панели, потом нажали «вернуть к
 * умолчанию». Сброс удалял ключ из окружения целиком — и значение из
 * ФАЙЛА исчезало вместе с нашим. Панель показывала умолчание продукта и
 * подписывала его «умолчание», хотя в файле лежало другое; после
 * ближайшего перезапуска написанное в файле возвращалось, и настройка
 * молча меняла значение сама по себе.
 */
void test('сброс возвращает строку из infra/.env, которую перекрыла панель', async () => {
  const env: NodeJS.ProcessEnv = { RATE_LIMIT_MAX: '150' };
  const db = new FakeDb();
  db.rows = [{ key: 'RATE_LIMIT_MAX', value: '900', updated_by: 'osmotr', updated_at: new Date() }];
  applyRowsToEnv([{ key: 'RATE_LIMIT_MAX', value: '900' }], env);
  assert.equal(env.RATE_LIMIT_MAX, '900', 'значение из базы не подмешалось — проверять нечего');

  const settings = new ServerSettings({ db, env, cacheMs: 0 });
  const { after } = await settings.reset('RATE_LIMIT_MAX');

  assert.equal(env.RATE_LIMIT_MAX, '150', 'значение из infra/.env стёрто вместе с нашим');
  assert.equal(after.raw, '150', 'сброс вернул не к тому, что в файле');
  assert.equal(after.source, 'env');
});

/*
 * ТРЕТЬЯ ЛОВУШКА: ГРУППА restart ПОСЛЕ СБРОСА.
 *
 * Значение этой группы читается ОДИН РАЗ при старте. Сброс не может
 * отменить того, что уже прочитано: живой процесс продолжает работать со
 * сброшенным значением до перезапуска. Признак «ждёт перезапуска»
 * считался по текущему окружению, а сброс это окружение и правил, — и
 * получалось спокойное «перезапуск не нужен» о процессе, который живёт
 * с прежним. Настроек в группе 59.
 */
void test('после сброса настройки группы restart видно, что процесс живёт со старым', async () => {
  const env: NodeJS.ProcessEnv = {};
  const db = new FakeDb();
  db.rows = [
    { key: 'SESSION_TTL_SECONDS', value: '86400', updated_by: 'osmotr', updated_at: new Date() },
  ];
  applyRowsToEnv([{ key: 'SESSION_TTL_SECONDS', value: '86400' }], env);

  const settings = new ServerSettings({ db, env, cacheMs: 0 });
  const { after } = await settings.reset('SESSION_TTL_SECONDS');

  // Значение, к которому вернулись, — умолчание продукта.
  assert.equal(after.raw, '604800');
  assert.equal(after.source, 'default');
  // А процесс до перезапуска живёт с прежним, и это должно быть видно.
  assert.equal(after.envRaw, '86400', 'потеряно то, с чем стартовал живой процесс');
  assert.notEqual(after.raw, after.envRaw, 'панель скажет «перезапуск не нужен» — и соврёт');
});

void test('настройку из группы locked записать нельзя', async () => {
  const { settings } = make();
  await assert.rejects(
    () => settings.set('MAIL_DOMAIN', 'zloy.example', 'osmotr'),
    /не меняется из панели/u,
  );
  await assert.rejects(
    () => settings.set('POSTGRES_PASSWORD', 'x', 'osmotr'),
    /не меняется из панели/u,
  );
  await assert.rejects(() => settings.set('DATABASE_URL', 'x', 'osmotr'), /Неизвестная настройка/u);
});

void test('кэш не заставляет ждать собственное изменение', async () => {
  const db = new FakeDb();
  // Кэш длинный: без сброса при записи новое значение не увидели бы минуту.
  const settings = new ServerSettings({ db, env: {}, cacheMs: 60_000 });
  assert.equal(await settings.int('ADMIN_LOGIN_MAX_FAILURES'), 5);
  await settings.set('ADMIN_LOGIN_MAX_FAILURES', 12, 'osmotr');
  assert.equal(await settings.int('ADMIN_LOGIN_MAX_FAILURES'), 12);
});

void test('кэш действительно бережёт базу: один запрос вместо десяти', async () => {
  const db = new FakeDb();
  const settings = new ServerSettings({ db, env: {}, cacheMs: 60_000 });
  await Promise.all(Array.from({ length: 10 }, () => settings.int('ADMIN_LOGIN_MAX_FAILURES')));
  const selects = db.queries.filter((q) => q.text.startsWith('SELECT'));
  assert.equal(selects.length, 1, `походов в базу: ${selects.length}`);
});

void test('все настройки перечня отдаются одним чтением', async () => {
  const { settings } = make([{ key: 'ADMIN_LOCKOUT_MINUTES', value: '45' }]);
  const all = await settings.resolveAll();
  assert.equal(all.length, SETTING_SPECS.length);
  assert.equal(all.find((i) => i.spec.key === 'ADMIN_LOCKOUT_MINUTES')?.raw, '45');
});
