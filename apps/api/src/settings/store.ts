/**
 * Запись личного файла правил Sieve в почтовое хранилище Dovecot.
 *
 * Dovecot настроен так (infra/dovecot/conf/dovecot.conf.template):
 *
 *   sieve = file:/var/mail/vhosts/%d/%n/sieve;active=/var/mail/vhosts/%d/%n/.dovecot.sieve
 *
 * то есть каталог со скриптами — `<домен>/<ящик>/sieve/`, а действующий
 * скрипт — файл `.dovecot.sieve` в корне ящика. Пишем оба: в каталоге
 * лежит исходник под именем скрипта (его увидит ManageSieve, если его
 * когда-нибудь включат), а `.dovecot.sieve` — то, что реально исполняется.
 *
 * Три особенности, найденные на живом стеке, из-за которых код именно такой:
 *
 * 1. Действующий скрипт нельзя делать СИМВОЛЬНОЙ ССЫЛКОЙ. Формат ящика —
 *    maildir, и всё, что начинается с точки в корне ящика, Dovecot
 *    просматривает как папку. Ссылка `.dovecot.sieve` появляется в списке
 *    папок как «dovecot/sieve» и ломает создание новых папок
 *    (`stat(.../.dovecot.sieve/tmp) failed: Not a directory`). Обычный
 *    файл с тем же именем в список папок не попадает. Поэтому — копия.
 *
 * 2. Скрипт компилируется заранее (`sievec`) и — что важнее — компилируется
 *    ДО того, как станет действующим. Иначе Dovecot компилирует его при
 *    первой доставке, и синтаксическая ошибка обнаружится не при сохранении
 *    правил, а поведением почты. Причём поведением молчаливым: от
 *    несобравшегося скрипта Pigeonhole отказывается ЦЕЛИКОМ, а глобальную
 *    раскладку спама к ящику с личным скриптом Dovecot не применяет
 *    (sieve_default). Итог — спам во «Входящих», мёртвый автоответчик и
 *    неработающие правила разом, а единственный след — .dovecot.sieve.log
 *    внутри ящика. Поэтому новый файл собирается во временном имени, и
 *    действующий подменяется только после успешной компиляции: при ошибке
 *    в ящике остаётся прежний РАБОЧИЙ скрипт, а не битый новый.
 *
 * 3. Файлы должны принадлежать vmail: доставку выполняет процесс LMTP
 *    от имени этого пользователя.
 *
 * Транспорт до хранилища выбирается настройкой, потому что API может
 * работать и рядом с Dovecot (боевой Ubuntu — общий каталог), и снаружи
 * контейнера (dev-стек в docker).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { BadRequestError } from '../errors.js';

export type SieveTransport = 'docker' | 'local' | 'off';

export interface SieveStoreOptions {
  transport: SieveTransport;
  /** Корень почтового хранилища: /var/mail/vhosts */
  root: string;
  /** Имя контейнера Dovecot (транспорт docker). */
  container: string;
  /** Имя файла скрипта в каталоге sieve/ (без расширения). */
  scriptName: string;
  /** Владелец файлов внутри хранилища. */
  owner: string;
  logger: Logger;
}

/** Результат сохранения скрипта. */
export interface SieveWriteResult {
  /** Путь действующего скрипта в хранилище. */
  activePath: string;
  /** Скрипт скомпилирован без ошибок. */
  compiled: boolean;
  /** Сообщение компилятора, если он ругался. */
  compilerOutput: string;
}

export class SieveStoreError extends Error {}

/** Разбирает адрес на домен и локальную часть (как %d и %n у Dovecot). */
export function splitMailboxPath(email: string): { domain: string; user: string } {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    throw new BadRequestError(`Некорректный адрес ящика: ${email}`);
  }
  const user = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  // Ни одна часть пути не должна уводить нас из хранилища.
  if (/[/\\]|\.\./.test(user) || /[/\\]|\.\./.test(domain)) {
    throw new BadRequestError(`Некорректный адрес ящика: ${email}`);
  }
  return { domain, user };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Запускает процесс, отдав ему на вход строку. Без оболочки — без инъекций. */
function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

