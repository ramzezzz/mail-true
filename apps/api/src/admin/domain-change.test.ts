/**
 * Смена домена: разбор имён, реестр адресных колонок и оценки плана.
 *
 * Проверяется здесь ровно то, что нельзя проверить на стенде за разумное
 * время, но чем можно тихо испортить весь перенос:
 *
 *   * имя сервера при смене домена (mail.старый → mail.новый, но НЕ
 *     mx1.хостер.рф → mx1.новый: на это имя выписан сертификат и оно
 *     стоит в чужих зонах);
 *   * полнота реестра колонок — пропущенная таблица означает молча
 *     потерянные подписи или фильтры у всех людей сразу;
 *   * что перенос местами не трогает то, что трогать нельзя.
 *
 * На старом коде падают все проверки: раздела смены домена не было.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  addressInDomain,
  estimateDowntime,
  hostnameForDomain,
  isDomainName,
  moveAddress,
  normalizeDomain,
  breaksOf,
  manualStepsOf,
  FREE_TEXT_PLACES,
  KEPT_ADDRESS_PLACES,
  OWNER_ADDRESS_COLUMNS,
} from './domain-change.js';
import { dkimRecordName, generateDkimKeyPair } from './dkim-keygen.js';
import {
  crossDeviceBlocker,
  CrossDeviceMove,
  moveDomainDirectories,
} from './domain-change-files.js';

/* ------------------------------------------------------------------ */
/* Имена                                                               */
/* ------------------------------------------------------------------ */

void test('имя сервера следует за доменом только когда оно из него и получено', () => {
  // Классический случай: mail.старый → mail.новый.
  assert.equal(hostnameForDomain('staraya.ru', 'mail.staraya.ru', 'novaya.ru'), 'mail.novaya.ru');
  // Имя сервера совпадает с доменом — меняется целиком.
  assert.equal(hostnameForDomain('staraya.ru', 'staraya.ru', 'novaya.ru'), 'novaya.ru');
  /*
   * А вот это — главная проверка файла. Сервер хостера обслуживает домен
   * заказчика: его имя к домену отношения не имеет, на него выписан
   * сертификат и оно стоит в MX чужих зон. Переименовать его при смене
   * домена значит сломать почту у всех остальных доменов этого сервера.
   */
  assert.equal(
    hostnameForDomain('staraya.ru', 'mx1.hoster.example', 'novaya.ru'),
    'mx1.hoster.example',
    'имя сервера, не выведенное из домена, менять нельзя',
  );
  // Многоуровневая приставка сохраняется целиком.
  assert.equal(
    hostnameForDomain('staraya.ru', 'mx.mail.staraya.ru', 'novaya.ru'),
    'mx.mail.novaya.ru',
  );
});

void test('домен нормализуется и проверяется', () => {
  assert.equal(normalizeDomain('  Novaya.RU. '), 'novaya.ru');
  assert.ok(isDomainName('novaya.ru'));
  assert.ok(isDomainName('xn--80ak6aa92e.com'), 'punycode — обычное доменное имя');
  assert.equal(isDomainName('novaya'), false, 'одна метка доменом не является');
  assert.equal(isDomainName('https://novaya.ru'), false);
  assert.equal(isDomainName('иванов.рф'), false, 'кириллицу требуем в punycode');
  assert.equal(isDomainName('-novaya.ru'), false);
});

void test('меняется только домен, локальная часть остаётся как есть', () => {
  assert.equal(
    moveAddress('ivan.petrov+rassylka@staraya.ru', 'novaya.ru'),
    'ivan.petrov+rassylka@novaya.ru',
  );
  assert.ok(addressInDomain('ivan@staraya.ru', 'staraya.ru'));
  assert.equal(
    addressInDomain('ivan@nestaraya.ru', 'staraya.ru'),
    false,
    'совпадение должно быть по всему домену, а не по хвосту строки',
  );
  assert.equal(addressInDomain('bezdomena', 'staraya.ru'), false);
});

