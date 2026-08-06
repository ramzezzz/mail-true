/**
 * Точка входа API-сервера Mail.True.
 */
import { pino } from 'pino';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { SecretBox } from './crypto.js';
import { MemorySessionStore, RedisSessionStore, type SessionStore } from './session.js';
import { ImapPool } from './imap/pool.js';
import { UploadStore } from './uploads.js';
import { buildApp } from './app.js';
import { installProcessGuards } from './process-guards.js';
import { createLogStreams } from './admin/app-log.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // Журнал идёт в stdout контейнера (как и раньше) И, если задан
  // API_LOG_FILE, вторым потоком в файл общего тома. Файл нужен разделу
  // «Журналы» админки: прочитать stdout контейнера можно только через
  // сокет Docker, а он даёт права root на всей машине — см. admin/app-log.ts.
  const { stream: logStream, rotate: rotateLog } = createLogStreams({
    path: process.env.API_LOG_FILE ?? '',
    level: config.LOG_LEVEL,
    onError: (message) => process.stderr.write(`${message}\n`),
  });
  const logger = pino({ level: config.LOG_LEVEL }, logStream);
  // Проворот по размеру: файл в томе никто не проворачивает, а место
  // на диске почтовому серверу нужно для писем.
  const rotateTimer = rotateLog ? setInterval(rotateLog, 60_000) : null;
  rotateTimer?.unref();

  // Ставится первым делом: необработанное событие error на любом соединении
  // и необработанное отклонение обещания иначе убивают процесс целиком
  installProcessGuards(logger);

  if (config.ATTACHMENT_MAX_BYTES < config.UPLOAD_MAX_BYTES) {
    logger.warn(
      {
        uploadMaxBytes: config.UPLOAD_MAX_BYTES,
        messageMaxBytes: config.MESSAGE_MAX_BYTES,
        effective: config.ATTACHMENT_MAX_BYTES,
      },
      'UPLOAD_MAX_BYTES больше того, что пролезет в письмо после кодирования: ' +
        'действует уменьшенный предел вложения'
    );
  }

  let redis: Redis | null = null;
  let sessions: SessionStore;
  if (config.SESSION_STORE === 'redis') {
    redis = new Redis(config.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis недоступен'));
    sessions = new RedisSessionStore(redis);
  } else {
    logger.warn('SESSION_STORE=memory: сессии живут только в памяти процесса');
    sessions = new MemorySessionStore();
  }

  const secretBox = new SecretBox(config.SESSION_SECRET);
  const pool = new ImapPool({
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_SECURE,
    rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED,
    idleMs: config.IMAP_POOL_IDLE_MS,
    logger,
  });
  const uploads = new UploadStore(config.UPLOAD_DIR);
  await uploads.init();
  // Чистим старые загрузки при старте и раз в час
  await uploads.sweep().catch(() => undefined);
  const sweepTimer = setInterval(() => void uploads.sweep().catch(() => undefined), 3600_000);
  sweepTimer.unref();

  const { app, notifier } = await buildApp({ config, logger, sessions, secretBox, pool, uploads });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Остановка сервера');
    clearInterval(sweepTimer);
    if (rotateTimer) clearInterval(rotateTimer);
    await notifier.closeAll().catch(() => undefined);
    await pool.closeAll().catch(() => undefined);
    await app.close().catch(() => undefined);
    if (redis) redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(`API запущен на http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  // Здесь именно console: логгер поднимается вместе с приложением, а этот
  // отказ означает, что оно как раз и не поднялось.
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});
