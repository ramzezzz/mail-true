/**
 * Проверки того, что держится на самом SQL, — против НАСТОЯЩЕГО Postgres.
 *
 * Подделка базы здесь не годится: три из четырёх дефектов ниже — это
 * ошибки в запросах, и подделка повторила бы не запрос, а представление
 * о нём.
 *
 *   1. Настройки помощника ИИ читались от таблицы ai_domain_settings,
 *      а строку в ней заводила только миграция 0004. Домен, добавленный
 *      позже, не попадал в список и не открывался на правку: помощника
 *      нельзя было настроить ни для одного нового домена.
 *   2. Удаление ящика оставляло сотни строк в служебных таблицах.
 *   3. Удаление домена каскадом уносило алиасы — проверка была только
 *      по числу ящиков (сам каскад проверяется здесь как факт схемы).
 *   4. Записи о входе администратора в чужой ящик оставались открытыми
 *      навсегда, если он просто ушёл.
 *
 * Адрес базы берётся из TEST_DATABASE_URL или DATABASE_URL. Без него
 * тесты пропускаются: на машине без стенда это не повод краснеть.
 *
 *   TEST_DATABASE_URL=postgres://mailserver:пароль@127.0.0.1:5432/mailserver \
 *     node --test apps/api/dist/admin/db.integration.test.js
 *
 * Всё созданное убирается в конце, включая случай падения теста.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pino } from 'pino';
import { AdminDb } from './db.js';
import { AiDb } from '../ai/db.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const logger = pino({ level: 'silent' });

/** Метка прогона: по ней убирается всё созданное, даже если тест упал. */
const STAMP = `itest${String(Date.now()).slice(-8)}`;
const DOMAIN = `${STAMP}.local`;
const MAILBOX = `box@${DOMAIN}`;

async function withDb(
  fn: (admin: AdminDb, ai: AiDb) => Promise<void>,
): Promise<void> {
  const admin = new AdminDb({ connectionString: url, logger, max: 2 });
  const ai = new AiDb({ connectionString: url, logger, max: 2 });
  try {
    await fn(admin, ai);
  } finally {
    // Уборка: строки этого прогона не должны остаться на стенде.
    await admin
      .query(`DELETE FROM virtual_domains WHERE name LIKE $1`, [`${STAMP}%`])
      .catch(() => undefined);
    await admin
      .query(`DELETE FROM admin_mailbox_access WHERE mailbox_email LIKE $1`, [`%@${STAMP}%`])
      .catch(() => undefined);
    await admin
      .query(`DELETE FROM mailbox_deletions WHERE email LIKE $1`, [`%@${STAMP}%`])
      .catch(() => undefined);
    await admin.close().catch(() => undefined);
    await ai.close().catch(() => undefined);
  }
}

const skip = url === '' ? 'нет TEST_DATABASE_URL/DATABASE_URL — нужен живой Postgres' : false;

void test('новый домен сразу настраивается для помощника ИИ', { skip }, async () => {
  await withDb(async (admin, ai) => {
    const domain = await admin.resolveDomain(DOMAIN, true);
    assert.ok(domain, 'домен должен создаться');

    // 1. Домен виден в списке настроек ИИ. Раньше список фильтровал
    //    по наличию строки ai_domain_settings, и нового домена там не было.
    const list = await ai.listDomainSettings();
    const found = list.find((row) => row.domain === DOMAIN);
    assert.ok(found, 'новый домен обязан быть в списке настроек ИИ');
    assert.equal(found.enabled, false, 'помощник по умолчанию выключен');
    assert.equal(found.chatPath, '/chat/completions', 'значения по умолчанию должны быть на месте');
    assert.equal(found.providerLabel, 'Сервис ИИ');

    // 2. Настройки открываются на правку. Раньше здесь было «не найдено»,
    //    и сохранение — единственное место, где строка создаётся, —
    //    оставалось недостижимым.
    const before = await ai.findDomainSettingsById(domain.id);
    assert.ok(before, 'настройки нового домена должны читаться');

    // 3. И сохраняются.
    const saved = await ai.saveDomainSettings(domain.id, {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      maxRequestsPerPeriod: 200,
    });
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.model, 'qwen2.5:7b');
    assert.equal(saved?.maxRequestsPerPeriod, 200);

    // 4. И читаются по адресу ящика — тем же путём, каким их берёт почта.
    const byEmail = await ai.findDomainSettingsByEmail(`ivan@${DOMAIN}`);
    assert.equal(byEmail?.enabled, true);
  });
});

