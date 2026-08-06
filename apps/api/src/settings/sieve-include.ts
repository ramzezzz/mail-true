/**
 * Запись ВСПОМОГАТЕЛЬНЫХ файлов Sieve в почтовое хранилище Dovecot.
 *
 * Личный файл правил кладёт settings/store.ts, и трогать его здесь нечем:
 * у него свой порядок (собрать во временном имени, скомпилировать, только
 * потом сделать действующим) и своя цена ошибки — битый действующий скрипт
 * молча ломает ВСЮ почту ящика. Здесь задача другая и куда более мелкая:
 * положить рядом файл, который личный скрипт ПОДКЛЮЧАЕТ строкой
 *
 *     include :optional :personal "mt-muted";
 *
 * Dovecot ищет такие файлы в личном хранилище скриптов ящика
 * (`sieve = file:/var/mail/vhosts/%d/%n/sieve` в dovecot.conf.template),
 * то есть ровно в том каталоге, куда store.ts кладёт исходник личного
 * скрипта. Имя файла — `<имя>.sieve`.
 *
 * ==================================================================
 * ЗАЧЕМ УДАЛЯЕТСЯ СОБРАННЫЙ ЛИЧНЫЙ СКРИПТ
 * ==================================================================
 * Личный скрипт компилируется ЗАРАНЕЕ (`sievec`) и кладётся в ящик уже
 * собранным — `.dovecot.svbin`. При этом отдельно запущенный `sievec`
 * включаемые файлы `:personal` НЕ разрешает вовсе: он молча пропускает их
 * как отсутствующие, даже когда файл лежит в том же каталоге. Проверено на
 * стенде — заведомо битый включаемый файл рядом со скриптом не мешает
 * `sievec` отчитаться об успехе. То есть в собранном нами двоичном файле
 * заглушённых цепочек нет и быть не может.
 *
 * Спасает то, что Pigeonhole запоминает зависимости скрипта и при доставке
 * пересобирает его сам, если включаемый файл появился или изменился, — это
 * тоже проверено на стенде (письмо легло в «Заглушённые» при заведомо
 * устаревшем `.dovecot.svbin`, и сам файл после доставки вырос с 493 до
 * 645 байт). Но поведение это не наше, оно зависит от версии Pigeonhole,
 * а цена ошибки — молча не работающая заглушка. Поэтому собранный файл
 * убирается явно: тогда Dovecot обязан собрать скрипт заново, потому что
 * собранного просто нет. Стоит это одной компиляции на ящик, а исходник
 * (`.dovecot.sieve`) остаётся на месте — никакой подмены действующего
 * скрипта здесь не происходит.
 *
 * ==================================================================
 * ПОЧЕМУ ФАЙЛ ВСЁ РАВНО ПРОВЕРЯЕТСЯ КОМПИЛЯТОРОМ
 * ==================================================================
 * Включаемый файл самодостаточен (свой `require`, свои команды), поэтому
 * `sievec` его проверяет полностью. И проверять обязательно: ошибка в нём
 * при доставке уронит компиляцию ВКЛЮЧАЮЩЕГО скрипта, а Pigeonhole,
 * не собрав скрипт, отказывается от него целиком — со всеми правилами,
 * автоответчиком и раскладкой спама разом. Не собралось — файл не кладём,
 * заглушка не работает, но почта работает как прежде.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { SieveTransport } from './store.js';
import { splitMailboxPath } from './store.js';

export interface SieveIncludeStoreOptions {
  transport: SieveTransport;
  /** Корень почтового хранилища: /var/mail/vhosts */
  root: string;
  /** Имя контейнера Dovecot (транспорт docker). */
  container: string;
  /** Имя личного скрипта в каталоге sieve/ — его собранную копию убираем. */
  scriptName: string;
  /** Владелец файлов внутри хранилища. */
  owner: string;
  logger: Logger;
}

/** Чем кончилась запись вспомогательного файла. */
export interface SieveIncludeResult {
  /** Файл лежит в ящике и будет подключён при доставке. */
  written: boolean;
  /** Что помешало (пусто — всё хорошо). */
  error: string;
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
 * Имя файла безопасно: только латиница, цифры, дефис и подчёркивание.
 *
 * Имя приходит из кода, а не от человека, — но путь строится склейкой, и
 * замок здесь стоит по той же причине, по какой он стоит в splitMailboxPath:
 * один неудачный рефакторинг, и склейка уводит нас из хранилища.
 */
function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`Недопустимое имя включаемого файла Sieve: ${name}`);
  }
  return name;
}