/**
 * Скрипт оболочки, выполняемый внутри контейнера Dovecot.
 * Все переменные приходят аргументами ($1…$4), а содержимое скрипта —
 * через stdin: подстановки в текст команды нет ни одной.
 */
const WRITE_SCRIPT = `
set -e
DIR="$1"; NAME="$2"; OWNER="$3"
mkdir -p "$DIR/sieve"
TMP="$DIR/sieve/.mt-new"
trap 'rm -f "$TMP.sieve" "$TMP.svbin"' EXIT
cat > "$TMP.sieve"
sievec "$TMP.sieve"
mv "$TMP.sieve" "$DIR/sieve/$NAME.sieve"
mv "$TMP.svbin" "$DIR/sieve/$NAME.svbin"
cp "$DIR/sieve/$NAME.sieve" "$DIR/.dovecot.sieve"
cp "$DIR/sieve/$NAME.svbin" "$DIR/.dovecot.svbin"
chown -R "$OWNER" "$DIR/sieve" "$DIR/.dovecot.sieve" "$DIR/.dovecot.svbin" 2>/dev/null || true
echo "WROTE $DIR/.dovecot.sieve"
`;

const REMOVE_SCRIPT = `
set -e
DIR="$1"; NAME="$2"
rm -f "$DIR/.dovecot.sieve" "$DIR/.dovecot.svbin" "$DIR/.dovecot.sieve.log"
rm -f "$DIR/sieve/$NAME.sieve" "$DIR/sieve/$NAME.svbin"
echo "REMOVED $DIR/.dovecot.sieve"
`;

const READ_SCRIPT = `
if [ -f "$1/.dovecot.sieve" ]; then cat "$1/.dovecot.sieve"; fi
`;

/**
 * Хранилище личных файлов правил.
 *
 * Транспорт `off` — не авария: настройки и правила продолжают работать
 * (они лежат в базе), просто в Dovecot ничего не кладётся. Это честный
 * режим для окружения без доступа к почтовому хранилищу, и он виден
 * в ответе маршрута, а не молчит.
 */
export class SieveStore {
  readonly #opts: SieveStoreOptions;

  constructor(opts: SieveStoreOptions) {
    this.#opts = opts;
  }

  get transport(): SieveTransport {
    return this.#opts.transport;
  }

  get enabled(): boolean {
    return this.#opts.transport !== 'off';
  }

  /** Каталог ящика в хранилище. */
  mailboxDir(email: string): string {
    const { domain, user } = splitMailboxPath(email);
    return `${this.#opts.root}/${domain}/${user}`;
  }

  /** Путь действующего скрипта — его показывает интерфейс настроек. */
  activePath(email: string): string {
    return `${this.mailboxDir(email)}/.dovecot.sieve`;
  }

