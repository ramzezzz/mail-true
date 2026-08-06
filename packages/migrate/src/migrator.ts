/**
 * Перенос одного почтового ящика по схеме IMAP → IMAP.
 *
 * Алгоритм:
 *   1. Подключиться к обоим серверам, получить список папок источника
 *      и спец-папки приёмника (SPECIAL-USE), построить план сопоставления.
 *   2. Для каждой папки источника:
 *      a) создать папку-приёмник (иерархию) при необходимости;
 *      b) собрать набор дедупликации: ключи писем, уже лежащих в
 *         папке-приёмнике, плюс ключи из хранилища состояния;
 *      c) одним FETCH прочитать «лёгкие» метаданные всех писем источника
 *         (UID, размер, флаги, INTERNALDATE, нужные заголовки) — без тел;
 *      d) письма, которых нет в наборе дедупликации, скачивать по одному
 *         (в памяти держится максимум одно письмо) и класть APPEND'ом
 *         с исходными флагами и INTERNALDATE;
 *      e) после каждого письма фиксировать состояние, периодически — курсор.
 *   3. При обрыве соединения — переподключиться и продолжить с того же
 *      места (набор дедупликации уже наполнен, докачиваются только новые).
 *
 * Флаги: переносятся \Seen, \Answered, \Flagged, \Draft, \Deleted и
 * пользовательские метки (ключевые слова без «\»). Флаг \Recent не
 * переносится — им управляет сам сервер.
 */

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, ListResponse } from 'imapflow';
import {
  buildFolderMappings,
  DEFAULT_ROLE_TARGETS,
  MAILDIR_UNSAFE_CHARS,
  sanitizeDestPath,
} from './folder-map.js';
import { dedupKey, DedupLedger, parseDedupHeaders } from './dedup.js';
import { loginNameOf } from './types.js';
import type {
  FolderMapping,
  FolderReport,
  ImapEndpoint,
  MailboxReport,
  MigrateMailboxOptions,
  ProgressEvent,
  SourceFolder,
  SpecialRole,
} from './types.js';

/** Заголовки, запрашиваемые для вычисления ключа дедупликации. */
const DEDUP_HEADER_FIELDS = ['message-id', 'date', 'from', 'to', 'subject'];

/** Метаданные одного письма источника (без тела). */
interface SourceMessageMeta {
  uid: number;
  size: number;
  flags: string[];
  internalDate: Date | undefined;
  key: string;
}

/**
 * Создать подключение imapflow к серверу.
 *
 * Имя входа берётся у loginNameOf: в служебном режиме это
 * `ящик*служебный_пользователь`, и пароль в endpoint.pass — служебного
 * пользователя, а не владельца ящика.
 */