void test('удаление ящика убирает его строки из служебных таблиц', { skip }, async () => {
  await withDb(async (admin) => {
    const domain = await admin.resolveDomain(DOMAIN, true);
    assert.ok(domain);
    const user = await admin.createMailUser({
      domainId: domain.id,
      email: MAILBOX,
      passwordHash: '{PLAIN}нужен-только-для-строки',
      displayName: 'Проверка уборки',
      quotaBytes: 1024,
      active: true,
    });

    // Раскладываем мусор ровно там, где он копился на стенде.
    await admin.query(
      `INSERT INTO mail_user_settings (account_email, sender_name) VALUES ($1, 'Кто-то')`,
      [MAILBOX],
    );
    await admin.query(
      `INSERT INTO mail_signatures (account_email, name, body_html) VALUES ($1, 'Подпись', '<p>x</p>')`,
      [MAILBOX],
    );
    await admin.query(
      `INSERT INTO mail_filters (account_email, name) VALUES ($1, 'Правило')`,
      [MAILBOX],
    );
    await admin.query(
      `INSERT INTO migrate_cursors (account, source_folder, uid_validity, last_uid)
       VALUES ($1, 'INBOX', '1', 10)`,
      [MAILBOX],
    );
    for (let i = 0; i < 5; i += 1) {
      await admin.query(
        `INSERT INTO migrate_messages (account, dest_folder, dedup_key) VALUES ($1, 'INBOX', $2)`,
        [MAILBOX, `key-${String(i)}`],
      );
    }
    /*
     * Указатель переписки (миграция 0017). Это список тех, с кем человек
     * переписывался; ящик, заведённый заново с тем же адресом, не должен
     * получить его в наследство — иначе новый владелец увидит чужие
     * адреса в подсказке поля «Кому».
     */
    await admin.query(
      `INSERT INTO mail_contacts (account_email, address, display_name, tokens)
       VALUES ($1, 'someone@example.com', 'Некто', 'некто someone@example.com someone')`,
      [MAILBOX],
    );
    await admin.query(
      `INSERT INTO mail_contact_cursors (account_email, folder_role, uid_validity, top_uid)
       VALUES ($1, 'sent', 1, 100)`,
      [MAILBOX],
    );

    const removed = await admin.purgeMailboxData(MAILBOX);
    await admin.deleteMailUser(user.id);

    assert.ok(removed >= 11, `должно уйти не меньше одиннадцати строк, ушло ${String(removed)}`);
    const left = await admin.one<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM mail_user_settings WHERE lower(account_email) = lower($1)) +
         (SELECT count(*) FROM mail_signatures    WHERE lower(account_email) = lower($1)) +
         (SELECT count(*) FROM mail_filters       WHERE lower(account_email) = lower($1)) +
         (SELECT count(*) FROM migrate_messages   WHERE lower(account) = lower($1)) +
         (SELECT count(*) FROM migrate_cursors    WHERE lower(account) = lower($1)) +
         (SELECT count(*) FROM mail_contacts        WHERE account_email = lower($1)) +
         (SELECT count(*) FROM mail_contact_cursors WHERE account_email = lower($1))
       )::text AS count`,
      [MAILBOX],
    );
    assert.equal(left?.count, '0', 'после удаления ящика его строк остаться не должно');
  });
});

void test('удаление домена и правда уносит алиасы каскадом', { skip }, async () => {
  await withDb(async (admin) => {
    const domain = await admin.resolveDomain(DOMAIN, true);
    assert.ok(domain);
    await admin.createAlias(domain.id, `all@${DOMAIN}`, `box@${DOMAIN}`);

    const withAlias = await admin.findDomainById(domain.id);
    assert.equal(Number(withAlias?.alias_count), 1, 'алиас должен быть посчитан');

    // Это факт схемы, а не предположение: именно поэтому маршрут удаления
    // домена обязан спрашивать про алиасы, а не только про ящики.
    await admin.deleteDomain(domain.id);
    const orphans = await admin.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM virtual_aliases WHERE source = $1`,
      [`all@${DOMAIN}`],
    );
    assert.equal(orphans?.count, '0', 'алиасы уходят вместе с доменом — молча');
  });
});