/**
 * Скрипт оболочки для транспорта docker: пишет файл и убирает собранный
 * личный скрипт. Все переменные — аргументами, содержимое — через stdin.
 */
const WRITE_SCRIPT = `
set -e
DIR="$1"; NAME="$2"; OWNER="$3"; MAIN="$4"
mkdir -p "$DIR/sieve"
TMP="$DIR/sieve/.mt-inc-new.sieve"
trap 'rm -f "$TMP" "$DIR/sieve/.mt-inc-new.svbin"' EXIT
cat > "$TMP"
sievec "$TMP"
rm -f "$DIR/sieve/.mt-inc-new.svbin"
mv "$TMP" "$DIR/sieve/$NAME.sieve"
rm -f "$DIR/sieve/$NAME.svbin"
rm -f "$DIR/.dovecot.svbin" "$DIR/sieve/$MAIN.svbin"
chown "$OWNER" "$DIR/sieve/$NAME.sieve" 2>/dev/null || true
echo "WROTE $DIR/sieve/$NAME.sieve"
`;

const REMOVE_SCRIPT = `
set -e
DIR="$1"; NAME="$2"; MAIN="$3"
rm -f "$DIR/sieve/$NAME.sieve" "$DIR/sieve/$NAME.svbin"
rm -f "$DIR/.dovecot.svbin" "$DIR/sieve/$MAIN.svbin"
echo "REMOVED $DIR/sieve/$NAME.sieve"
`;

const READ_SCRIPT = `
if [ -f "$1/sieve/$2.sieve" ]; then cat "$1/sieve/$2.sieve"; fi
`;

/**
 * Хранилище вспомогательных файлов Sieve.
 *
 * Транспорт `off` — не авария, а честный режим окружения без доступа к
 * почтовому хранилищу: список заглушённых цепочек остаётся в базе, подборка
 * «Заглушённые» работает, а вот доставка о заглушке не знает. Именно это и
 * сообщается наружу причиной, а не молчанием.
 */
export class SieveIncludeStore {
  readonly #opts: SieveIncludeStoreOptions;

  constructor(opts: SieveIncludeStoreOptions) {
    this.#opts = opts;
  }

  get enabled(): boolean {
    return this.#opts.transport !== 'off';
  }

  get transport(): SieveTransport {
    return this.#opts.transport;
  }

  /** Каталог ящика в хранилище. */
  mailboxDir(email: string): string {
    const { domain, user } = splitMailboxPath(email);
    return `${this.#opts.root}/${domain}/${user}`;
  }

  /** Путь включаемого файла — его показывает раздел состояния. */
  path(email: string, name: string): string {
    return `${this.mailboxDir(email)}/sieve/${safeName(name)}.sieve`;
  }

