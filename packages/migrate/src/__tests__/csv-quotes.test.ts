/**
 * Тесты разбора повреждённого CSV и передачи пароля.
 *
 * Разбираются два дефекта:
 *   - непарная кавычка в выгрузке Kerio молча съедала остаток файла:
 *     разбор возвращал одного пользователя, весь хвост попадал в его имя,
 *     ящики для всех последующих не создавались;
 *   - пароли принимались только аргументом командной строки, который виден
 *     любому пользователю системы через `ps` и `/proc`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvWithHeader, CsvParseError } from '../csv.js';
import { parseKerioUsersCsv } from '../kerio-users.js';
import { parseAccountsList } from '../batch.js';
import { resolvePassword, writeSecretFile, PasswordError } from '../secrets.js';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Выгрузка Kerio на трёх пользователей, у первого незакрытая кавычка. */
const BROKEN = [
  'Name;Password;FullName;Description;MailAddress;Groups',
  'abird;VbD66op1;"Alexandra Bird;Development;abird;read',
  'bsmith;Qw3rty12;Bob Smith;Sales;bsmith;all',
  'cjones;Zx9cvb34;Carol Jones;Support;cjones;all',
].join('\n');

describe('parseCsv: незакрытая кавычка', () => {
  it('бросает ошибку с номером строки вместо молчаливой потери хвоста', () => {
    let caught: unknown;
    try {
      parseCsv(BROKEN);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CsvParseError, 'ожидалась CsvParseError');
    assert.equal(caught.line, 2);
    assert.match(caught.message, /незакрыт/i);
  });

  it('без исправления хвост файла оказался бы в одном поле', () => {
    // Так вело себя разбор до исправления — оставлено доступным явным флагом
    const rows = parseCsv(BROKEN, { onUnterminatedQuote: 'lenient' });
    assert.equal(rows.length, 2); // заголовок + один «пользователь»
    const swallowed = rows[1]?.[2] ?? '';
    assert.match(swallowed, /bsmith/); // второй пользователь внутри имени первого
    assert.match(swallowed, /cjones/);
  });

  it('корректные кавычки по-прежнему разбираются', () => {
    const rows = parseCsvWithHeader('Name,Groups\nabird,"read,all"\n');
    assert.deepEqual(rows, [{ name: 'abird', groups: 'read,all' }]);
  });

  it('разбор пользователей Kerio падает с внятной ошибкой, а не молча', () => {
    assert.throws(() => parseKerioUsersCsv(BROKEN), CsvParseError);
  });

  it('список ящиков для пакетного переноса тоже не разбирается частично', () => {
    const broken =
      'source_host,source_user,source_pass,dest_user,dest_pass\n' +
      'k.local,ivanov,"p1,ivanov@mail.local,n1\n' +
      'k.local,petrov,p2,petrov@mail.local,n2\n';
    assert.throws(() => parseAccountsList(broken, { host: '127.0.0.1' }), CsvParseError);
  });
});

describe('resolvePassword', () => {
  const readerFor = (content: string) => async (): Promise<string> => content;

  it('читает первую строку файла (перевод строки в пароль не попадает)', async () => {
    const value = await resolvePassword({
      file: '/root/kerio.pass',
      defaultEnvName: 'MIGRATE_SOURCE_PASS',
      readFileImpl: readerFor('s3cret\n'),
      env: {},
    });
    assert.equal(value, 's3cret');
  });

  it('берёт пароль из переменной окружения по умолчанию', async () => {
    const value = await resolvePassword({
      defaultEnvName: 'MIGRATE_DEST_PASS',
      env: { MIGRATE_DEST_PASS: 'from-env' },
    });
    assert.equal(value, 'from-env');
  });

  it('берёт пароль из указанной переменной окружения', async () => {
    const value = await resolvePassword({
      envName: 'KERIO_PASS',
      defaultEnvName: 'MIGRATE_SOURCE_PASS',
      env: { KERIO_PASS: 'named' },
    });
    assert.equal(value, 'named');
  });

  it('файл важнее переменной, переменная важнее аргумента', async () => {
    const value = await resolvePassword({
      file: '/root/p',
      defaultEnvName: 'MIGRATE_SOURCE_PASS',
      inline: 'from-argv',
      env: { MIGRATE_SOURCE_PASS: 'from-env' },
      readFileImpl: readerFor('from-file'),
    });
    assert.equal(value, 'from-file');
  });

  it('аргумент командной строки работает, но с предупреждением', async () => {
    const warnings: string[] = [];
    const value = await resolvePassword({
      defaultEnvName: 'MIGRATE_SOURCE_PASS',
      inline: 'from-argv',
      env: {},
      warn: (m) => warnings.push(m),
    });
    assert.equal(value, 'from-argv');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /списке процессов/);
  });

  it('пустой файл и отсутствующий пароль — понятные ошибки', async () => {
    await assert.rejects(
      () =>
        resolvePassword({
          file: '/root/p',
          defaultEnvName: 'MIGRATE_SOURCE_PASS',
          env: {},
          readFileImpl: readerFor(''),
        }),
      PasswordError,
    );
    await assert.rejects(
      () => resolvePassword({ defaultEnvName: 'MIGRATE_SOURCE_PASS', env: {} }),
      PasswordError,
    );
  });
});

describe('writeSecretFile', () => {
  // Права на файл существуют не везде: на Windows chmod меняет лишь флаг
  // «только для чтения», поэтому проверка прав имеет смысл только на POSIX.
  const posix = process.platform !== 'win32';

  it('файл с паролями не читается посторонними (600)', { skip: !posix }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-secret-'));
    try {
      const path = join(dir, 'users.json');
      // Файл уже существует и открыт всем — так бывает при повторном запуске
      await writeFile(path, 'старое', { mode: 0o644 });
      await writeSecretFile(path, '{"password":"VbD66op1"}');
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode.toString(8), '600');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('содержимое записывается целиком', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-secret-'));
    try {
      const path = join(dir, 'users.json');
      await writeSecretFile(path, 'секрет');
      assert.equal(await readFileText(path), 'секрет');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}
