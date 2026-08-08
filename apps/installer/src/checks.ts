/**
 * Проверка системы — первый шаг мастера.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПОРТЫ ПРОВЕРЯЮТСЯ ЧЕРЕЗ DOCKER, А НЕ ЧЕРЕЗ ss
 * ------------------------------------------------------------------
 * install/install.sh смотрит `ss -ltnp` на хосте — там это верно. Внутри
 * контейнера у ss своя сетевая среда: он честно ответит «порт 25 свободен»
 * ровно всегда, потому что внутри контейнера он и правда свободен. Такая
 * проверка не просто бесполезна — она хуже отсутствующей: человек читает
 * зелёную строку и идёт дальше, а стек падает на «port is already allocated».
 *
 * Поэтому вопрос задаётся тому, кто на него отвечает, — самому Docker,
 * и ровно в той форме, в какой он встанет при подъёме стека: «дай мне
 * опубликовать этот порт». Отказ демона и есть ответ. Заодно это ловит
 * случаи, которые ss не видит: порт, занятый другим контейнером на том же
 * демоне, и порт, занятый на другом сетевом стеке (Docker Desktop, WSL).
 *
 * Чужой контейнер при этом называется по имени: «занят контейнером
 * mtcheck-postfix-1» — это ответ, с которым можно что-то сделать, в отличие
 * от «порт занят».
 */
import { readFile } from 'node:fs/promises';
import { run, bashWithCommon } from './shell.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
}

export interface CheckContext {
  readonly repoDir: string;
  readonly repoMount: string;
  readonly containerId: string;
  /** Порты, которые нужно проверить: номер → человеческое имя. */
  readonly ports: ReadonlyArray<{ port: number; label: string }>;
  readonly clamavWanted: boolean;
}

const MIN_RAM_MB = 1800;
const MIN_RAM_CLAMAV_MB = 3000;
const MIN_DISK_GB = 10;
const MIN_COMPOSE = '2.24';

/** Сравнение версий вида 2.24.1 >= 2.24 (аналог version_ge в common.sh). */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const b = minimum.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function checkMemory(ctx: CheckContext): Promise<CheckResult> {
  let totalMb = 0;
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemTotal:\s+(\d+) kB/m.exec(meminfo);
    if (match?.[1] !== undefined) totalMb = Math.round(Number(match[1]) / 1024);
  } catch {
    /* нечего читать — скажем об этом ниже */
  }
  if (totalMb === 0) {
    return {
      id: 'memory',
      title: 'Оперативная память',
      status: 'warn',
      detail: 'Определить объём памяти не удалось.',
    };
  }
  const need = ctx.clamavWanted ? MIN_RAM_CLAMAV_MB : MIN_RAM_MB;
  if (totalMb >= need) {
    return {
      id: 'memory',
      title: 'Оперативная память',
      status: 'ok',
      detail: `${totalMb} МБ. Стек в простое занимает около 310 МБ${
        ctx.clamavWanted ? ', антивирус добавит около 1 ГБ' : ''
      }.`,
    };
  }
  return {
    id: 'memory',
    title: 'Оперативная память',
    status: 'warn',
    detail: `${totalMb} МБ, а рекомендуется от ${need} МБ.`,
    hint: ctx.clamavWanted
      ? 'Антивирус держит базы сигнатур в памяти — это около 1 ГБ сверх остального стека. На этой машине его лучше не включать.'
      : 'Стек поднимется и на меньшем объёме, но запаса на письма и поиск не останется.',
  };
}

async function diskFreeGb(path: string): Promise<number | null> {
  const out = await run('df', ['-Pk', path]);
  if (out.code !== 0) return null;
  const line = out.stdout.trim().split('\n')[1];
  if (line === undefined) return null;
  const parts = line.trim().split(/\s+/);
  const availKb = Number(parts[3]);
  return Number.isFinite(availKb) ? Math.floor(availKb / 1024 / 1024) : null;
}