export function createClient(
  endpoint: ImapEndpoint,
  logger: MigrateMailboxOptions['logger'],
): ImapFlow {
  return new ImapFlow({
    host: endpoint.host,
    port: endpoint.port ?? (endpoint.secure ? 993 : 143),
    secure: endpoint.secure ?? false,
    auth: { user: loginNameOf(endpoint), pass: endpoint.pass },
    logger: logger ?? false,
    // Переносим большие ящики: не даём серверу закрыть сессию на долгих FETCH
    socketTimeout: 10 * 60 * 1000,
    ...(endpoint.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
  });
}

/**
 * Подключиться и, если не вышло, сказать ЧТО именно не так.
 *
 * Без этого отказ на входе выглядел как «ошибка: Command failed» — ровно
 * так и получилось на стенде при неверном пароле. Перенос ящика идёт часами
 * и запускается обычно ночью; человек, увидевший утром такую строку, не
 * знает даже, к какому из двух серверов она относится, и начинает гадать:
 * сеть? порт? пароль? не тот адрес?
 *
 * Разбор ответа сервера у нас уже есть (describeImapError), но он применялся
 * только к операциям с письмами. Вход остался без него — и оказался самым
 * частым местом отказа: адрес и пароль вводят руками.
 */
export async function connectWithReason(
  client: ImapFlow,
  endpoint: ImapEndpoint,
  role: 'исходному' | 'целевому',
): Promise<void> {
  // Имя показываем ТО, под которым входили: в служебном режиме это
  // «ящик*служебный», и отказ «логин или пароль» относится к служебному
  // паролю, а не к паролю ящика. Без этого администратор шёл менять
  // не тот пароль.
  const where = `${loginNameOf(endpoint)}@${endpoint.host}:${String(
    endpoint.port ?? (endpoint.secure ? 993 : 143),
  )}`;
  try {
    await client.connect();
  } catch (err) {
    const detail = describeImapError(err);
    const code = (err as { code?: string } | null)?.code ?? '';
    let hint = '';
    if (/AUTHENTICATIONFAILED|Authentication failed|Invalid credentials/i.test(detail)) {
      // В служебном режиме отказ почти всегда означает не «не тот пароль
      // ящика», а «служебный доступ на сервере не включён или разделитель
      // другой». Не сказав этого, мы отправляем человека менять пароль
      // ящика — то есть чинить не то.
      hint = endpoint.masterUser
        ? `сервер не принял служебный вход «${loginNameOf(endpoint)}»: проверьте пароль ` +
          'служебного пользователя, разрешён ли ему вход в чужие ящики и тот ли разделитель'
        : 'сервер не принял логин или пароль';
    } else if (code === 'ENOTFOUND' || /ENOTFOUND/.test(detail)) {
      hint = 'имя сервера не разрешается — проверьте адрес';
    } else if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(detail)) {
      hint = 'сервер отказал в соединении — проверьте порт и что служба запущена';
    } else if (code === 'ETIMEDOUT' || /ETIMEDOUT|timed? out/i.test(detail)) {
      hint = 'сервер не ответил — проверьте адрес, порт и то, что путь не закрыт межсетевым экраном';
    } else if (/certificate|self.signed|DEPTH_ZERO/i.test(detail)) {
      // Подсказка не называет флаг командной строки: этот же текст
      // показывается в панели, где никаких флагов нет, и совет «добавьте
      // --source-insecure-tls» там отправлял бы искать несуществующее поле.
      hint =
        'сертификат сервера не принят — для собственного сертификата разрешите его приём ' +
        '(в панели — флажок «Принимать собственный сертификат», в командной строке — ' +
        '--source-insecure-tls или --dest-insecure-tls)';
    }
    // Подсказку не повторяем: часть кодов (AUTHENTICATIONFAILED) уже
    // объяснена разбором ответа, и дважды одна фраза в одной строке —
    // это шум, из-за которого пропускают вторую половину сообщения.
    //
    // В служебном режиме подсказка ЗАМЕЩАЕТ общую фразу «не принял логин
    // или пароль»: она точнее (речь о служебном пользователе), а рядом
    // общая фраза сбивала бы на пароль ящика.
    const generic = RESPONSE_CODE_HINTS.AUTHENTICATIONFAILED as string;
    const trimmed =
      endpoint.masterUser && hint.length > 0 && detail.includes(generic)
        ? detail.replace(`${generic}; `, '').replace(generic, '')
        : detail;
    const reason = hint && !trimmed.includes(hint) ? `${hint}; ${trimmed}` : trimmed;
    throw new Error(`Не удалось подключиться к ${role} серверу (${where}): ${reason}`);
  }
}

/** Привести ответ LIST к нашему описанию папки. */
function toSourceFolder(item: ListResponse): SourceFolder {
  const noSelect = item.flags instanceof Set && item.flags.has('\\Noselect');
  return {
    path: item.path,
    delimiter: item.delimiter || '/',
    ...(item.specialUse ? { specialUse: item.specialUse } : {}),
    noSelect,
  };
}

/** Флаги, которые можно записывать APPEND'ом (все, кроме \Recent). */
function storableFlags(flags: Set<string> | undefined): string[] {
  if (!flags) return [];
  return [...flags].filter((f) => f !== '\\Recent');
}

/** Ключ дедупликации из ответа FETCH. */
function keyOf(msg: FetchMessageObject): string {
  const headers = msg.headers ? parseDedupHeaders(msg.headers) : {};
  return dedupKey(headers, msg.size ?? 0);
}

/** Прочитать поток в Buffer. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/** Пауза. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Диагностика отказов сервера                                        */
/* ------------------------------------------------------------------ */

/** Форма ошибки, которую отдаёт imapflow при отказе команды. */
interface ImapCommandError extends Error {
  serverResponseCode?: string;
  responseStatus?: string;
  responseText?: string;
  response?: unknown;
}

/**
 * Известные коды отказа IMAP → человеческое объяснение.
 * Код квоты (RFC 9208 / RFC 2087) сервер присылает как OVERQUOTA;
 * Dovecot дополнительно пишет текстом «Quota exceeded».
 */
