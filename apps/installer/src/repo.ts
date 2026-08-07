/**
 * Каталог проекта глазами демона Docker.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО
 * ------------------------------------------------------------------
 * Установщик запускает `docker compose up` изнутри контейнера, через
 * сокет. Compose читает файл со СВОЕЙ стороны, а относительные пути
 * томов («./unbound/unbound.conf», контекст сборки «..») превращает в
 * абсолютные и отдаёт демону — который открывает их уже на ХОСТЕ.
 *
 * Если каталог проекта примонтирован в контейнер по другому пути, чем
 * лежит на хосте, демон получает путь, которого у него нет. Дальше одно
 * из двух, и оба хуже некуда: либо docker откажет, либо СОЗДАСТ пустой
 * каталог по этому пути и примонтирует его вместо конфигурации — то есть
 * стек поднимется с пустым unbound.conf и пустым каталогом сертификатов,
 * и разбираться в этом придётся по симптомам.
 *
 * ------------------------------------------------------------------
 * РЕШЕНИЕ: СПРОСИТЬ У ДЕМОНА И ПОВТОРИТЬ ПУТЬ У СЕБЯ
 * ------------------------------------------------------------------
 * Демон знает точно, откуда взят том: `docker inspect` своего же
 * контейнера показывает Source (путь на хосте) и Destination (/repo).
 * Установщик спрашивает Source и делает у себя символическую ссылку
 * Source → /repo. После этого путь к проекту ОДИНАКОВ по обе стороны
 * сокета, и compose можно запускать как обычно.
 *
 * Свой контейнер ищем по меткам, которые compose ставит сам
 * (com.docker.compose.project / .service), а не по имени хоста: при
 * некоторых сетевых режимах имя хоста контейнера совпадает с именем
 * хоста МАШИНЫ, и поиск по нему нашёл бы что угодно.
 */
import { mkdir, symlink, lstat, readlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { run } from './shell.js';

export interface RepoLocation {
  /** Путь к каталогу проекта, одинаковый для установщика и для демона. */
  readonly dir: string;
  /** Путь монтирования внутри контейнера (обычно /repo). */
  readonly mount: string;
  /** Идентификатор собственного контейнера. */
  readonly containerId: string;
}

export class DockerAccessError extends Error {}

async function ownContainerId(project: string): Promise<string> {
  const found = await run('docker', [
    'ps',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'label=com.docker.compose.service=installer',
    '--format',
    '{{.ID}}',
  ]);
  if (found.code !== 0) {
    throw new DockerAccessError(
      'Установщику не отвечает Docker. Он поднят без сокета Docker ' +
        '(/var/run/docker.sock) — а без него установить нечего: сборка образов ' +
        'и запуск служб делаются именно через него.\n' +
        (found.stderr.trim() || '').slice(0, 400),
    );
  }
  const id = found.stdout.split('\n').map((s) => s.trim())[0] ?? '';
  if (id === '') {
    throw new DockerAccessError(
      `Среди контейнеров проекта «${project}» установщик не нашёл себя. ` +
        'Так бывает, если служба запущена не через docker compose. Правильный запуск:\n' +
        '  docker compose -f infra/docker-compose.yml --profile installer up -d installer',
    );
  }
  return id;
}

async function mountSource(containerId: string, mount: string): Promise<string> {
  const inspected = await run('docker', [
    'inspect',
    containerId,
    '--format',
    `{{range .Mounts}}{{if eq .Destination "${mount}"}}{{.Source}}{{end}}{{end}}`,
  ]);
  const source = inspected.stdout.trim();
  if (inspected.code !== 0 || source === '') {
    throw new DockerAccessError(
      `Каталог проекта не примонтирован в ${mount}. Установщик работает с теми же ` +
        'файлами, что и install/install.sh: ему нужны install/lib/common.sh, каталог ' +
        'миграций и infra/.env на запись. Запускайте службу штатно:\n' +
        '  docker compose -f infra/docker-compose.yml --profile installer up -d installer',
    );
  }
  return source;
}

/** Сделать так, чтобы путь хоста существовал и внутри контейнера. */
async function mirrorPath(hostPath: string, mount: string): Promise<void> {
  if (hostPath === mount) return;
  try {
    const existing = await lstat(hostPath);
    if (existing.isSymbolicLink()) {
      const target = await readlink(hostPath);
      if (target === mount) return;
    }
    // Что-то уже занимает этот путь и это не наша ссылка. Ломать не будем.
    throw new DockerAccessError(
      `Путь ${hostPath} внутри контейнера занят чем-то другим. Установщик не стал ` +
        'его трогать: он должен был повторить путь каталога проекта, каким его видит Docker.',
    );
  } catch (err) {
    if (err instanceof DockerAccessError) throw err;
    // Пути нет — это обычный случай, создаём ссылку.
  }
  await mkdir(dirname(hostPath), { recursive: true });
  await symlink(mount, hostPath, 'dir');
}

export async function locateRepo(project: string, mount: string): Promise<RepoLocation> {
  const containerId = await ownContainerId(project);
  const source = await mountSource(containerId, mount);
  await mirrorPath(source, mount);
  return { dir: source, mount, containerId };
}