async function checkDisk(ctx: CheckContext): Promise<CheckResult> {
  const repoGb = await diskFreeGb(ctx.repoMount);

  // Письма и база лежат НЕ рядом с каталогом проекта, а в томах docker —
  // на сервере это сплошь и рядом другой раздел, и кончается первым он.
  let volumesGb: number | null = null;
  let volumesRoot = '';
  const rootDir = await run('docker', ['info', '--format', '{{.DockerRootDir}}']);
  if (rootDir.code === 0 && rootDir.stdout.trim() !== '') {
    volumesRoot = rootDir.stdout.trim();
    const image = await ownImage(ctx.containerId);
    if (image !== null) {
      const probe = await run('docker', [
        'run',
        '--rm',
        '-v',
        `${volumesRoot}:/dockerroot:ro`,
        image,
        'df',
        '-Pk',
        '/dockerroot',
      ]);
      const line = probe.stdout.trim().split('\n')[1];
      if (probe.code === 0 && line !== undefined) {
        const availKb = Number(line.trim().split(/\s+/)[3]);
        if (Number.isFinite(availKb)) volumesGb = Math.floor(availKb / 1024 / 1024);
      }
    }
  }

  const smallest = [repoGb, volumesGb]
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)[0];
  if (smallest === undefined) {
    return {
      id: 'disk',
      title: 'Свободное место',
      status: 'warn',
      detail: 'Определить свободное место не удалось.',
    };
  }
  const detail =
    `Каталог проекта: ${repoGb ?? '?'} ГБ свободно.` +
    (volumesGb === null
      ? ''
      : ` Тома docker (${volumesRoot}), где лежат письма и база: ${volumesGb} ГБ.`);
  if (smallest >= MIN_DISK_GB) {
    return { id: 'disk', title: 'Свободное место', status: 'ok', detail };
  }
  return {
    id: 'disk',
    title: 'Свободное место',
    status: 'warn',
    detail: `${detail} Рекомендуется от ${MIN_DISK_GB} ГБ.`,
    hint: 'Образы стека занимают около 1.5 ГБ, остальное — письма и индексы поиска. Когда место кончится, приём почты остановится.',
  };
}

async function checkDocker(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const server = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (server.code !== 0) {
    results.push({
      id: 'docker',
      title: 'Docker',
      status: 'fail',
      detail: 'Демон Docker не отвечает через сокет.',
      hint: 'Установщику нужен /var/run/docker.sock: без него нечем ни собрать образы, ни поднять службы.',
    });
    return results;
  }
  results.push({
    id: 'docker',
    title: 'Docker',
    status: 'ok',
    detail: `Версия ${server.stdout.trim()}.`,
  });

  const compose = await run('docker', ['compose', 'version', '--short']);
  const version = compose.stdout.trim().replace(/^v/, '');
  if (compose.code !== 0 || version === '') {
    results.push({
      id: 'compose',
      title: 'Docker Compose',
      status: 'fail',
      detail: 'Плагин docker compose недоступен.',
    });
  } else if (versionAtLeast(version, MIN_COMPOSE)) {
    results.push({
      id: 'compose',
      title: 'Docker Compose',
      status: 'ok',
      detail: `Версия ${version}.`,
    });
  } else {
    results.push({
      id: 'compose',
      title: 'Docker Compose',
      status: 'fail',
      detail: `Версия ${version}, а нужна от ${MIN_COMPOSE}.`,
      hint: 'install/compose.prod.yml использует тег !override — он появился в 2.24. На более старой версии почтовые порты не опубликуются наружу.',
    });
  }
  return results;
}

async function ownImage(containerId: string): Promise<string | null> {
  const out = await run('docker', ['inspect', containerId, '--format', '{{.Image}}']);
  const image = out.stdout.trim();
  return out.code === 0 && image !== '' ? image : null;
}

/** Порты, уже опубликованные контейнерами этого демона: порт → чем занят. */
async function containerPorts(): Promise<Map<number, string>> {
  const busy = new Map<number, string>();
  const out = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  if (out.code !== 0) return busy;
  for (const line of out.stdout.split('\n')) {
    const [name, ports] = line.split('\t');
    if (name === undefined || ports === undefined) continue;
    // «0.0.0.0:25->25/tcp, 127.0.0.1:8080->80/tcp»
    for (const match of ports.matchAll(/(?:^|\s|,)(?:[\d.:[\]]+):(\d+)->/g)) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && !busy.has(port)) busy.set(port, name);
    }
  }
  return busy;
}

/**
 * Попросить у демона опубликовать порт — ровно то, что сделает стек.
 * Возвращает пустую строку, если порт свободен, иначе текст отказа.
 */