/* ------------------------------------------------------------------ */
/* Реестр адресных колонок                                             */
/* ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../../../infra/postgres/migrations');

/** Все объявления колонок вида `<имя> VARCHAR|TEXT` по всем миграциям. */
function migrationsText(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

void test('каждая колонка реестра действительно объявлена в миграциях', () => {
  const sql = migrationsText();
  for (const col of OWNER_ADDRESS_COLUMNS) {
    assert.ok(
      new RegExp(`CREATE TABLE[^;]*?${col.table}\\b`, 'isu').test(sql) ||
        sql.includes(`ALTER TABLE ${col.table}`),
      `таблица ${col.table} не найдена в миграциях — реестр разошёлся со схемой`,
    );
  }
});

/**
 * Реестр не должен отстать от схемы.
 *
 * Проверка не «красивая», а вынужденная. Ближайший родственник этого
 * реестра — уборка после удаления ящика (purgeMailboxData в db.ts) —
 * перечислял таблицы руками и отстал на четырнадцать разделов из
 * двадцати четырёх: у удалённого ящика оставались метки, шаблоны,
 * история входов и — хуже всего — ДЕЙСТВУЮЩИЕ одноразовые адреса.
 * Теперь уборка строится из этого реестра, поэтому проверка стережёт
 * сразу обе работы: список колонок `account_email`/`owner_email` в схеме
 * сверяется с реестром автоматически.
 */
void test('в схеме нет колонки-владельца, которой нет в реестре', () => {
  const sql = migrationsText();
  const declared = new Set<string>();
  // «    account_email   VARCHAR(320) NOT NULL,» внутри CREATE TABLE <имя>
  const tableRe = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/gu;
  for (const match of sql.matchAll(tableRe)) {
    const table = match[1] ?? '';
    const body = match[2] ?? '';
    for (const line of body.split('\n')) {
      const col = /^\s*(account_email|owner_email|linked_email|account)\s+(VARCHAR|TEXT)/iu.exec(
        line,
      );
      if (col) declared.add(`${table}.${col[1]?.toLowerCase() ?? ''}`);
    }
  }
  assert.ok(declared.size > 15, `нашлось всего ${String(declared.size)} колонок — разбор сломался`);

  const known = new Set(OWNER_ADDRESS_COLUMNS.map((c) => `${c.table}.${c.column}`));
  const missing = [...declared].filter((d) => !known.has(d));
  assert.deepEqual(
    missing,
    [],
    'эти колонки хранят адрес владельца, но при смене домена не переписываются',
  );
});

void test('адреса, которые трогать нельзя, в реестр не попали', () => {
  const forbidden = [
    // Разобранный журнал доставки — факт прошлого, да ещё и с триграммными
    // индексами на полтаблицы.
    'mail_flow_events.sender',
    'mail_flow_events.recipient',
    // Журнал административных действий: переписанная история перестаёт
    // быть историей.
    'admin_audit_log.target_label',
    'admin_mailbox_access.mailbox_email',
    // Снимки заголовков письма: по ним строка находит письмо в ящике.
    'snoozed_messages.from_address',
    'trash_recovery_items.from_address',
    'muted_threads.from_address',
    'awaiting_replies.to_addresses',
    // Чужой сервер, с которого переносили почту.
    'mail_migration_items.source_user',
    'external_accounts.address',
    'external_accounts.imap_user',
  ];
  const known = new Set(OWNER_ADDRESS_COLUMNS.map((c) => `${c.table}.${c.column}`));
  for (const item of forbidden) {
    assert.equal(known.has(item), false, `${item} переписывать нельзя, а он в реестре`);
  }
});

void test('человеку объяснено, что именно останется с прежним доменом', () => {
  assert.ok(KEPT_ADDRESS_PLACES.length >= 5);
  for (const place of KEPT_ADDRESS_PLACES) {
    assert.ok(place.what.length > 0);
    assert.ok(place.why.length > 30, `«${place.what}» без объяснения причины — это отписка`);
  }
  // Тексты, которые человек писал руками, считаются, но не правятся.
  assert.ok(FREE_TEXT_PLACES.some((p) => p.table === 'mail_signatures'));
  assert.ok(FREE_TEXT_PLACES.some((p) => p.table === 'mail_saved_searches'));
});

/* ------------------------------------------------------------------ */
/* Оценки и предупреждения                                             */
/* ------------------------------------------------------------------ */

void test('простой растёт вместе с числом строк и всегда назван вилкой', () => {
  const small = estimateDowntime({
    mailboxes: 3,
    aliases: 1,
    disposableAliases: 0,
    messages: 100,
    bytes: 1000,
    rows: 20,
    tables: [],
    freeTextHits: [],
  });
  const big = estimateDowntime({
    mailboxes: 5000,
    aliases: 2000,
    disposableAliases: 0,
    messages: 9_000_000,
    bytes: 900_000_000_000,
    rows: 400_000,
    tables: [],
    freeTextHits: [],
  });
  assert.ok(small.min > 0 && small.max > small.min, 'вилка, а не одно число');
  assert.ok(big.min > small.min, 'на большом сервере простой заметно больше');
  /*
   * Объём писем на простой НЕ влияет: переезд это переименование
   * каталога. Если однажды кто-то вернёт сюда копирование, эта проверка
   * упадёт — и правильно сделает.
   */
  assert.ok(big.max < 3600, 'даже терабайт писем не превращает смену домена в час простоя');
});

void test('последствия названы прямо, а не смягчены', () => {
  const breaks = breaksOf('staraya.ru', 'novaya.ru', 42);
  const text = breaks.join(' ');
  assert.match(text, /42/u, 'сказано, скольких людей это коснётся');
  assert.match(text, /почтов/iu);
  assert.match(text, /DKIM/u);
  const manual = manualStepsOf('novaya.ru', 'mail.novaya.ru');
  assert.match(manual.join(' '), /change-domain\.sh/u, 'названа конкретная команда');
  assert.match(manual.join(' '), /Let's Encrypt/u, 'сказано, что делать с сертификатом');
});

/* ------------------------------------------------------------------ */
/* Ключ DKIM                                                           */
/* ------------------------------------------------------------------ */

void test('выпущенный ключ DKIM годится для записи в DNS', () => {
  const pair = generateDkimKeyPair();
  assert.match(pair.privatePem, /^-----BEGIN PRIVATE KEY-----/u);
  assert.match(pair.publicKey, /^[A-Za-z0-9+/=]+$/u, 'публичная часть — чистый base64 для p=');
  /*
   * Длина ключа проверяется через длину base64 SPKI: у RSA-2048 это
   * около 392 символов. Ключ 1024 бит (≈216) уже отвергают крупные
   * службы, 4096 (≈736) не помещается в одну строку TXT и режется
   * панелями регистраторов неправильно.
   */
  assert.ok(
    pair.publicKey.length > 350 && pair.publicKey.length < 450,
    `неожиданная длина ключа: ${String(pair.publicKey.length)}`,
  );
  const another = generateDkimKeyPair();
  assert.notEqual(pair.publicKey, another.publicKey, 'каждый выпуск даёт новый ключ');
  assert.equal(dkimRecordName('mail', 'novaya.ru'), 'mail._domainkey.novaya.ru');
});

/**
 * Уборка после удаления ящика покрывает весь реестр.
 *
 * Раньше список таблиц жил в db.ts отдельно и отстал от продукта: строки
 * четырнадцати разделов переживали своего владельца, а ящик, заведённый
 * заново с тем же адресом, доставался новому человеку вместе с ними.
 * Теперь список один — и эта проверка следит, чтобы он таким и остался:
 * каждая запись реестра либо убирается, либо помечена «оставить» с
 * объяснением почему.
 */
void test('каждая строка реестра либо убирается при удалении, либо объяснена', () => {
  for (const col of OWNER_ADDRESS_COLUMNS) {
    if (col.onDelete === 'keep') {
      assert.ok(
        col.keepReason && col.keepReason.length > 20,
        `${col.table}.${col.column} переживает удаление ящика без объяснения`,
      );
    } else {
      assert.ok(
        col.onDelete === undefined || col.onDelete === 'delete',
        `${col.table}.${col.column}: неизвестное поведение при удалении`,
      );
    }
  }
});

void test('уборка после удаления ящика построена из реестра, а не переписана рядом', () => {
  /*
   * Исходник, а не собранный файл: проверка смотрит, КАК написан код.
   * Запуск идёт из dist/, поэтому путь пробуется дважды — рядом (запуск из
   * src) и через ../../src (запуск из dist).
   */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'db.ts'),
    path.join(here, '..', '..', 'src', 'admin', 'db.ts'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `не найден исходник db.ts; искал: ${candidates.join(', ')}`);
  const db = readFileSync(found, 'utf8');
  const purge = db.slice(db.indexOf('async purgeMailboxData'));
  const body = purge.slice(0, purge.indexOf('return removed;'));
  // Ни один РАЗДЕЛ не перечислен вручную: их список берётся из реестра.
  assert.match(body, /OWNER_ADDRESS_COLUMNS/u, 'уборка перестала опираться на реестр');

  /*
   * Запрет уточнён: нельзя выписывать руками таблицы, которые ЕСТЬ в
   * реестре, — именно они отстанут от продукта, когда появится новый
   * раздел. Прежняя формулировка запрещала любой `DELETE FROM <таблица>`
   * и тем самым запрещала чинить настоящий дефект.
   *
   * Дефект был такой: одноразовый адрес — это ДВЕ строки, маршрут в
   * `virtual_aliases` (его читает Postfix) и пристройка в
   * `disposable_aliases` со ссылкой на маршрут. Каскад работает только в
   * одну сторону, а реестр знает лишь про пристройку — поэтому после
   * удаления ящика маршрут оставался живым: почта на одноразовые адреса
   * принималась и уходила в никуда, а заведённый заново ящик с тем же
   * адресом получал накопленный на них спам.
   *
   * Родительская таблица в реестре не значится и значиться не должна: это
   * не раздел владельца, а строка, к которой раздел прицеплен. Такие
   * запросы разрешены — но только для таблиц ВНЕ реестра.
   */
  const registryTables = new Set(OWNER_ADDRESS_COLUMNS.map((column) => column.table));
  const handWritten = [...body.matchAll(/DELETE FROM (\w+)/gu)]
    .map((match) => match[1] ?? '')
    .filter((table) => registryTables.has(table));
  assert.deepEqual(
    handWritten,
    [],
    `в уборке выписаны руками разделы из реестра — они отстанут от продукта: ${handWritten.join(', ')}`,
  );
});

/* ------------------------------------------------------------------ */
/* Каталоги на разных устройствах                                       */
/* ------------------------------------------------------------------ */

void test('перенос между устройствами отказывается, НЕ ТРОНУВ каталоги', async () => {
  /*
   * Шапка domain-change-files.ts обещала копирование на случай разных
   * устройств, проверка места требовала под него весь объём писем, а план
   * предупреждал «письма придётся копировать». Копирования в продукте не
   * было ни строки — только rename. На сервере, где каталог домена
   * смонтирован отдельным томом, всё это означало одно: план проходил,
   * человек соглашался, и смена домена падала EXDEV уже ПОСЛЕ отметки
   * точки невозврата — домен нового имени заведён, почта осталась под
   * старым, а панель говорит «назад нельзя».
   *
   * Теперь такой перенос отказывается заранее и словами. Разные
   * устройства изображаются признаком renameOnly: false — тем самым,
   * который вызывающий уже посчитал на проверке условий.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'mt-dc-move-'));
  const indexRoot = await mkdtemp(path.join(tmpdir(), 'mt-dc-move-idx-'));
  const from = path.join(root, 'staryj.ru', 'ivan');
  await mkdir(from, { recursive: true });
  await writeFile(path.join(from, 'pismo'), 'письмо');

  await assert.rejects(
    () =>
      moveDomainDirectories(root, indexRoot, 'staryj.ru', 'novyj.ru', {
        renameOnly: false,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CrossDeviceMove, 'отказ обязан быть отдельным, узнаваемым');
      // Человеку сказано и что случилось, и что делать руками.
      assert.match(err.message, /устройств/iu);
      assert.match(err.message, /rsync|руками/iu);
      return true;
    },
  );

  // И ничего не тронуто: письма остались там, где были.
  assert.equal(existsSync(path.join(from, 'pismo')), true, 'каталог домена трогать было нельзя');
  assert.equal(existsSync(path.join(root, 'novyj.ru')), false, 'каталог нового домена не заводим');
});

void test('в пределах одного тома перенос по-прежнему мгновенный', async () => {
  // Обратный ход: отказ выше не должен ломать обычный случай.
  const root = await mkdtemp(path.join(tmpdir(), 'mt-dc-ok-'));
  const indexRoot = await mkdtemp(path.join(tmpdir(), 'mt-dc-ok-idx-'));
  await mkdir(path.join(root, 'staryj.ru', 'ivan'), { recursive: true });
  await writeFile(path.join(root, 'staryj.ru', 'ivan', 'pismo'), 'письмо');

  const moved = await moveDomainDirectories(root, indexRoot, 'staryj.ru', 'novyj.ru', {
    renameOnly: true,
  });

  assert.equal(moved.length, 1, 'каталог писем обязан переехать');
  assert.equal(existsSync(path.join(root, 'novyj.ru', 'ivan', 'pismo')), true);
});

void test('препятствие про разные устройства объясняет и причину, и выход', () => {
  const blocker = crossDeviceBlocker(false, '/var/mail/vhosts', 'staryj.ru');
  assert.ok(blocker, 'на разных устройствах смена домена обязана быть заблокирована');
  assert.equal(blocker.id, 'cross-device');
  assert.match(blocker.message, /staryj\.ru/u, 'надо назвать каталог, о котором речь');
  assert.match(blocker.fix, /rsync|mv/u, 'сказать, чем перенести руками');
  // На обычном сервере препятствия нет — иначе смена домена не работала бы
  // нигде.
  assert.equal(crossDeviceBlocker(true, '/var/mail/vhosts', 'staryj.ru'), null);
});