  /** Сохраняет и компилирует личный файл правил. */
  async write(email: string, script: string): Promise<SieveWriteResult> {
    const dir = this.mailboxDir(email);
    const activePath = `${dir}/.dovecot.sieve`;
    if (!this.enabled) {
      return { activePath, compiled: false, compilerOutput: 'Транспорт Sieve выключен' };
    }
    if (this.#opts.transport === 'docker') {
      const res = await run(
        'docker',
        ['exec', '-i', this.#opts.container, 'sh', '-c', WRITE_SCRIPT, 'sh', dir, this.#opts.scriptName, this.#opts.owner],
        script,
      );
      if (res.code !== 0) {
        throw new SieveStoreError(
          `Не удалось сохранить правила Sieve: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
      return { activePath, compiled: true, compilerOutput: res.stderr.trim() };
    }
    // Локальный доступ к хранилищу: собираем во временном файле, проверяем
    // компилятором и только потом делаем действующим. Отсутствие sievec
    // не повод терять правила — Dovecot скомпилирует скрипт сам при первой
    // доставке; а вот ОШИБКА компиляции — повод не подменять рабочий файл
    // битым (см. пояснение 2 в шапке).
    const sieveDir = join(dir, 'sieve');
    await mkdir(sieveDir, { recursive: true });
    const tmpSieve = join(sieveDir, '.mt-new.sieve');
    const tmpBin = join(sieveDir, '.mt-new.svbin');
    await writeFile(tmpSieve, script, 'utf8');
    const res = await run('sievec', [tmpSieve]).catch(
      (err: unknown): RunResult => ({
        code: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }),
    );
    // code === -1 — самого sievec нет (spawn не нашёл файл). Это не ошибка
    // скрипта, и правила из-за этого терять нельзя.
    const compilerMissing = res.code === -1;
    if (res.code !== 0 && !compilerMissing) {
      await rm(tmpSieve, { force: true });
      await rm(tmpBin, { force: true });
      return {
        activePath,
        compiled: false,
        compilerOutput: res.stderr.trim() || res.stdout.trim(),
      };
    }

    const scriptPath = join(sieveDir, `${this.#opts.scriptName}.sieve`);
    const binPath = join(sieveDir, `${this.#opts.scriptName}.svbin`);
    await writeFile(scriptPath, script, 'utf8');
    await writeFile(activePath, script, 'utf8');
    if (!compilerMissing) {
      // Порядок важен: собранный файл должен быть НЕ СТАРШЕ исходника,
      // иначе Dovecot решит, что исходник изменился, и соберёт заново.
      const compiled = await readFile(tmpBin).catch(() => null);
      if (compiled) {
        await writeFile(binPath, compiled);
        await writeFile(`${dir}/.dovecot.svbin`, compiled);
      }
    }
    await rm(tmpSieve, { force: true });
    await rm(tmpBin, { force: true });
    if (compilerMissing) {
      // Честный ответ вместо «spawn sievec ENOENT»: правила записаны, но
      // проверить их этим окружением нечем. Разница важна — «не проверили»
      // и «в скрипте ошибка» лечатся по-разному.
      return {
        activePath,
        compiled: false,
        compilerOutput:
          'Правила записаны, но проверить их не удалось: рядом нет компилятора Sieve (sievec). ' +
          'Скрипт соберёт сам Dovecot при первой доставке; ошибка в нём будет видна ' +
          'только в .dovecot.sieve.log внутри ящика',
      };
    }
    return { activePath, compiled: true, compilerOutput: res.stderr.trim() };
  }

  /** Читает действующий скрипт (для показа «что лежит в ящике»). */
  async read(email: string): Promise<string | null> {
    const dir = this.mailboxDir(email);
    if (!this.enabled) return null;
    if (this.#opts.transport === 'docker') {
      const res = await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        READ_SCRIPT,
        'sh',
        dir,
      ]);
      if (res.code !== 0) return null;
      return res.stdout === '' ? null : res.stdout;
    }
    try {
      return await readFile(`${dir}/.dovecot.sieve`, 'utf8');
    } catch {
      return null;
    }
  }

  /** Убирает личный файл правил (правил не осталось). */
  async remove(email: string): Promise<void> {
    if (!this.enabled) return;
    const dir = this.mailboxDir(email);
    if (this.#opts.transport === 'docker') {
      await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        REMOVE_SCRIPT,
        'sh',
        dir,
        this.#opts.scriptName,
      ]);
      return;
    }
    await rm(`${dir}/.dovecot.sieve`, { force: true });
    await rm(`${dir}/.dovecot.svbin`, { force: true });
    await rm(join(dir, 'sieve', `${this.#opts.scriptName}.sieve`), { force: true });
    await rm(join(dir, 'sieve', `${this.#opts.scriptName}.svbin`), { force: true });
    await mkdir(dirname(dir), { recursive: true }).catch(() => undefined);
  }

  /** Доступно ли хранилище прямо сейчас (для диагностики при старте). */
  async check(): Promise<{ ok: boolean; reason: string }> {
    if (!this.enabled) return { ok: false, reason: 'SIEVE_TRANSPORT=off' };
    if (this.#opts.transport === 'docker') {
      const res = await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        'test -x /usr/bin/sievec && test -d "$1"',
        'sh',
        this.#opts.root,
      ]).catch((err: unknown): RunResult => ({ code: -1, stdout: '', stderr: String(err) }));
      return res.code === 0
        ? { ok: true, reason: '' }
        : {
            ok: false,
            reason: `Контейнер ${this.#opts.container} недоступен или в нём нет sievec: ${res.stderr.trim()}`,
          };
    }
    try {
      await mkdir(this.#opts.root, { recursive: true });
      return { ok: true, reason: '' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
