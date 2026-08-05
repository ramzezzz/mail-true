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
          process.stderr.write(`Неизвестная роль «${role}». Допустимо: ${ADMIN_ROLES.join(', ')}\n`);
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
