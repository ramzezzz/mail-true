/**
 * @mail-true/migrate — перенос почты с внешнего IMAP-сервера в Mail.True.
 *
 * Программный интерфейс для API/админки:
 *   - probeEndpoint — проверка связи и доступа к ящику ДО начала переноса;
 *   - migrateMailbox / MailboxMigrator — перенос одного ящика с событиями
 *     прогресса;
 *   - migrateBatch / parseAccountsList — пакетный перенос по списку;
 *   - createStateStore / FileStateStore / PgStateStore — состояние докачки;
 *   - parseKerioUsersCsv / parseKerioUsersCfg / toMailboxList — разбор
 *     выгрузки пользователей Kerio Connect;
 *   - buildFolderMappings и таблицы соответствий папок.
 */

export * from './types.js';
export {
  buildFolderMappings,
  detectRole,
  detectInboxPrefix,
  translatePath,
  sanitizeSegment,
  sanitizeDestPath,
  DEFAULT_ROLE_TARGETS,
  MAILDIR_UNSAFE_CHARS,
} from './folder-map.js';
export { dedupKey, DedupLedger, normalizeMessageId, parseDedupHeaders } from './dedup.js';
export type { DedupHeaders } from './dedup.js';
export { parseCsv, parseCsvWithHeader, detectDelimiter, CsvParseError } from './csv.js';
export { resolvePassword, writeSecretFile, PasswordError } from './secrets.js';
export type { PasswordSources } from './secrets.js';
export { FileStateStore, PgStateStore, createStateStore } from './state.js';
export type { StateStore, FolderCursor } from './state.js';
export {
  MailboxMigrator,
  migrateMailbox,
  CursorTracker,
  PermanentFolderError,
  MigrationStoppedError,
  describeImapError,
  isQuotaError,
} from './migrator.js';
export { probeEndpoint } from './probe.js';
export { migrateBatch, parseAccountsList } from './batch.js';
export type { BatchOptions, DestDefaults } from './batch.js';
export {
  parseKerioUsersCsv,
  parseKerioUsersCfg,
  toMailboxList,
  domainFromKerioFilename,
} from './kerio-users.js';
export type { KerioUser, MailboxToCreate } from './kerio-users.js';