async function probePort(image: string, port: number): Promise<string> {
  const out = await run('docker', ['run', '--rm', '-p', `${port}:${port}`, image, '/bin/true'], {
    timeoutMs: 25_000,
  });
  if (out.code === 0) return '';
  return `${out.stderr}\n${out.stdout}`.trim();
}

async function checkPorts(ctx: CheckContext, watch?: CheckWatcher): Promise<CheckResult[]> {
  const image = await ownImage(ctx.containerId);
  const taken = await containerPorts();
  const results: CheckResult[] = [];

  for (const { port, label } of ctx.ports) {
    const byContainer = taken.get(port);
    if (byContainer !== undefined) {
      results.push({
        id: `port-${port}`,
        title: `Порт ${port} — ${label}`,
        status: 'fail',
        detail: `Занят контейнером ${byContainer}.`,
        hint:
          `Это другой стек на той же машине. Либо остановите его, либо задайте на шаге ` +
          `«Порты» другой номер — тогда обе установки уживутся рядом.`,
      });
      continue;
    }
    if (image === null) {
      results.push({
        id: `port-${port}`,
        title: `Порт ${port} — ${label}`,
        status: 'warn',
        detail: 'Проверить не удалось: установщик не нашёл собственный образ.',
      });
      continue;
    }
    // Каждый порт — отдельный запуск контейнера, и их девять: без
    // доклада по одному экран полминуты показывал бы «Занятость портов».
    const stage = { id: `port-${port}`, title: `Порт ${port} — ${label}` };
    watch?.(stage, 'start');
    const failure = await probePort(image, port);
    watch?.(stage, 'done');
    if (failure === '') {
      results.push({
        id: `port-${port}`,
        title: `Порт ${port} — ${label}`,
        status: 'ok',
        detail: 'Свободен.',
      });
    } else {
      results.push({
        id: `port-${port}`,
        title: `Порт ${port} — ${label}`,
        status: 'fail',
        detail: 'Занят процессом на сервере — Docker отказался его опубликовать.',
        hint:
          `Кто именно: ss -ltnp | grep :${port}\n` +
          'Часто это postfix или exim, установленный «прицепом» к другим пакетам: ' +
          'systemctl disable --now postfix',
      });
    }
  }
  return results;
}

/**
 * Исходящий 25-й порт — самая частая причина «почта приходит, но не уходит».
 * Хостеры закрывают его по умолчанию, и выясняется это через неделю после
 * установки, когда письма уже копятся в очереди.
 */
async function checkOutbound25(repoDir: string): Promise<CheckResult> {
  const probe = await bashWithCommon(
    repoDir,
    `for mx in gmail-smtp-in.l.google.com alt1.aspmx.l.google.com mx.yandex.ru; do
        if tcp_probe "$mx" 25 6; then echo OPEN; exit 0; fi
     done
     if tcp_probe 1.1.1.1 443 5; then echo CLOSED; else echo NONET; fi`,
    { timeoutMs: 45_000 },
  );
  const verdict = probe.stdout.trim().split('\n').pop() ?? '';
  if (verdict === 'OPEN') {
    return {
      id: 'outbound25',
      title: 'Исходящий порт 25',
      status: 'ok',
      detail: 'Открыт — письма смогут уходить наружу.',
    };
  }
  if (verdict === 'CLOSED') {
    return {
      id: 'outbound25',
      title: 'Исходящий порт 25',
      status: 'fail',
      detail: 'Закрыт: соединение с чужими MX не устанавливается, хотя интернет работает.',
      hint:
        'Значит порт режет провайдер или хостер. Почта будет приходить, но не уходить. ' +
        'Обычно открывают после короткой переписки с поддержкой; второй путь — отправка ' +
        'через внешний релей (docs/install.md). Установить сервер это не мешает.',
    };
  }
  return {
    id: 'outbound25',
    title: 'Исходящий порт 25',
    status: 'warn',
    detail: 'Проверить не удалось: сеть недоступна вообще.',
  };
}

/**
 * Выйдет ли Let's Encrypt — вопрос, на который можно ответить ЗАРАНЕЕ.
 *
 * Выпуск проваливается по одной и той же причине: имя сервера ещё не
 * указывает на эту машину. Certbot узнаёт об этом через минуту ожидания и
 * отвечает своим текстом про «challenge failed», из которого человеку не
 * следует ровным счётом ничего — кроме того, что «не получилось».
 *
 * Поэтому спрашиваем сами и до выбора: какой адрес у сервера снаружи и куда
 * ведёт A-запись имени. Это те же resolve_a и public_ip, которыми пользуется
 * install/install.sh при настоящем выпуске.
 */
