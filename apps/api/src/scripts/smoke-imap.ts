/**
 * Интеграционная проверка почтового стека на уровне протоколов
 * (без HTTP API): IMAP-вход, список папок, отправка письма самому себе
 * через submission и чтение его из Входящих.
 *
 * Запуск: node dist/scripts/smoke-imap.js
 * Переменные: SMOKE_EMAIL, SMOKE_PASSWORD (по умолчанию test@mail.local / test12345)
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { loadConfig } from '../config.js';

const email = process.env['SMOKE_EMAIL'] ?? 'test@mail.local';
const password = process.env['SMOKE_PASSWORD'] ?? 'test12345';

async function main(): Promise<void> {
  const config = loadConfig();
  const marker = `smoke-${Date.now()}`;
  let failed = false;
  const step = (name: string, ok: boolean, extra = ''): void => {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  // 1. IMAP-вход
  const client = new ImapFlow({
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_SECURE,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
    logger: false,
  });
  await client.connect();
  step('IMAP-вход', true, `${email} @ ${config.IMAP_HOST}:${config.IMAP_PORT}`);

  // 2. Список папок
  const folders = await client.list();
  step('Список папок', folders.length > 0, folders.map((f) => f.path).join(', '));

  // 3. Отправка письма самому себе через submission (STARTTLS + SASL)
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: true,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED },
  });
  await transport.sendMail({
    from: email,
    to: email,
    subject: `Проверка доставки ${marker}`,
    text: `Тестовое письмо ${marker}`,
    html: `<p>Тестовое письмо <b>${marker}</b></p>`,
  });
  transport.close();
  step('Отправка через submission', true, `subject: ${marker}`);

  // 4. Ждём доставки во Входящие и читаем письмо
  let found: number | null = null;
  const lock = await client.getMailboxLock('INBOX');
  try {
    for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
      const uids = await client.search({ subject: marker }, { uid: true });
      if (Array.isArray(uids) && uids.length > 0 && uids[0] !== undefined) {
        found = uids[uids.length - 1] ?? null;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    step('Письмо дошло до Входящих', found !== null, found ? `uid=${found}` : 'не найдено за 30 с');

    if (found !== null) {
      const msg = await client.fetchOne(
        String(found),
        { uid: true, envelope: true, source: true },
        { uid: true },
      );
      // Тело может быть закодировано (base64/QP), поэтому маркер проверяем
      // по декодированной теме из ENVELOPE, а наличие исходника — отдельно
      const ok = Boolean(
        msg && msg.source && msg.source.length > 0 && msg.envelope?.subject?.includes(marker),
      );
      step(
        'Чтение письма из Входящих',
        ok,
        msg && msg.envelope ? `subject=${msg.envelope.subject ?? ''}` : '',
      );
    }
  } finally {
    lock.release();
  }

  await client.logout();
  if (failed) {
    process.exitCode = 1;
  } else {
    console.log('\nВсе проверки пройдены.');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
