/**
 * HTTP-сторона установщика.
 *
 * Все действия закрыты одноразовым ключом (см. auth.ts). Открыты ровно два
 * ответа: /healthz и /api/state — последний нужен, чтобы страница могла
 * объяснить, ПОЧЕМУ установщик отказывается работать, не требуя для этого
 * ключа. Отказ, который сам себя не объясняет, ничем не лучше кода ошибки.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { InstallerConfig } from './config.js';
import { InstallerKey } from './auth.js';
import { checkLetsEncrypt, runChecks, type CheckResult } from './checks.js';
import { checkCustomCertificate } from './tls.js';
import { WIZARD_STEPS, defaultAnswers } from './fields.js';
import { LogBuffer } from './logbuf.js';
import { createRunner, readSummary, type Runner } from './install.js';
import type { RepoLocation } from './repo.js';
import {
  answersFromEnv,
  readEnvFile,
  readInstallMark,
  readServerTraces,
  type InstallMark,
  type ServerTraces,
} from './state.js';
import { DEFAULT_PORTS, PORT_FIELDS, validateAnswers, type Answers } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

export interface AppDeps {
  readonly config: InstallerConfig;
  readonly logger: Logger;
  readonly key: InstallerKey;
  /** Пусто, если до Docker достучаться не удалось: тогда работать не с чем. */
  readonly repo: RepoLocation | null;
  readonly startupError: string;
}

interface Assets {
  readonly html: string;
  readonly css: string;
  readonly js: string;
}

async function loadAssets(): Promise<Assets> {
  const [html, css, js] = await Promise.all([
    readFile(join(PUBLIC_DIR, 'index.html'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'installer.css'), 'utf8'),
    readFile(join(PUBLIC_DIR, 'installer.js'), 'utf8'),
  ]);
  return { html, css, js };
}