  /** Лежит ли файл в ящике. Транспорт off — считаем, что нет. */
  async has(email: string, name: string): Promise<boolean> {
    if (!this.enabled) return false;
    const dir = this.mailboxDir(email);
    const file = `${dir}/sieve/${safeName(name)}.sieve`;
    if (this.#opts.transport === 'docker') {
      const res = await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        'test -f "$1"',
        'sh',
        file,
      ]).catch((): RunResult => ({ code: -1, stdout: '', stderr: '' }));
      return res.code === 0;
    }
    return access(file)
      .then(() => true)
      .catch(() => false);
  }

  /** Читает файл — для показа «что лежит в ящике» и для проверок. */
  async read(email: string, name: string): Promise<string | null> {
    if (!this.enabled) return null;
    const dir = this.mailboxDir(email);
    if (this.#opts.transport === 'docker') {
      const res = await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        READ_SCRIPT,
        'sh',
        dir,
        safeName(name),
      ]).catch((): RunResult => ({ code: -1, stdout: '', stderr: '' }));
      if (res.code !== 0 || res.stdout === '') return null;
      return res.stdout;
    }
    return readFile(`${dir}/sieve/${safeName(name)}.sieve`, 'utf8').catch(() => null);
  }

  /**
   * Кладёт (или переписывает) вспомогательный файл.
   *
   * Пустой текст — это команда УБРАТЬ файл, а не записать пустоту: правило
   * без единого значения Pigeonhole не примет, а пустой файл стоил бы
   * лишнего разрешения имени на каждом письме.
   */
  async write(email: string, name: string, text: string): Promise<SieveIncludeResult> {
    if (text.trim() === '') {
      await this.remove(email, name);
      return { written: false, error: '' };
    }
    if (!this.enabled) {
      return {
        written: false,
        error:
          'Транспорт Sieve выключен (SIEVE_TRANSPORT=off): заглушённые цепочки ' +
          'не попадут в правила доставки',
      };
    }
    const dir = this.mailboxDir(email);
    const file = safeName(name);

    if (this.#opts.transport === 'docker') {
      const res = await run(
        'docker',
        [
          'exec',
          '-i',
          this.#opts.container,
          'sh',
          '-c',
          WRITE_SCRIPT,
          'sh',
          dir,
          file,
          this.#opts.owner,
          this.#opts.scriptName,
        ],
        text,
      ).catch((err: unknown): RunResult => ({
        code: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }));
      if (res.code !== 0) {
        return { written: false, error: res.stderr.trim() || res.stdout.trim() || 'Ошибка записи' };
      }
      return { written: true, error: '' };
    }

    const sieveDir = join(dir, 'sieve');
    await mkdir(sieveDir, { recursive: true });
    const tmp = join(sieveDir, '.mt-inc-new.sieve');
    const tmpBin = join(sieveDir, '.mt-inc-new.svbin');
    await writeFile(tmp, text, 'utf8');
    const res = await run('sievec', [tmp]).catch((err: unknown): RunResult => ({
      code: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }));
    // code === -1 — самого sievec рядом нет. Это не ошибка файла, и терять
    // из-за неё заглушку нельзя: собирать всё равно будет Dovecot.
    const compilerMissing = res.code === -1;
    if (res.code !== 0 && !compilerMissing) {
      await rm(tmp, { force: true });
      await rm(tmpBin, { force: true });
      const message = res.stderr.trim() || res.stdout.trim();
      this.#opts.logger.error(
        { email, file, compiler: message },
        'Включаемый файл Sieve не собрался — в ящик не кладём',
      );
      return { written: false, error: message || 'Файл не скомпилирован' };
    }

    const target = join(sieveDir, `${file}.sieve`);
    await writeFile(target, text, 'utf8');
    await rm(tmp, { force: true });
    await rm(tmpBin, { force: true });
    // Собранную копию самого включаемого файла не кладём: её соберёт
    // Dovecot вместе с включающим скриптом.
    await rm(join(sieveDir, `${file}.svbin`), { force: true });
    await this.#dropCompiledMain(dir);
    return { written: true, error: compilerMissing ? '' : res.stderr.trim() };
  }

  /** Убирает файл. Отсутствующий файл — не ошибка. */
  async remove(email: string, name: string): Promise<void> {
    if (!this.enabled) return;
    const dir = this.mailboxDir(email);
    const file = safeName(name);
    if (this.#opts.transport === 'docker') {
      await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        REMOVE_SCRIPT,
        'sh',
        dir,
        file,
        this.#opts.scriptName,
      ]).catch(() => undefined);
      return;
    }
    const sieveDir = join(dir, 'sieve');
    await rm(join(sieveDir, `${file}.sieve`), { force: true }).catch(() => undefined);
    await rm(join(sieveDir, `${file}.svbin`), { force: true }).catch(() => undefined);
    await this.#dropCompiledMain(dir);
  }

  /**
   * Убирает собранный личный скрипт — см. пояснение в шапке файла.
   *
   * Наружу, потому что порядок здесь имеет значение: личный скрипт
   * пересобирается ПОСЛЕ включаемого файла (в нём стоит строка include),
   * и его компиляция кладёт в ящик свежий `.dovecot.svbin` — снова без
   * включения. Значит, убрать собранный файл нужно последним действием,
   * а не первым.
   */
  async invalidateCompiled(email: string): Promise<void> {
    if (!this.enabled) return;
    const dir = this.mailboxDir(email);
    if (this.#opts.transport === 'docker') {
      await run('docker', [
        'exec',
        this.#opts.container,
        'sh',
        '-c',
        'rm -f "$1/.dovecot.svbin" "$1/sieve/$2.svbin"',
        'sh',
        dir,
        this.#opts.scriptName,
      ]).catch(() => undefined);
      return;
    }
    await this.#dropCompiledMain(dir);
  }

  async #dropCompiledMain(dir: string): Promise<void> {
    await rm(`${dir}/.dovecot.svbin`, { force: true }).catch(() => undefined);
    await rm(join(dir, 'sieve', `${this.#opts.scriptName}.svbin`), { force: true }).catch(
      () => undefined,
    );
  }
}