const RESPONSE_CODE_HINTS: Record<string, string> = {
  OVERQUOTA: 'у ящика-приёмника кончилась квота',
  ALREADYEXISTS: 'папка уже существует',
  NONEXISTENT: 'папки нет на сервере',
  TRYCREATE: 'папки-приёмника не существует',
  CANNOT: 'сервер отказался выполнять команду с такими данными',
  LIMIT: 'превышен предел сервера',
  NOPERM: 'нет прав на эту операцию',
  EXPUNGEISSUED: 'письмо удалили на сервере во время переноса',
  SERVERBUG: 'внутренняя ошибка сервера',
  UNAVAILABLE: 'сервер временно недоступен',
  AUTHENTICATIONFAILED: 'сервер не принял логин или пароль',
};

/** Текст отказа похож на нехватку места (квота), даже без кода OVERQUOTA. */
function looksLikeQuota(text: string): boolean {
  return /quota|over ?quota|not enough disk space|insufficient storage|мест[оа]/i.test(text);
}

/**
 * Понятное описание ошибки IMAP-команды.
 *
 * Без этого отказ по квоте выглядел в отчёте как «UID 5: Command failed»:
 * администратор видел загадочную ошибку и не понимал, что нужно просто
 * поднять квоту приёмника и повторить перенос.
 */
export function describeImapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as ImapCommandError;
  const code = typeof e.serverResponseCode === 'string' ? e.serverResponseCode.toUpperCase() : '';
  const serverText =
    typeof e.responseText === 'string' && e.responseText.trim().length > 0
      ? e.responseText.trim()
      : typeof e.response === 'string' && e.response.trim().length > 0
        ? e.response.trim()
        : '';

  const parts: string[] = [];
  const hint = code ? RESPONSE_CODE_HINTS[code] : undefined;
  if (hint) {
    parts.push(hint);
  } else if (looksLikeQuota(serverText)) {
    parts.push(RESPONSE_CODE_HINTS.OVERQUOTA as string);
  }
  if (code) parts.push(`код сервера ${code}`);
  if (serverText) parts.push(`ответ сервера: ${serverText}`);
  if (parts.length === 0) return e.message || String(err);
  // Сообщение самого imapflow («Command failed») без ответа сервера
  // бесполезно, поэтому добавляем его только если оно что-то говорит.
  if (e.message && e.message !== 'Command failed' && !serverText.includes(e.message)) {
    parts.push(e.message);
  }
  return parts.join('; ');
}

/** Похоже ли, что перенос упёрся в квоту приёмника. */
export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as ImapCommandError;
  if (typeof e.serverResponseCode === 'string' && e.serverResponseCode.toUpperCase() === 'OVERQUOTA') {
    return true;
  }
  return looksLikeQuota(`${e.responseText ?? ''} ${typeof e.response === 'string' ? e.response : ''} ${e.message}`);
}

/**
 * Ошибка, повторять которую бессмысленно: сервер отказал по существу,
 * а не из-за обрыва связи. Например, «в имени папки недопустим символ».
 * Раньше такие отказы честно отрабатывали все пять попыток с нарастающей
 * паузой, а потом папка молча выпадала из переноса.
 */
export class PermanentFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFolderError';
  }
}

/**
 * Перенос прерван человеком (options.signal). Не ошибка сервера:
 * повторять попытку бессмысленно, отчёт должен сказать «остановлено»,
 * а не «не удалось».
 */
export class MigrationStoppedError extends Error {
  constructor(message = 'перенос остановлен') {
    super(message);
    this.name = 'MigrationStoppedError';
  }
}

/* ------------------------------------------------------------------ */
/*  Курсор папки                                                       */
/* ------------------------------------------------------------------ */

/**
 * Курсор папки-источника: до какого UID включительно всё РАЗОБРАНО, то есть
 * либо перенесено, либо признано дублем. Повторный запуск читает источник,
 * начиная со следующего UID.
 *
 * Ключевое свойство: курсор двигается только по непрерывному префиксу
 * успешных писем. Первая же неудача его замораживает.
 *
 * Раньше курсор двигался безусловно — `highestUid = Math.max(highestUid,
 * meta.uid)` стояло ПОСЛЕ try/catch. Из-за этого сценарий «квота кончилась
 * посреди переноса» терял почту навсегда: первый проход давал
 * «скопировано 4, ошибок 6» и курсор u:10; после подъёма квоты повторный
 * запуск с тем же состоянием читал источник с UID 11, докачивал ноль и
 * рапортовал «ok, ошибок 0» — администратор переключал MX, а шесть писем
 * не переезжали уже никогда.
 */
export class CursorTracker {
  private idx = 0;
  private frozen = false;
  private value: number;
  private readonly pending: Set<number>;
  private readonly failed = new Set<number>();

