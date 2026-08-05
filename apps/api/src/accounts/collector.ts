/**
 * Сборщик почты с чужого сервера.
 *
 * Основной режим подключения (так же работает mail.ru): периодически
 * забираем письма с внешнего IMAP-сервера и складываем в папку нашего
 * ящика. Плюсы — письма доступны офлайн, попадают в общий поиск, к ним
 * применяются фильтры и цепочки; минус — занимают место дважды.
 *
 * Сам перенос НЕ переписан заново: используется @mail-true/migrate —
 * тот же код, которым переносят ящики с чужих серверов при миграции.
 * Там уже решены ровно те задачи, что нужны сборщику:
 *
 *   - дедупликация по Message-ID (а без него — по набору заголовков
 *     и размеру), причём и по содержимому папки-приёмника, и по журналу
 *     состояния: повторный запуск не создаёт дублей даже после потери
 *     журнала;
 *   - докачка с места обрыва по курсору UIDVALIDITY/UID;
 *   - сохранение флагов и внутренней даты письма;
 *   - переподключение при обрыве.
 *
 * Вторая реализация того же самого означала бы вторую копию ошибок.
 *
 * Вход в НАШ ящик выполняется служебным пользователем Dovecot
 * (`ящик*mtadmin`): сбор идёт по расписанию, когда сессии владельца нет,
 * а хранить пароль от собственного ящика ради этого мы не хотим.
 */
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import {
  createStateStore,
  migrateMailbox,
  type ImapEndpoint,
  type MailboxReport,
  type StateStore,
} from '@mail-true/migrate';
import type { CollectorStatus, ExternalAccount } from './types.js';
import { errorInfo } from '../log.js';

/** Параметры одного запуска сбора. */
export interface CollectOptions {
  account: ExternalAccount;
  /** Расшифрованный пароль от чужого сервера — только в памяти процесса. */
  password: string;
  /** Куда складывать: подключение к нашему Dovecot. */
  dest: ImapEndpoint;
  /** Строка описания хранилища состояния (`pg:postgres://…` или путь к файлу). */
  stateSpec: string | null;
  /** Сколько писем переносить между записями курсора. */
  batchSize: number;
  logger: Logger;
}

export interface CollectResult {
  status: CollectorStatus;
  copied: number;
  skipped: number;
  failed: number;
  durationMs: number;
  error: string | null;
  report: MailboxReport | null;
}

/** Подключение к чужому серверу для сборщика. */
export function sourceEndpoint(account: ExternalAccount, password: string): ImapEndpoint {
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    user: account.imap.user,
    pass: password,
    ...(account.allowInsecureTls ? { allowInsecureTls: true } : {}),
  };
}

/**
 * Читает список папок источника.
 *
 * Нужен до переноса: сопоставление папок задаётся явными правилами
 * (какая папка источника в какую нашу), а без списка их не построить.
 * Отдельное короткое соединение здесь дешевле, чем менять чужой пакет.
 */
export async function listSourceFolders(endpoint: ImapEndpoint): Promise<string[]> {
  const client = new ImapFlow({
    host: endpoint.host,
    port: endpoint.port ?? (endpoint.secure ? 993 : 143),
    secure: endpoint.secure ?? false,
    auth: { user: endpoint.user, pass: endpoint.pass },
    logger: false,
    ...(endpoint.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const list = await client.list();
    return list
      .filter((item) => !(item.flags instanceof Set && item.flags.has('\\Noselect')))
      .map((item) => item.path);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Строит правила сопоставления папок под выбранный охват.
 *
 * `inbox` — забираем только «Входящие» источника в указанную папку;
 * всё остальное явно исключается, чтобы автоматика пакета переноса
 * не потащила с собой «Отправленные» и «Корзину».
 *
 * `all` — забираем всё дерево источника внутрь папки-приёмника,
 * сохраняя вложенность: «Входящие» ложатся в саму папку, остальные —
 * в подпапки с тем же именем.
 */
export function buildFolderOverrides(
  sourcePaths: string[],
  targetFolder: string,
  scope: 'inbox' | 'all',
): { overrides: Record<string, string>; exclude: string[] } {
  const overrides: Record<string, string> = {};
  const exclude: string[] = [];
  for (const path of sourcePaths) {
    const isInbox = path.toUpperCase() === 'INBOX';
    if (scope === 'inbox') {
      if (isInbox) overrides[path] = targetFolder;
      else exclude.push(path);
      continue;
    }
    if (isInbox) {
      overrides[path] = targetFolder;
      continue;
    }
    // Путь источника может начинаться с 'INBOX/' — приставку убираем,
    // иначе у нас появится «Собранное/INBOX/Проекты».
    const relative = path.replace(/^INBOX[/.]/i, '');
    overrides[path] =
      targetFolder.toUpperCase() === 'INBOX' ? relative : `${targetFolder}/${relative}`;
  }
  return { overrides, exclude };
}

/**
 * Выполняет один сбор.
 *
 * Ошибка не бросается наружу: состояние сборщика — часть того, что видит
 * пользователь, и «подключение сломалось» должно превращаться в понятную
 * строку в интерфейсе, а не в 500 на фоновой задаче.
 */
export async function collectOnce(options: CollectOptions): Promise<CollectResult> {
  const started = Date.now();
  const { account, password, dest, stateSpec, batchSize, logger } = options;
  const source = sourceEndpoint(account, password);

  let state: StateStore | null = null;
  try {
    const sourcePaths = await listSourceFolders(source);
    const { overrides, exclude } = buildFolderOverrides(
      sourcePaths,
      account.targetFolder,
      account.collectScope,
    );

    if (stateSpec) {
      state = createStateStore(stateSpec);
      await state.init();
    }

    const report = await migrateMailbox({
      source,
      dest,
      mapping: { overrides, exclude },
      batchSize,
      logger,
      ...(state ? { state } : {}),
    });

    return {
      status: report.status === 'ok' ? 'ok' : report.status === 'partial' ? 'partial' : 'error',
      copied: report.copied,
      skipped: report.skipped,
      failed: report.failed,
      durationMs: Date.now() - started,
      error: report.error ?? null,
      report,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(errorInfo(err, { account: account.address }), 'Сбор почты с внешнего ящика не удался');
    return {
      status: 'error',
      copied: 0,
      skipped: 0,
      failed: 0,
      durationMs: Date.now() - started,
      error: message,
      report: null,
    };
  } finally {
    if (state) await state.close().catch(() => undefined);
  }
}