/** Ответы браузера приходят плоским объектом; здесь они становятся Answers. */
export function toAnswers(raw: Record<string, unknown>): Answers {
  const str = (key: string, fallback = ''): string => {
    const value = raw[key];
    return typeof value === 'string' ? value.trim() : fallback;
  };
  const num = (key: string, fallback: number): number => {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Math.round(Number(value));
    }
    return fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    return typeof value === 'boolean' ? value : fallback;
  };

  const ports: Record<string, number> = {};
  for (const field of PORT_FIELDS) {
    ports[field.key] = num(`port.${field.key}`, DEFAULT_PORTS[field.key] ?? 0);
  }

  const domain = str('domain');
  return {
    domain,
    hostname: str('hostname'),
    adminEmail: str('adminEmail'),
    adminLogin: str('adminLogin'),
    // Пароль не подрезаем: пробел на конце — это символ пароля, а не опечатка.
    adminPassword: typeof raw.adminPassword === 'string' ? raw.adminPassword : '',
    adminPasswordRepeat: typeof raw.adminPasswordRepeat === 'string' ? raw.adminPasswordRepeat : '',
    tls: str('tls', 'selfsigned'),
    leEmail: str('leEmail'),
    // PEM переносим как есть, только обрезая внешние пробелы: внутри него
    // значимы и переводы строк, и порядок блоков.
    customCert: str('customCert'),
    customChain: str('customChain'),
    customKey: str('customKey'),
    bindAddress: str('bindAddress', '0.0.0.0'),
    clamav: bool('clamav', false),
    aiEnabled: bool('aiEnabled', true),
    ports,
    subnet: str('subnet', '172.28.0.0/16'),
    resolverIp: str('resolverIp', '172.28.0.53'),
    dovecotIp: str('dovecotIp', '172.28.0.54'),
    messageMaxBytes: num('messageMaxBytes', 26_214_400),
    uploadMaxBytes: num('uploadMaxBytes', 26_214_400),
    composeBodyMaxBytes: num('composeBodyMaxBytes', 12_582_912),
    defaultQuotaBytes: num('defaultQuotaBytes', 1_073_741_824),
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Пароль администратора приходит телом запроса; ста килобайт хватает
    // с запасом, а больше принимать незачем.
    bodyLimit: 128 * 1024,
    // Приведение — как в apps/autoconfig: loggerInstance сужает тип
    // экземпляра до конкретного логгера pino, и он перестаёт совпадать
    // с общим FastifyInstance.
  }) as unknown as FastifyInstance;
  const assets = await loadAssets();
  const log = new LogBuffer();
  let runner: Runner | null = null;
  let lastAnswers: Answers | null = null;
  let overwriteConfirmed = false;

  const repoDir = deps.repo?.dir ?? '';
  const envPath = repoDir === '' ? '' : `${repoDir}/infra/.env`;

  // Ход проверки системы: что выполняется сейчас и что уже отработало.
  let checksRunning = new Set<string>();
  let checksDone: string[] = [];

  async function currentState(): Promise<{
    mode: 'ready' | 'installed' | 'broken';
    message: string;
    mark: InstallMark | null;
    traces: ServerTraces | null;
  }> {
    if (deps.repo === null) {
      return { mode: 'broken', message: deps.startupError, mark: null, traces: null };
    }
    const env = await readEnvFile(envPath);
    const stateCtx = {
      repoDir,
      projectName: deps.config.COMPOSE_PROJECT_NAME,
      envSnapshot: deps.config.INSTALL_COMPLETED_AT,
    };
    const mark = await readInstallMark(stateCtx, env);
    if (mark.installed) {
      return { mode: 'installed', message: '', mark, traces: null };
    }
    const traces = await readServerTraces(stateCtx, env);
    return { mode: 'ready', message: '', mark, traces };
  }

  // --- открытые ответы ---------------------------------------------

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(assets.html));
  app.get('/installer.css', async (_req, reply) =>
    reply.type('text/css; charset=utf-8').send(assets.css),
  );
  app.get('/installer.js', async (_req, reply) =>
    reply.type('application/javascript; charset=utf-8').send(assets.js),
  );

  /**
   * Состояние без ключа: можно ли вообще устанавливать. Секретов здесь нет —
   * только то, что человеку нужно, чтобы понять экран отказа.
   */
  app.get('/api/state', async () => {
    const state = await currentState();
    if (state.mode === 'installed') {
      const mark = state.mark;
      return {
        mode: 'installed',
        installedAt: mark?.fromDb ?? mark?.fromEnv ?? '',
        installedBy: mark?.installedBy ?? '',
        domain: mark?.domain ?? '',
        hostname: mark?.hostname ?? '',
        whereEnv: mark?.fromEnv !== null,
        whereDb: mark?.fromDb !== null,
      };
    }
    if (state.mode === 'broken') {
      return { mode: 'broken', message: state.message };
    }
    return { mode: 'ready' };
  });

  app.post('/api/session', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: unknown };
    const verdict = deps.key.verify(typeof body.key === 'string' ? body.key : '');
    if (!verdict.ok) {
      deps.logger.warn({ ip: req.ip }, 'неверный ключ доступа к установщику');
      return reply.code(401).send({ ok: false, message: verdict.reason });
    }
    return { ok: true };
  });

  // --- всё остальное только с ключом --------------------------------

  function authorize(req: FastifyRequest, reply: FastifyReply): boolean {
    const header = req.headers['x-install-key'];
    const given = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
    const verdict = deps.key.verify(given);
    if (!verdict.ok) {
      void reply.code(401).send({ ok: false, message: verdict.reason });
      return false;
    }
    return true;
  }

  async function guardInstallable(reply: FastifyReply): Promise<boolean> {
    const state = await currentState();
    if (state.mode === 'ready') return true;
    void reply.code(409).send({
      ok: false,
      message:
        state.mode === 'installed'
          ? 'Этот сервер уже установлен. Мастер первого запуска на нём больше не работает.'
          : state.message,
    });
    return false;
  }

  app.get('/api/context', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const state = await currentState();
    // Ответы, которые человек уже дал: домен и имя сервера могли спросить
    // до мастера — `install.sh --prepare-only` пишет их в infra/.env.
    // Спрашивать то же самое второй раз незачем: подставляем в форму.
    const env = await readEnvFile(envPath);
    const example = await readEnvFile(repoDir === '' ? '' : `${repoDir}/infra/.env.example`);
    return {
      mode: state.mode,
      steps: WIZARD_STEPS,
      defaults: { ...defaultAnswers(), ...answersFromEnv(env, example) },
      traces: state.traces?.traces ?? [],
      looksConfigured: state.traces?.looksConfigured ?? false,
      repoDir,
      projectName: deps.config.COMPOSE_PROJECT_NAME,
    };
  });

  app.post('/api/checks', async (req, reply) => {
    if (!authorize(req, reply)) return;
    if (deps.repo === null) {
      return reply.code(409).send({ ok: false, message: deps.startupError });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const answers = toAnswers(body);
    const ports = PORT_FIELDS.map((field) => ({
      port: answers.ports[field.key] ?? DEFAULT_PORTS[field.key] ?? 0,
      label: field.label,
    })).filter((p) => p.port > 0);

    // Что идёт прямо сейчас — экран спрашивает это отдельным запросом,
    // пока ждёт ответа. Без такого доклада проверка портов и исходящего
    // 25-го (полминуты молчания) выглядит зависанием.
    checksRunning = new Set<string>();
    checksDone = [];
    const results: CheckResult[] = await runChecks(
      {
        repoDir,
        repoMount: deps.config.MT_REPO_MOUNT,
        containerId: deps.repo.containerId,
        ports,
        clamavWanted: answers.clamav,
      },
      (stage, phase) => {
        if (phase === 'start') {
          checksRunning.add(stage.title);
        } else {
          checksRunning.delete(stage.title);
          if (!checksDone.includes(stage.title)) checksDone.push(stage.title);
        }
      },
    );
    checksRunning = new Set<string>();
    return { ok: true, checks: results };
  });

  /**
   * Ход проверки системы. Отдельным ответом, а не потоком: проверок
   * немного, идут они секунды, и обычный опрос здесь честнее и проще
   * живого соединения, которое пришлось бы держать и переоткрывать.
   */
  app.get('/api/checks/progress', async (req, reply) => {
    if (!authorize(req, reply)) return;
    return { running: [...checksRunning], done: checksDone };
  });

  /**
   * Выйдет ли Let’s Encrypt для указанного имени. Спрашивается на шаге
   * «Сертификат» — до выбора, а не после неудачного выпуска.
   */
  app.post('/api/tls-check', async (req, reply) => {
    if (!authorize(req, reply)) return;
    if (deps.repo === null) {
      return reply.code(409).send({ ok: false, message: deps.startupError });
    }
    const body = (req.body ?? {}) as { hostname?: unknown };
    const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : '';
    if (hostname === '' || !/^[A-Za-z0-9.-]{1,253}$/.test(hostname)) {
      return reply.code(400).send({ ok: false, message: 'Сначала задайте имя сервера.' });
    }
    return { ok: true, check: await checkLetsEncrypt(repoDir, hostname) };
  });

  /**
   * Разбор своего сертификата — теми же правилами, что применяет раздел
   * «Сертификат» в панели (packages/shared). Ничего не записывает.
   */
  app.post('/api/tls-custom-check', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const answers = toAnswers((req.body ?? {}) as Record<string, unknown>);
    if (answers.domain === '' || answers.hostname === '') {
      return reply.code(400).send({ ok: false, message: 'Сначала задайте домен и имя сервера.' });
    }
    const result = await checkCustomCertificate({
      certificate: answers.customCert,
      privateKey: answers.customKey,
      chain: answers.customChain,
      domain: answers.domain,
      hostname: answers.hostname,
    });
    return { ok: true, result };
  });

  app.post('/api/validate', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const answers = toAnswers((req.body ?? {}) as Record<string, unknown>);
    return { ok: true, errors: validateAnswers(answers) };
  });

  app.post('/api/install', async (req, reply) => {
    if (!authorize(req, reply)) return;
    if (!(await guardInstallable(reply))) return;
    if (deps.repo === null) {
      return reply.code(409).send({ ok: false, message: deps.startupError });
    }
    if (runner !== null && runner.state.phase === 'running') {
      return reply.code(409).send({ ok: false, message: 'Установка уже идёт.' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const answers = toAnswers(body);
    const errors = validateAnswers(answers);
    if (errors.length > 0) {
      return reply.code(400).send({ ok: false, errors });
    }

    // Сервер без отметки, но с признаками жизни: переустановить поверх можно
    // только с явного согласия. Молча — нельзя.
    const state = await currentState();
    if (state.traces?.looksConfigured === true && body.confirmOverwrite !== true) {
      return reply.code(409).send({
        ok: false,
        needsConfirm: true,
        traces: state.traces.traces,
        message: 'На этом сервере уже что-то настроено.',
      });
    }
    overwriteConfirmed = body.confirmOverwrite === true;

    lastAnswers = answers;
    runner = createRunner({
      repoDir,
      projectName: deps.config.COMPOSE_PROJECT_NAME,
      log,
    });
    deps.logger.info(
      { domain: answers.domain, overwriteConfirmed },
      'запущена установка из браузера',
    );
    void runner.start(answers);
    return { ok: true };
  });

  app.get('/api/progress', async (req, reply) => {
    if (!authorize(req, reply)) return;
    const query = req.query as { from?: string };
    const from = Number.parseInt(query.from ?? '0', 10);
    const slice = log.since(Number.isFinite(from) ? from : 0);
    const phase = runner?.state.phase ?? 'idle';
    return {
      ok: true,
      phase,
      from: slice.next,
      lines: slice.lines,
      failure: runner?.state.failure ?? '',
      exitCode: runner?.state.exitCode ?? null,
    };
  });

  app.get('/api/summary', async (req, reply) => {
    if (!authorize(req, reply)) return;
    if (runner === null || runner.state.phase !== 'done' || lastAnswers === null) {
      return reply.code(409).send({ ok: false, message: 'Установка ещё не завершилась.' });
    }
    const summary = await readSummary(
      { repoDir, projectName: deps.config.COMPOSE_PROJECT_NAME, log },
      lastAnswers,
    );
    const env = await readEnvFile(envPath);
    const mark = await readInstallMark(
      {
        repoDir,
        projectName: deps.config.COMPOSE_PROJECT_NAME,
        envSnapshot: deps.config.INSTALL_COMPLETED_AT,
      },
      env,
    );
    return {
      ok: true,
      summary,
      mark: { env: mark.fromEnv, db: mark.fromDb, installed: mark.installed },
    };
  });

  /**
   * «Готово». Установщик выключает себя сам: сокет Docker у него есть
   * ровно на время установки, и оставлять службу поднятой после — значит
   * оставить поднятым и полный доступ к машине.
   */
  app.post('/api/finish', async (req, reply) => {
    if (!authorize(req, reply)) return;
    if (runner === null || runner.state.phase !== 'done') {
      return reply.code(409).send({ ok: false, message: 'Установка ещё не завершилась.' });
    }
    deps.logger.info('установка завершена, установщик останавливает себя');
    // Выходим сами, а не командой `docker stop` своему же контейнеру.
    // Через docker это тоже работало, но контейнер успевал получить SIGKILL
    // по истечении отсрочки и оставался с кодом 137 — в `docker compose ps`
    // это выглядит как падение, хотя служба закончила работу штатно.
    // Процесс — единственный в контейнере: его выход и есть остановка,
    // а restart: 'no' в docker-compose.yml не даёт демону поднять его снова.
    //
    // Ответ уходит первым: иначе браузер увидит оборванное соединение и
    // покажет «не удалось», хотя всё получилось.
    setTimeout(() => {
      void app.close().finally(() => process.exit(0));
    }, 1200);
    return { ok: true };
  });

  return app;
}
