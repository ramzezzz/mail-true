/**
 * Точка входа веб-установщика Mail.True.
 *
 * Порядок запуска важен: сначала установщик выясняет, где лежит каталог
 * проекта глазами демона Docker (repo.ts), и только потом открывает порт.
 * Если Docker недоступен, служба всё равно поднимается — но открывает ровно
 * одну страницу с объяснением, почему работать не может. Молчащий порт
 * заставил бы человека гадать; отказ обязан называть причину.
 */
import { pino } from 'pino';
import { buildApp } from './app.js';
import { InstallerKey, generateKey, keyBanner } from './auth.js';
import { loadConfig } from './config.js';
import { DockerAccessError, locateRepo, type RepoLocation } from './repo.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    // Журнал контейнера читают глазами — это единственное место, где
    // печатается ключ доступа. JSON здесь мешал бы.
    transport: { target: 'pino/file', options: { destination: 1 } },
  });

  let repo: RepoLocation | null = null;
  let startupError = '';
  try {
    repo = await locateRepo(config.COMPOSE_PROJECT_NAME, config.MT_REPO_MOUNT);
    logger.info(
      { repoDir: repo.dir, container: repo.containerId.slice(0, 12) },
      'каталог проекта найден',
    );
  } catch (err) {
    startupError =
      err instanceof DockerAccessError
        ? err.message
        : `Не удалось определить каталог проекта: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(startupError);
  }

  const key = new InstallerKey(generateKey());
  const app = await buildApp({ config, logger, key, repo, startupError });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'остановка установщика');
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });

  if (config.INSTALL_COMPLETED_AT !== '') {
    // Ключ не печатаем: разрешать нечего. Печатаем то, что нужно человеку.
    process.stdout.write(
      [
        '',
        '='.repeat(66),
        '  Этот сервер уже установлен — мастер первого запуска отключён.',
        `  Отметка «установлено»: ${config.INSTALL_COMPLETED_AT}`,
        '',
        '  Установщик не станет ничего менять. Если вы действительно ставите',
        '  сервер заново, отметку нужно снять осознанно, на самом сервере:',
        '',
        '    sudo bash install/allow-reinstall.sh',
        '',
        '  Перед этим стоит снять копию:  sudo bash install/backup.sh',
        '='.repeat(66),
        '',
      ].join('\n'),
    );
  } else {
    process.stdout.write(keyBanner(key.value, config.INSTALLER_PORT));
  }
}

main().catch((err) => {
  console.error('Не удалось запустить веб-установщик:', err);
  process.exit(1);
});