  /**
   * @param uids     UID всех писем папки в порядке возрастания
   * @param pending  UID писем, которые предстоит перенести (ещё не разобраны)
   * @param startUid прежнее значение курсора — назад не отматываем
   */
  constructor(private readonly uids: readonly number[], pending: Iterable<number>, startUid = 0) {
    this.pending = new Set(pending);
    this.value = startUid;
  }

  /** Текущее значение курсора. */
  get uid(): number {
    return this.value;
  }

  /** Курсор остановлен неудавшимся письмом. */
  get isFrozen(): boolean {
    return this.frozen;
  }

  markCopied(uid: number): void {
    this.pending.delete(uid);
    this.advance();
  }

  markFailed(uid: number): void {
    this.failed.add(uid);
    this.pending.delete(uid);
    this.advance();
  }

  /** Досчитать курсор после обработки всех писем. */
  finish(): number {
    this.advance();
    return this.value;
  }

  private advance(): void {
    if (this.frozen) return;
    while (this.idx < this.uids.length) {
      const uid = this.uids[this.idx];
      if (uid === undefined) break;
      if (this.failed.has(uid)) {
        this.frozen = true;
        return;
      }
      if (this.pending.has(uid)) return; // ещё не обработано
      this.value = Math.max(this.value, uid);
      this.idx++;
    }
  }
}

/**
 * Мигратор одного ящика. Излучает события прогресса ('progress'),
 * пригоден для показа хода переноса в админке.
 */
export class MailboxMigrator extends EventEmitter {
  private readonly options: MigrateMailboxOptions;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private source: ImapFlow | null = null;
  private dest: ImapFlow | null = null;
  /** Разделитель иерархии приёмника (узнаётся при построении плана). */
  private destDelimiter: string | null = null;

