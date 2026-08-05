/**
 * Точка входа сервиса автоопределения настроек Mail.True.
 */
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const app = await buildApp(config, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Остановка сервиса autoconfig');
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(`Autoconfig запущен на http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Не удалось запустить сервис autoconfig:', err);
  process.exit(1);
});
