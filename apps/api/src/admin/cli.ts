#!/usr/bin/env node
/**
 * Небольшая консольная утилита админки: завести первого администратора
 * (через интерфейс это невозможно — входить ещё некому) и посмотреть список.
 *
 *   node dist/admin/cli.js create-admin <логин> <пароль> [owner|user_manager|readonly]
 *   node dist/admin/cli.js list-admins
 *   node dist/admin/cli.js set-password <логин> <пароль>
 *   node dist/admin/cli.js check           — применена ли миграция 0003
 */
import 'dotenv/config';
import { pino } from 'pino';
import { loadAdminConfig } from './config.js';
import { AdminDb, isUniqueViolation } from './db.js';
import { hashAdminPassword } from './passwords.js';
import { ADMIN_ROLES, isAdminRole } from './permissions.js';

function usage(): never {
  process.stdout.write(
    [
      'Утилита админки Mail.True',
      '',
      '  create-admin <логин> <пароль> [роль]   создать администратора',
      '  set-password <логин> <пароль>          сменить пароль',
      '  list-admins                            список администраторов',
      '  check                                  проверить схему базы',
      '  domain-change-last                     сведения о последней смене домена',
      '  domain-change-key <id>                 приватный ключ DKIM этой смены',
      '',
      `Роли: ${ADMIN_ROLES.join(' | ')} (по умолчанию owner)`,
      '',
      'Подключение к базе берётся из ADMIN_DATABASE_URL или DATABASE_URL.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const config = loadAdminConfig();
  if (!config.databaseUrl) {
    process.stderr.write('Не задан ADMIN_DATABASE_URL/DATABASE_URL\n');
    process.exit(2);
  }
  const logger = pino({ level: 'warn' });
  const db = new AdminDb({ connectionString: config.databaseUrl, logger });

  try {
    switch (command) {
      case 'check': {
        const ready = await db.adminSchemaReady();
        process.stdout.write(
          ready
            ? 'Схема админки на месте (таблица admin_users существует)\n'
            : 'Схема админки НЕ применена: выполните infra/postgres/migrations/0003_admin.sql\n',
        );
        process.exit(ready ? 0 : 3);
        break;
      }
      case 'create-admin': {
        const [login, password, roleArg] = args;
        if (!login || !password) usage();
        if (password.length < 10) {
          process.stderr.write('Пароль администратора короче 10 символов — так нельзя\n');
          process.exit(2);
        }
        const role = roleArg ?? 'owner';
        if (!isAdminRole(role)) {
          process.stderr.write(
            `Неизвестная роль «${role}». Допустимо: ${ADMIN_ROLES.join(', ')}\n`,
          );
          process.exit(2);
        }
        try {
          const created = await db.createAdmin(login, hashAdminPassword(password), role, null);
          process.stdout.write(`Администратор ${created.login} создан, роль ${created.role}\n`);
        } catch (err) {
          if (isUniqueViolation(err)) {
            process.stderr.write(`Администратор «${login}» уже существует\n`);
            process.exit(4);
          }
          throw err;
        }
        break;
      }
      case 'set-password': {
        const [login, password] = args;
        if (!login || !password) usage();
        const row = await db.findAdminByLogin(login);
        if (!row) {
          process.stderr.write(`Нет администратора «${login}»\n`);
          process.exit(4);
        }
        await db.query(
          `UPDATE admin_users SET password_hash = $2, failed_attempts = 0,
                  locked_until = NULL, updated_at = now() WHERE id = $1`,
          [row.id, hashAdminPassword(password)],
        );
        process.stdout.write(`Пароль администратора ${login} обновлён\n`);
        break;
      }
      case 'list-admins': {
        const rows = await db.listAdmins();
        if (rows.length === 0) {
          process.stdout.write('Администраторов нет\n');
          break;
        }
        for (const r of rows) {
          process.stdout.write(
            `${r.login}\t${r.role}\t${r.active ? 'активен' : 'отключён'}\t` +
              `вход: ${r.last_login_at?.toISOString() ?? 'никогда'}\n`,
          );
        }
        break;
      }
      /*
       * Смена домена: что именно поменялось и каким ключом подписывать.
       *
       * Читает это скрипт infra/scripts/change-domain.sh — та часть
       * работы, до которой панель дотянуться не может (тома чужих
       * контейнеров, сертификаты, infra/.env). Через HTTP приватный ключ
       * не отдаётся ни одним маршрутом: он выходит наружу ровно здесь,
       * внутри контейнера, по команде человека с доступом к серверу.
       */
      case 'domain-change-last': {
        const row = await db.one<{
          id: string;
          old_domain: string;
          new_domain: string;
          old_hostname: string;
          new_hostname: string;
          dkim_selector: string;
          state: string;
          has_key: boolean;
          finished_at: Date | null;
        }>(
          `SELECT id::text AS id, old_domain, new_domain, old_hostname, new_hostname,
                  dkim_selector, state, dkim_private_enc IS NOT NULL AS has_key, finished_at
             FROM domain_change_jobs
            WHERE state = 'done'
            ORDER BY id DESC LIMIT 1`,
        );
        if (!row) {
          process.stderr.write('Выполненных смен домена нет\n');
          process.exit(4);
        }
        // Формат «ключ=значение» — чтобы скрипт мог просто выполнить eval.
        process.stdout.write(
          [
            `DC_ID=${row.id}`,
            `DC_OLD_DOMAIN=${row.old_domain}`,
            `DC_NEW_DOMAIN=${row.new_domain}`,
            `DC_OLD_HOSTNAME=${row.old_hostname}`,
            `DC_NEW_HOSTNAME=${row.new_hostname}`,
            `DC_DKIM_SELECTOR=${row.dkim_selector}`,
            `DC_HAS_KEY=${row.has_key ? '1' : '0'}`,
            `DC_FINISHED_AT=${row.finished_at?.toISOString() ?? ''}`,
            '',
          ].join('\n'),
        );
        break;
      }
      case 'domain-change-key': {
        const [idArg] = args;
        if (!idArg) usage();
        if (config.importSecret === '') {
          process.stderr.write(
            'Не задан ADMIN_SESSION_SECRET/SESSION_SECRET — расшифровать ключ нечем\n',
          );
          process.exit(2);
        }
        const row = await db.one<{ dkim_private_enc: string | null }>(
          `SELECT dkim_private_enc FROM domain_change_jobs WHERE id = $1`,
          [Number(idArg)],
        );
        if (!row?.dkim_private_enc) {
          process.stderr.write(`У задания ${idArg} сохранённого ключа DKIM нет\n`);
          process.exit(4);
        }
        const { SecretBox } = await import('../crypto.js');
        process.stdout.write(new SecretBox(config.importSecret).decrypt(row.dkim_private_enc));
        break;
      }
      default:
        usage();
    }
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`Ошибка: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