export async function checkLetsEncrypt(repoDir: string, hostname: string): Promise<CheckResult> {
  const probe = await bashWithCommon(
    repoDir,
    `printf 'IP=%s\\n' "$(public_ip)"
     printf 'A=%s\\n' "$(resolve_a ${JSON.stringify(hostname)} | tr '\\n' ' ')"`,
    { timeoutMs: 30_000 },
  );
  const ip = /^IP=(.*)$/m.exec(probe.stdout)?.[1]?.trim() ?? '';
  const a = (/^A=(.*)$/m.exec(probe.stdout)?.[1] ?? '').trim();
  const addresses = a === '' ? [] : a.split(/\s+/);

  if (addresses.length === 0) {
    return {
      id: 'letsencrypt',
      title: `Let’s Encrypt для ${hostname}`,
      status: 'fail',
      detail: `A-записи у имени ${hostname} нет — снаружи оно никуда не ведёт.`,
      hint:
        `Опубликуйте A-запись ${hostname} → ${ip === '' ? '<адрес сервера>' : ip} и вернитесь ` +
        'на этот шаг. Пока её нет, Let’s Encrypt откажет: он проверяет владение именем, ' +
        'постучавшись по нему снаружи. Можно поставить самоподписанный сейчас и выпустить ' +
        'настоящий потом: sudo bash install/renew-certs.sh --force',
    };
  }
  if (ip !== '' && addresses.includes(ip)) {
    return {
      id: 'letsencrypt',
      title: `Let’s Encrypt для ${hostname}`,
      status: 'ok',
      detail: `${hostname} → ${addresses.join(', ')} — это адрес этого сервера. Выпуск должен пройти.`,
    };
  }
  return {
    id: 'letsencrypt',
    title: `Let’s Encrypt для ${hostname}`,
    status: 'fail',
    detail:
      `${hostname} ведёт на ${addresses.join(', ')}, а этот сервер снаружи виден как ` +
      `${ip === '' ? 'неизвестный адрес' : ip}.`,
    hint:
      'Let’s Encrypt постучится по имени и попадёт не сюда — выпуск не пройдёт. Либо поправьте ' +
      'A-запись, либо возьмите пока самоподписанный сертификат.',
  };
}

/**
 * ЧТО ИДЁТ ПРЯМО СЕЙЧАС.
 *
 * Проверки занимают от секунды до полуминуты: каждый порт спрашивается у
 * Docker отдельным запуском контейнера, а исходящий 25-й ждёт ответа
 * чужих MX с таймаутом. Всё это время экран показывал одну неподвижную
 * строку — и выглядело как зависание, тем более что кнопка тоже замирала.
 *
 * Поэтому проверки докладывают о себе: начали — сказали, закончили —
 * сказали. Никакого поддельного процента: показывается ровно то, что
 * выполняется в эту секунду.
 */
export interface CheckStage {
  readonly id: string;
  readonly title: string;
}

export type CheckWatcher = (stage: CheckStage, phase: 'start' | 'done') => void;

async function staged<T>(
  watch: CheckWatcher | undefined,
  stage: CheckStage,
  work: () => Promise<T>,
): Promise<T> {
  watch?.(stage, 'start');
  try {
    return await work();
  } finally {
    watch?.(stage, 'done');
  }
}

export async function runChecks(ctx: CheckContext, watch?: CheckWatcher): Promise<CheckResult[]> {
  const [memory, disk, docker, ports, outbound] = await Promise.all([
    staged(watch, { id: 'memory', title: 'Оперативная память' }, () => checkMemory(ctx)),
    staged(watch, { id: 'disk', title: 'Место на диске' }, () => checkDisk(ctx)),
    staged(watch, { id: 'docker', title: 'Docker и compose' }, () => checkDocker()),
    staged(watch, { id: 'ports', title: 'Занятость портов' }, () => checkPorts(ctx, watch)),
    staged(watch, { id: 'outbound', title: 'Исходящий 25-й порт' }, () =>
      checkOutbound25(ctx.repoDir),
    ),
  ]);
  return [memory, disk, ...docker, ...ports, outbound];
}