  constructor(options: MigrateMailboxOptions) {
    super();
    this.options = options;
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  override on(event: 'progress', listener: (e: ProgressEvent) => void): this {
    return super.on(event, listener);
  }

  private progress(event: ProgressEvent): void {
    this.emit('progress', event);
    this.options.onProgress?.(event);
  }

  /**
   * Задание остановлено человеком.
   *
   * Именно геттер, а не чтение options.signal.aborted по месту: сигнал
   * меняется асинхронно, а компилятор, увидев одну проверку, считает
   * значение известным до конца блока и объявляет вторую проверку лишней.
   */
  private get stopRequested(): boolean {
    return this.options.signal?.aborted === true;
  }

  /**
   * Бросить, если задание остановили. Вызывается ТОЛЬКО на границах, где
   * состояние уже согласовано: между письмами и между папками. Обрывать
   * посреди APPEND нельзя — приёмник получил бы половину письма.
   */
  private checkStopped(): void {
    if (this.stopRequested) throw new MigrationStoppedError();
  }

  /** Идентификатор ящика для хранилища состояния. */
  private get accountKey(): string {
    const { source, dest } = this.options;
    return `${source.user}@${source.host} -> ${dest.user}@${dest.host}`;
  }

  private async connectSource(): Promise<ImapFlow> {
    if (this.source?.usable) return this.source;
    this.source = createClient(this.options.source, this.options.logger);
    // Ошибки соединения ловим сами при выполнении операций
    this.source.on('error', () => undefined);
    await connectWithReason(this.source, this.options.source, 'исходному');
    return this.source;
  }

  private async connectDest(): Promise<ImapFlow> {
    if (this.dest?.usable) return this.dest;
    this.dest = createClient(this.options.dest, this.options.logger);
    this.dest.on('error', () => undefined);
    await connectWithReason(this.dest, this.options.dest, 'целевому');
    return this.dest;
  }

  private async closeAll(): Promise<void> {
    for (const client of [this.source, this.dest]) {
      if (!client) continue;
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    this.source = null;
    this.dest = null;
  }

  /** Определить спец-папки приёмника по его собственному LIST SPECIAL-USE. */
  private static destRoleTargets(list: ListResponse[]): Partial<Record<SpecialRole, string>> {
    const roles: Partial<Record<SpecialRole, string>> = {};
    const byUse: Record<string, SpecialRole> = {
      '\\sent': 'sent',
      '\\drafts': 'drafts',
      '\\trash': 'trash',
      '\\junk': 'junk',
      '\\archive': 'archive',
    };
    for (const item of list) {
      const use = item.specialUse?.toLowerCase();
      if (!use) continue;
      const role = byUse[use];
      if (role && roles[role] === undefined) roles[role] = item.path;
    }
    return roles;
  }

  /** Построить план сопоставления папок (используется и в dry-run). */
  async planFolders(): Promise<FolderMapping[]> {
    const source = await this.connectSource();
    const dest = await this.connectDest();
    const sourceList = await source.list();
    const destList = await dest.list();
    const destDelimiter = destList.find((d) => d.delimiter)?.delimiter ?? '/';
    this.destDelimiter = destDelimiter;
    const folders = sourceList.map(toSourceFolder);
    const targets = MailboxMigrator.destRoleTargets(destList);
    return buildFolderMappings(
      folders,
      destDelimiter,
      targets,
      this.options.mapping ?? {},
      this.options.mapping?.destUnsafeChars ?? [],
    );
  }

  /** Выполнить перенос ящика. */
  async run(): Promise<MailboxReport> {
    const startedAt = new Date();
    const state = this.options.state;
    await state?.init();

    const report: MailboxReport = {
      sourceUser: this.options.source.user,
      destUser: this.options.dest.user,
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      durationMs: 0,
      status: 'ok',
      folders: [],
      totalMessages: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
    };

    try {
      // Задание могли остановить, пока ящик стоял в очереди. Тогда к чужому
      // серверу не идём вовсе: лишний вход в чужую почту — это след в его
      // журналах и в его системе обнаружения вторжений, взятый ни за чем.
      this.checkStopped();
      const mappings = await this.planFolders();
      this.progress({ type: 'folders', mappings });

      // Подсчёт для события start (по STATUS, дёшево)
      const source = await this.connectSource();
      let totalMessages = 0;
      for (const m of mappings) {
        try {
          const st = await source.status(m.source.path, { messages: true });
          totalMessages += st.messages ?? 0;
        } catch {
          /* папка могла исчезнуть — посчитаем при открытии */
        }
      }
      this.progress({
        type: 'start',
        account: this.accountKey,
        folders: mappings.length,
        messages: totalMessages,
      });

      let stopped = false;
      for (const mapping of mappings) {
        // Остановка между папками: то, что уже переехало, остаётся в отчёте
        // и в состоянии — продолжение начнётся ровно с этой папки.
        if (this.stopRequested) {
          stopped = true;
          break;
        }
        const folderReport = await this.migrateFolderWithRetry(mapping);
        report.folders.push(folderReport);
        report.totalMessages += folderReport.total;
        report.copied += folderReport.copied;
        report.skipped += folderReport.skipped;
        report.failed += folderReport.failed;
        if (this.stopRequested) stopped = true;
      }

      if (stopped) {
        report.status = 'stopped';
        report.error = 'перенос остановлен: продолжить можно тем же заданием, ' +
          'уже перенесённые письма повторно не поедут';
      } else if (report.failed > 0 || report.folders.some((f) => f.errors.length > 0)) {
        report.status = 'partial';
      }
    } catch (err) {
      // Остановка — не отказ: отчёт должен показать сделанное, а не ошибку.
      if (err instanceof MigrationStoppedError) {
        report.status = 'stopped';
        report.error =
          'перенос остановлен: продолжить можно тем же заданием, ' +
          'уже перенесённые письма повторно не поедут';
      } else {
        report.status = 'failed';
        report.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      await this.closeAll();
      const finishedAt = new Date();
      report.finishedAt = finishedAt.toISOString();
      report.durationMs = finishedAt.getTime() - startedAt.getTime();
    }

    this.progress({ type: 'done', report });
    return report;
  }

  /** Перенос папки с повторными попытками при обрывах. */
  private async migrateFolderWithRetry(mapping: FolderMapping): Promise<FolderReport> {
    const folderReport: FolderReport = {
      sourcePath: mapping.source.path,
      destPath: mapping.destPath,
      total: 0,
      copied: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    // Сколько писем папки осталось непереехавшими. Раньше сюда шла
    // единица («ошибок: 1»), из-за чего провал папки на пять тысяч писем
    // выглядел в отчёте как одна ошибка.
    const notMigrated = (): number =>
      Math.max(1, folderReport.total - folderReport.copied - folderReport.skipped);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.migrateFolder(mapping, folderReport);
        return folderReport;
      } catch (err) {
        // Остановку человеком не «повторяем»: пять попыток с нарастающей
        // паузой после нажатия «Остановить» выглядели бы как зависание.
        // И не превращаем в ошибку папки: отдаём то, что успели, — числа
        // из этого отчёта человек и увидит на месте остановки.
        if (err instanceof MigrationStoppedError) {
          await this.closeAll();
          return folderReport;
        }
        const message = err instanceof PermanentFolderError ? err.message : describeImapError(err);
        // Свежие клиенты на следующую попытку
        await this.closeAll();
        const permanent = err instanceof PermanentFolderError;
        if (permanent || attempt === this.maxAttempts) {
          folderReport.errors.push(
            `папка «${mapping.source.path}» → «${folderReport.destPath}» не перенесена ` +
              `(писем осталось: ${notMigrated()}): ${message}`,
          );
          folderReport.failed = Math.max(folderReport.failed, notMigrated());
          return folderReport;
        }
        this.progress({
          type: 'retry',
          attempt,
          maxAttempts: this.maxAttempts,
          error: message,
          sourcePath: mapping.source.path,
          destPath: folderReport.destPath,
        });
        await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
      }
    }
    return folderReport;
  }

  /**
   * Создать папку-приёмник. Если сервер отказался из-за имени (Maildir++
   * не переносит точку в имени папки — «Отчёт 2024.финал», «Проект v2.0»),
   * пробуем безопасный вариант имени, а не теряем папку целиком.
   *
   * @returns фактический путь папки-приёмника
   */
  private async ensureDestFolder(dest: ImapFlow, destPath: string): Promise<string> {
    if (destPath.toUpperCase() === 'INBOX') return destPath;

    const exists = async (path: string): Promise<boolean> => {
      try {
        const list = await dest.list();
        return list.some((item) => item.path === path);
      } catch {
        return false;
      }
    };

    let firstError: unknown;
    try {
      await dest.mailboxCreate(destPath);
      return destPath;
    } catch (err) {
      firstError = err;
    }
    // ALREADYEXISTS — самый частый случай при повторном запуске: не ходим
    // за списком папок, отвечаем сразу.
    const code = (firstError as { serverResponseCode?: string } | undefined)?.serverResponseCode;
    if (typeof code === 'string' && code.toUpperCase() === 'ALREADYEXISTS') return destPath;
    // Сервер мог отказать без кода — тогда сверяемся со списком папок
    if (await exists(destPath)) return destPath;

    const destDelimiter = this.destDelimiter ?? '/';
    const safePath = sanitizeDestPath(destPath, destDelimiter, MAILDIR_UNSAFE_CHARS);
    if (safePath !== destPath) {
      try {
        await dest.mailboxCreate(safePath);
        this.progress({
          type: 'folder-renamed',
          destPath,
          usedPath: safePath,
          reason: describeImapError(firstError),
        });
        return safePath;
      } catch {
        if (await exists(safePath)) {
          this.progress({
            type: 'folder-renamed',
            destPath,
            usedPath: safePath,
            reason: describeImapError(firstError),
          });
          return safePath;
        }
      }
    }

    throw new PermanentFolderError(
      `не удалось создать папку-приёмник «${destPath}»: ${describeImapError(firstError)}`,
    );
  }

  /**
   * Пересчитать содержимое папки-приёмника по ключам дедупликации
   * (гарантия отсутствия дублей даже без состояния).
   *
   * Считаем именно КОЛИЧЕСТВО копий каждого ключа, а не факт его наличия:
   * ключ не уникален, и «ключ встречался — значит дубль» выбрасывало
   * законно новые письма при втором проходе.
   */
  private async collectDestCounts(
    dest: ImapFlow,
    destPath: string,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const lock = await dest.getMailboxLock(destPath);
    try {
      const mailbox = typeof dest.mailbox === 'object' ? dest.mailbox : null;
      if (!mailbox || mailbox.exists === 0) return counts;
      for await (const msg of dest.fetch('1:*', {
        uid: true,
        size: true,
        headers: DEDUP_HEADER_FIELDS,
      })) {
        const key = keyOf(msg);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } finally {
      lock.release();
    }
    return counts;
  }

  /** Основной цикл переноса одной папки (одна попытка). */
  private async migrateFolder(mapping: FolderMapping, folderReport: FolderReport): Promise<void> {
    const state = this.options.state;
    const source = await this.connectSource();
    const dest = await this.connectDest();
    const sourcePath = mapping.source.path;
    const dryRun = this.options.dryRun === true;

    // 1. Метаданные писем источника.
    //    Читаем ДО создания папки-приёмника: если папку создать не удастся,
    //    в отчёте всё равно будет видно, сколько писем осталось непереехавшими.
    const sourceLock = await source.getMailboxLock(sourcePath, { readOnly: true });
    const metas: SourceMessageMeta[] = [];
    let uidValidity = '0';
    let sinceUid = 0;
    /** Читаем только письма новее курсора (а не всю папку). */
    let incremental = false;
    try {
      const mailbox = typeof source.mailbox === 'object' ? source.mailbox : null;
      uidValidity = String(mailbox?.uidValidity ?? '0');
      const exists = mailbox?.exists ?? 0;
      folderReport.total = exists;

      if (exists > 0) {
        // Курсор: если UIDVALIDITY не изменился, метаданные читаем только
        // для писем новее последнего обработанного UID …
        const cursor = state ? await state.getCursor(this.accountKey, sourcePath) : null;
        const cursorValid = cursor !== null && cursor.uidValidity === uidValidity;
        if (cursorValid) sinceUid = cursor.lastUid;
        // … но только если и набор состояния есть; без состояния всегда
        // читаем всё и полагаемся на дедупликацию по приёмнику.
        const range = state && cursorValid && sinceUid > 0 ? `${sinceUid + 1}:*` : '1:*';
        incremental = range !== '1:*';

        for await (const msg of source.fetch(
          range,
          {
            uid: true,
            size: true,
            flags: true,
            internalDate: true,
            headers: DEDUP_HEADER_FIELDS,
          },
          { uid: range !== '1:*' },
        )) {
          // «uid:*» у некоторых серверов возвращает последнее письмо, даже
          // если его UID меньше нижней границы — отфильтруем.
          if (range !== '1:*' && msg.uid <= sinceUid) continue;
          const internalDate =
            msg.internalDate instanceof Date
              ? msg.internalDate
              : msg.internalDate
                ? new Date(msg.internalDate)
                : undefined;
          metas.push({
            uid: msg.uid,
            size: msg.size ?? 0,
            flags: storableFlags(msg.flags),
            internalDate,
            key: keyOf(msg),
          });
        }
        if (range !== '1:*') {
          // При инкрементальном чтении общее число — уже обработанные + новые
          folderReport.total = exists;
        }
      }
    } finally {
      sourceLock.release();
    }
    metas.sort((a, b) => a.uid - b.uid);

    // Чтение метаданных большой папки (десятки тысяч писем) занимает
    // минуты, и всё это время нажатая кнопка «Остановить» выглядела бы
    // непрожатой. Здесь ничего ещё не записано — выходить безопасно.
    this.checkStopped();

    // 2. Папка-приёмник. Имя может измениться (Maildir++ не принимает точку
    //    внутри имени папки) — тогда дальше работаем с фактическим именем.
    let destPath = mapping.destPath;
    if (!dryRun) {
      destPath = await this.ensureDestFolder(dest, destPath);
      if (destPath !== mapping.destPath) {
        mapping.destPath = destPath;
        folderReport.destPath = destPath;
      }
    }

    // 3. Учёт копий: содержимое приёмника + хранилище состояния.
    //    Не «ключ встречался», а «сколько копий уже лежит»: иначе второй
    //    проход теряет законно новые письма с повторным Message-ID и
    //    автоуведомления, одинаковые по всем заголовкам и размеру.
    const destCounts = dryRun
      ? new Map<string, number>()
      : await this.collectDestCounts(dest, destPath);
    const ledger = new DedupLedger();
    const keySeen = new Set<string>();

    const toCopy: SourceMessageMeta[] = [];
    for (const meta of metas) {
      if (!keySeen.has(meta.key)) {
        keySeen.add(meta.key);
        const inDest = destCounts.get(meta.key) ?? 0;
        const inState = state
          ? await state.migratedCount(this.accountKey, destPath, meta.key)
          : 0;
        // При инкрементальном чтении письма, ради которых копии уже лежат
        // в приёмнике, в metas не попали (их UID меньше курсора) — значит,
        // эти копии заняты и «съесть» новое письмо не могут. Иначе дельта
        // объявляла бы новое письмо с повторным Message-ID дублем.
        ledger.setPresent(
          meta.key,
          incremental ? Math.max(0, inDest - inState) : Math.max(inDest, inState),
        );
      }
      if (ledger.consume(meta.key)) {
        folderReport.skipped++;
      } else if (
        this.options.maxMessageSize !== undefined &&
        meta.size > this.options.maxMessageSize
      ) {
        folderReport.errors.push(
          `UID ${meta.uid}: пропущено, размер ${meta.size} байт превышает лимит`,
        );
        folderReport.failed++;
      } else {
        toCopy.push(meta);
      }
    }

    this.progress({
      type: 'folder-start',
      sourcePath,
      destPath,
      toCopy: toCopy.length,
      total: folderReport.total,
    });

    if (dryRun) {
      this.progress({
        type: 'folder-done',
        sourcePath,
        destPath,
        copied: 0,
        skipped: folderReport.skipped,
        failed: folderReport.failed,
      });
      return;
    }

    // 4. Копирование: по одному письму в памяти, пачками между записями курсора.
    //
    // Курсор двигаем ТОЛЬКО по непрерывному префиксу разобранных писем.
    // Раньше он двигался и через неудавшиеся письма: после отказа по квоте
    // повторный запуск начинал читать источник уже ПОСЛЕ потерянных писем,
    // докачивал ноль и рапортовал «ошибок 0» — письма терялись навсегда.
    const cursor = new CursorTracker(
      metas.map((m) => m.uid),
      toCopy.map((m) => m.uid),
      sinceUid, // назад курсор не отматываем
    );
    let quotaHit = false;

    const writeCursor = async (): Promise<void> => {
      if (!state) return;
      await state.setCursor(this.accountKey, sourcePath, { uidValidity, lastUid: cursor.uid });
    };

    let sinceLastCursor = 0;
    for (const meta of toCopy) {
      // Остановка проверяется ПЕРЕД письмом, а не после: письмо либо
      // переехало целиком и отмечено в состоянии, либо не начиналось.
      // Оборвать APPEND на середине означало бы половину письма в приёмнике.
      if (this.stopRequested) break;
      try {
        // Скачиваем письмо потоком и собираем в Buffer (одно письмо за раз)
        const sourceLock2 = await source.getMailboxLock(sourcePath, { readOnly: true });
        let raw: Buffer;
        try {
          const download = await source.download(String(meta.uid), undefined, { uid: true });
          if (!download.content) {
            throw new Error('сервер-источник не вернул тело письма');
          }
          raw = await streamToBuffer(download.content);
        } finally {
          sourceLock2.release();
        }
        if (raw.length === 0) {
          throw new Error('пустое тело письма (возможно, письмо удалено на источнике)');
        }

        const appended = await dest.append(destPath, raw, meta.flags, meta.internalDate);
        if (appended === false) {
          throw new Error('APPEND отклонён сервером-приёмником');
        }

        ledger.markCopied(meta.key);
        cursor.markCopied(meta.uid);
        folderReport.copied++;
        if (state) await state.markMigrated(this.accountKey, destPath, meta.key);
        this.progress({
          type: 'message',
          sourcePath,
          destPath,
          uid: meta.uid,
          status: 'copied',
          copied: folderReport.copied,
          skipped: folderReport.skipped,
          failed: folderReport.failed,
          total: folderReport.total,
        });
      } catch (err) {
        // Ошибка соединения — пробрасываем выше, сработает retry;
        // ошибка конкретного письма — фиксируем и идём дальше.
        if (!source.usable || !dest.usable) throw err;
        // Раньше здесь был голый err.message, и отказ по квоте приходил как
        // «UID 5: Command failed» — слова «квота» в отчёте не было вовсе.
        const message = describeImapError(err);
        if (isQuotaError(err)) quotaHit = true;
        cursor.markFailed(meta.uid);
        folderReport.failed++;
        folderReport.errors.push(`UID ${meta.uid}: ${message}`);
        this.progress({
          type: 'message',
          sourcePath,
          destPath,
          uid: meta.uid,
          status: 'failed',
          copied: folderReport.copied,
          skipped: folderReport.skipped,
          failed: folderReport.failed,
          total: folderReport.total,
        });
      }

      sinceLastCursor++;
      if (state && sinceLastCursor >= this.batchSize) {
        await writeCursor();
        sinceLastCursor = 0;
      }
    }

    // Курсор в конец непрерывного разобранного префикса. Если по дороге
    // была неудача, курсор остановится ПЕРЕД первым непереехавшим письмом,
    // и повторный запуск начнёт именно с него.
    //
    // При остановке это тоже верно и без особого случая: письма, до которых
    // мы не дошли, остались в pending, а advance() перед первым же таким
    // письмом останавливается. Продолжение задания начнёт именно с него.
    cursor.finish();
    if (state) await writeCursor();

    if (quotaHit) {
      folderReport.errors.push(
        'перенос упёрся в квоту ящика-приёмника: поднимите квоту и запустите перенос ' +
          'повторно — с тем же файлом состояния недокачанные письма докачаются',
      );
    }

    this.progress({
      type: 'folder-done',
      sourcePath,
      destPath,
      copied: folderReport.copied,
      skipped: folderReport.skipped,
      failed: folderReport.failed,
    });
  }
}

/** Удобная функция: перенести ящик и вернуть отчёт. */
export async function migrateMailbox(options: MigrateMailboxOptions): Promise<MailboxReport> {
  const migrator = new MailboxMigrator(options);
  return migrator.run();
}

export { DEFAULT_ROLE_TARGETS };
