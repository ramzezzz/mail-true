/**
 * Собственно установка.
 *
 * ------------------------------------------------------------------
 * ЗДЕСЬ НЕТ НИ ОДНОГО ШАГА УСТАНОВКИ
 * ------------------------------------------------------------------
 * И это главное свойство файла. Мастер в браузере собирает ответы и
 * запускает ТУ ЖЕ install/install.sh, которой ставят из консоли:
 *
 *     bash install/install.sh --answers <файл> --non-interactive --yes
 *
 * Секреты, миграции, домен, ящик, учётная запись администратора,
 * сертификат, DNS-записи, отметка «установлено» — всё делает она.
 * Своей копии этой логики здесь нет намеренно: две копии разошлись бы,
 * и разошлись бы молча — консольная установка продолжала бы работать,
 * а браузерная тихо отставала бы на одно исправление.
 *
 * Установщик добавляет ровно две вещи, которых у скрипта нет:
 *   • подготовку тех ключей infra/.env, которые install.sh не трогает
 *     (пределы размеров, квота, помощник ИИ) — через её же env_set;
 *   • показ хода работы в браузере.
 */
import { writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { LogBuffer } from './logbuf.js';
import { bashWithCommon, spawnStreaming } from './shell.js';
import { checkCustomCertificate, writeCustomCertificate } from './tls.js';
import { PORT_FIELDS, type Answers } from './validate.js';

export type RunPhase = 'idle' | 'running' | 'done' | 'failed';

export interface InstallState {
  phase: RunPhase;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  /** Причина отказа словами — то, что видит человек вместо кода. */
  failure: string;
}

/** Значение для файла ответов: он подключается через `.`, значит это bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildAnswersFile(answers: Answers): string {
  const lines: string[] = [
    '# Ответы мастера первого запуска Mail.True (веб-установщик).',
    '# Файл живёт несколько минут внутри контейнера установщика и стирается',
    '# сразу после установки: в нём пароль администратора.',
    `MAILTRUE_DOMAIN=${shellQuote(answers.domain)}`,
    `MAILTRUE_HOSTNAME=${shellQuote(answers.hostname)}`,
    `MAILTRUE_ADMIN_EMAIL=${shellQuote(answers.adminEmail)}`,
    `MAILTRUE_ADMIN_LOGIN=${shellQuote(answers.adminLogin)}`,
    `MAILTRUE_ADMIN_PASSWORD=${shellQuote(answers.adminPassword)}`,
    `MAILTRUE_CLAMAV=${answers.clamav ? 'yes' : 'no'}`,
    `MAILTRUE_LE_EMAIL=${shellQuote(answers.leEmail === '' ? answers.adminEmail : answers.leEmail)}`,
    `MAILTRUE_BIND_ADDRESS=${shellQuote(answers.bindAddress)}`,
  ];
  // Свой сертификат уже лежит в каталоге сертификатов (его положил
  // установщик после проверки), и отметка source говорит install.sh, что
  // он чужой. MAILTRUE_TLS при этом НЕ задаётся намеренно: заданный, он
  // означал бы «хочу именно этот способ» и перекрыл бы отметку — то есть
  // установщик выпустил бы Let's Encrypt поверх принесённого сертификата.
  if (answers.tls !== 'custom') {
    lines.push(`MAILTRUE_TLS=${shellQuote(answers.tls)}`);
  }
  // Порты: install.sh берёт их из MAILTRUE_*_PORT, а по умолчанию ставит
  // стандартные. Через мастер их меняют ровно затем, чтобы на одной машине
  // ужились два стенда.
  for (const field of PORT_FIELDS) {
    const value = answers.ports[field.key];
    if (value === undefined) continue;
    lines.push(`MAILTRUE_${field.envKey}=${String(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Ключи, которые install.sh не трогает, — их пишем сами, её же env_set. */
export function envAssignments(answers: Answers): Array<[string, string]> {
  return [
    ['AI_ENABLED', answers.aiEnabled ? 'true' : 'false'],
    ['MESSAGE_MAX_BYTES', String(answers.messageMaxBytes)],
    ['UPLOAD_MAX_BYTES', String(answers.uploadMaxBytes)],
    ['COMPOSE_BODY_MAX_BYTES', String(answers.composeBodyMaxBytes)],
    ['ADMIN_DEFAULT_QUOTA_BYTES', String(answers.defaultQuotaBytes)],
    ['DOCKER_SUBNET', answers.subnet],
    ['RESOLVER_IP', answers.resolverIp],
    ['DOVECOT_IP', answers.dovecotIp],
    // Порты служебных разделов, которых нет в списке install.sh.
    ['API_PORT', String(answers.ports.api ?? 3000)],
    ['RSPAMD_WEB_PORT', String(answers.ports.rspamd ?? 11334)],
  ];
}

export interface InstallContext {
  readonly repoDir: string;
  readonly projectName: string;
  readonly log: LogBuffer;
}

const ANSWERS_PATH = '/tmp/mailtrue-answers.env';

/**
 * Подготовить infra/.env: создать из образца, если его нет, и записать
 * ключи, которых install.sh не касается.
 *
 * Образец копируется через `tr -d '\r'` — ровно так же, как это делает
 * install.sh, и по той же причине: он однажды уже уехал в репозиторий с
 * концами строк Windows, и тогда POSTGRES_USER в скриптах превращался в
 * «mailserver» с невидимым хвостом, а psql отвечал «role does not exist»
 * при исправной базе.
 */
export async function prepareEnv(ctx: InstallContext, answers: Answers): Promise<void> {
  const sets = envAssignments(answers)
    .map(([key, value]) => `env_set ${key} ${shellQuote(value)}`)
    .join('\n');
  const result = await bashWithCommon(
    ctx.repoDir,
    `if [ ! -f "$ENV_FILE" ]; then
        [ -f "$ENV_EXAMPLE" ] || { echo "нет образца $ENV_EXAMPLE" >&2; exit 1; }
        tr -d '\\r' < "$ENV_EXAMPLE" > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "создан $ENV_FILE"
     fi
     env_set COMPOSE_PROJECT_NAME ${shellQuote(ctx.projectName)}
     ${sets}
     echo "настройки записаны в $ENV_FILE"`,
    { timeoutMs: 60_000 },
  );
  ctx.log.append(`${result.stdout}${result.stderr}`);
  if (result.code !== 0) {
    throw new Error(
      `Не удалось подготовить infra/.env: ${result.stderr.trim() || 'команда вернула ошибку'}`,
    );
  }
}

export interface Runner {
  readonly state: InstallState;
  start: (answers: Answers) => Promise<void>;
}

export function createRunner(ctx: InstallContext): Runner {
  const state: InstallState = {
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    failure: '',
  };

  async function start(answers: Answers): Promise<void> {
    state.phase = 'running';
    state.startedAt = Date.now();
    state.finishedAt = null;
    state.exitCode = null;
    state.failure = '';

    try {
      await prepareEnv(ctx, answers);
      if (answers.tls === 'custom') {
        // Сертификат кладётся ДО install.sh: она увидит готовые файлы и не
        // станет выпускать самоподписанный поверх. Проверка здесь та же,
        // что показывалась в мастере, — и она повторяется намеренно: между
        // показом и запуском поля могли поправить.
        const check = await checkCustomCertificate({
          certificate: answers.customCert,
          privateKey: answers.customKey,
          chain: answers.customChain,
          domain: answers.domain,
          hostname: answers.hostname,
        });
        if (!check.ok) {
          const first = check.issues.find((issue) => issue.level === 'fail');
          throw new Error(
            first === undefined
              ? 'Свой сертификат не прошёл проверку.'
              : `${first.title}. ${first.detail}`,
          );
        }
        await mkdir(`${ctx.repoDir}/infra/data/certs`, { recursive: true });
        await writeCustomCertificate(`${ctx.repoDir}/infra/data/certs`, check, answers.customKey);
        ctx.log.append(
          `\nсвой сертификат проверен и записан: ${check.certificate?.commonName ?? ''} ` +
            `(до ${check.certificate?.validTo.slice(0, 10) ?? '?'})\n`,
        );
      }
    } catch (err) {
      state.phase = 'failed';
      state.finishedAt = Date.now();
      state.failure = err instanceof Error ? err.message : String(err);
      ctx.log.append(`\n${state.failure}\n`);
      return;
    }

    await writeFile(ANSWERS_PATH, buildAnswersFile(answers), { mode: 0o600 });

    ctx.log.append(
      [
        '',
        '=== Запускается install/install.sh ===',
        'Дальше работает тот же установщик, что и в консоли, — с вашими ответами.',
        '',
        'Проверка занятости портов у него отключена (--skip-port-check) намеренно:',
        'он смотрит порты через ss, а изнутри контейнера ss видит только сеть',
        'контейнера и отвечал бы «свободно» всегда. Порты уже проверены на шаге',
        '«Проверка системы» — там вопрос задавался самому Docker.',
        '',
        'Первый запуск собирает образы почтового стека и веб-интерфейса.',
        'Это 5–15 минут, и всё это время окно можно не закрывать.',
        '',
      ].join('\n'),
    );

    const child = spawnStreaming(
      'bash',
      [
        `${ctx.repoDir}/install/install.sh`,
        '--answers',
        ANSWERS_PATH,
        '--non-interactive',
        '--yes',
        '--skip-docker-install',
        '--skip-port-check',
      ],
      {
        cwd: ctx.repoDir,
        env: {
          ...process.env,
          NO_COLOR: '1',
          HOME: '/root',
          // Попадёт в install_state.installed_by: «как этот сервер ставили».
          MT_INSTALL_SOURCE: 'installer',
          COMPOSE_PROJECT_NAME: ctx.projectName,
        },
      },
      (chunk) => ctx.log.append(chunk),
    );

    const code = await child.done;
    // Файл с паролем администратора не должен пережить установку.
    await rm(ANSWERS_PATH, { force: true });

    state.exitCode = code;
    state.finishedAt = Date.now();
    if (code === 0) {
      state.phase = 'done';
      return;
    }
    state.phase = 'failed';
    state.failure = explainFailure(ctx.log.tail(40), code);
    ctx.log.append(`\n${state.failure}\n`);
  }

  return { state, start };
}

/**
 * Отказ обязан называть причину, а не код возврата. Установщик печатает её
 * последней строкой («Ошибка: …»), поэтому ищем её, а не выдумываем свою.
 */
export function explainFailure(tail: readonly string[], code: number): string {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = (tail[i] ?? '').trim();
    if (line.startsWith('Ошибка:')) return line.replace(/^Ошибка:\s*/, '');
    if (line.includes('установка остановлена')) return line;
  }
  const lastMeaningful = [...tail].reverse().find((l) => l.trim() !== '');
  return (
    `Установка прервалась (код ${code}). Последнее, что она сказала: ` +
    `«${(lastMeaningful ?? '').trim()}». Полный журнал — выше; ` +
    'исправив причину, можно нажать «Повторить»: установщик идемпотентен и ' +
    'не переделывает уже сделанное.'
  );
}

export interface Summary {
  readonly webUrl: string;
  readonly adminUrl: string;
  readonly adminEmail: string;
  readonly adminLogin: string;
  readonly domain: string;
  readonly hostname: string;
  readonly dnsRecords: string;
  readonly certTimerHint: boolean;
  readonly tls: string;
}

/** Итог установки: адреса, DNS-записи и то, что осталось сделать руками. */
export async function readSummary(ctx: InstallContext, answers: Answers): Promise<Summary> {
  let dnsRecords = '';
  try {
    dnsRecords = await readFile(`${ctx.repoDir}/install/state/dns-records.txt`, 'utf8');
  } catch {
    dnsRecords = '';
  }
  return {
    webUrl: `https://mail.${answers.domain}`,
    adminUrl: `https://admin.${answers.domain}`,
    adminEmail: answers.adminEmail,
    adminLogin: answers.adminLogin,
    domain: answers.domain,
    hostname: answers.hostname,
    dnsRecords,
    // Таймер systemd живёт на хосте, а установщик — в контейнере. Это
    // единственное, что мастер договаривает словами вместо того, чтобы
    // сделать самому.
    certTimerHint: answers.tls === 'letsencrypt',
    tls: answers.tls,
  };
}