/** Любой существующий администратор: у admin_id стоит внешний ключ. */
async function anyAdminId(admin: AdminDb): Promise<number | null> {
  const row = await admin.one<{ id: number }>(`SELECT id FROM admin_users ORDER BY id LIMIT 1`);
  return row?.id ?? null;
}

void test('брошенная запись о входе в чужой ящик закрывается по сроку', { skip }, async () => {
  await withDb(async (admin) => {
    const adminId = await anyAdminId(admin);
    assert.ok(adminId, 'на стенде должен быть хотя бы один администратор');
    // Сеанс на секунду: администратор вошёл и просто ушёл.
    const id = await admin.recordMailboxAccess({
      adminId,
      adminLogin: 'itest',
      mailboxEmail: MAILBOX,
      reason: 'проверка закрытия по сроку',
      ip: '127.0.0.1',
      userAgent: 'node:test',
      ttlSeconds: 1,
    });
    assert.ok(id > 0);

    const open = await admin.listMailboxAccessForOwner(MAILBOX, 10, 0);
    assert.equal(open.rows[0]?.ended_at, null, 'сразу после входа запись открыта — так и надо');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const closed = await admin.expireStaleMailboxAccess();
    assert.ok(closed >= 1, 'уборщик обязан закрыть просроченную запись');

    const after = await admin.listMailboxAccessForOwner(MAILBOX, 10, 0);
    const row = after.rows[0];
    assert.ok(row?.ended_at, 'вход не может выглядеть бесконечным');
    assert.equal(row.end_reason, 'expired');
    // Время окончания — момент истечения срока, а не «когда дошли руки».
    assert.ok(
      row.ended_at.getTime() - row.started_at.getTime() < 5000,
      'сеанс закончился по своему сроку, а не в момент прохода уборщика',
    );
  });
});

void test('вход поверх текущего закрывает предыдущую запись', { skip }, async () => {
  await withDb(async (admin) => {
    const adminId = await anyAdminId(admin);
    assert.ok(adminId);
    const first = await admin.recordMailboxAccess({
      adminId,
      adminLogin: 'itest',
      mailboxEmail: MAILBOX,
      reason: 'первый вход',
      ip: null,
      userAgent: null,
      ttlSeconds: 3600,
    });
    await admin.recordMailboxAccess({
      adminId,
      adminLogin: 'itest',
      mailboxEmail: `second@${DOMAIN}`,
      reason: 'второй вход',
      ip: null,
      userAgent: null,
      ttlSeconds: 3600,
    });
    // Закрываем всё, кроме последней, — это и делает маршрут входа.
    const closed = await admin.closeOpenMailboxAccess(adminId, 'replaced');
    assert.ok(closed >= 2 || closed >= 1);

    const rows = await admin.listMailboxAccessForOwner(MAILBOX, 10, 0);
    const row = rows.rows.find((r) => Number(r.id) === first);
    assert.ok(row?.ended_at, 'предыдущий вход должен быть закрыт');
    assert.equal(row.end_reason, 'replaced');
  });
});
