/**
 * Раздел «Сертификат»: посмотреть, какой стоит сейчас, и поставить свой.
 *
 * ------------------------------------------------------------------
 * ПРАВИЛА ПРОВЕРКИ ЗДЕСЬ НЕ ЖИВУТ
 * ------------------------------------------------------------------
 * Они в packages/shared (tls-certificate.ts) — одни и те же для этого
 * раздела и для мастера первого запуска (apps/installer). Свой сертификат
 * ставят дважды: при установке и потом, когда старый истекает; проверять
 * это двумя наборами правил значит однажды пропустить в панели то, что
 * ловил мастер. Разошлись бы они молча.
 *
 * ------------------------------------------------------------------
 * ПРИВАТНЫЙ КЛЮЧ НАРУЖУ НЕ УХОДИТ НИКОГДА
 * ------------------------------------------------------------------
 * Ни в ответе (в GET его нет вовсе — только сведения о сертификате), ни в
 * журнале (в аудит пишется отпечаток, а не содержимое), ни в резервной
 * копии настроек (admin/backup-format.ts её состав не включает). Внутрь
 * он приходит один раз — телом запроса на замену — и сразу ложится в файл
 * с правами 600.
 *
 * ------------------------------------------------------------------
 * КАК ЗАМЕНА ДОХОДИТ ДО СЛУЖБ
 * ------------------------------------------------------------------
 * Сертификат нужен nginx, Postfix и Dovecot, и все трое читают его при
 * старте процесса. Раньше это означало `docker compose restart` с хоста —
 * из панели такую команду не отдать: сокета Docker у сервера приложения
 * нет и не будет, он равен правам root на всей машине.
 *
 * Поэтому службы следят за файлом сами (infra/nginx/watch-certs.sh и
 * entrypoint.sh почтовых служб) и перечитывают его в течение десяти
 * секунд после записи: nginx -s reload, postfix reload, doveadm reload.
 * Ни одна из этих команд не рвёт уже открытых соединений, но новые
 * почтовые сеансы в момент перезагрузки Postfix могут получить отказ —
 * об этом интерфейс предупреждает прямо, до нажатия.
 */
import { readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  expectedCertificateNames,
  validateCertificateBundle,
  type CertificateInfo,
  type TlsValidationResult,
} from '@mail-true/shared/tls-certificate';
import { BadRequestError } from '../../errors.js';
import {
  gradeRenewal,
  readCertificateSource,
  readRenewalReport,
  RENEW_COMMAND,
  RENEW_FORCE_COMMAND,
  RENEW_TIMER_COMMAND,
  SOURCE_LABELS,
} from '../cert-renewal.js';
import { audit, currentAdmin, requireAdmin } from '../guard.js';
import { ServiceAgentUnavailableError } from '../service-agent.js';

/**
 * Предел на тело запроса. Сертификат с цепочкой — это единицы килобайт;
 * сто отведено с запасом на самые длинные цепочки и на ключ RSA-8192.
 */
const MAX_PEM_BYTES = 100 * 1024;

const applySchema = z.object({
  certificate: z.string().min(1).max(MAX_PEM_BYTES),
  privateKey: z.string().min(1).max(MAX_PEM_BYTES),
  chain: z.string().max(MAX_PEM_BYTES).optional(),
  /**
   * Явное согласие. Замена перезапускает почтовые службы: без
   * подтверждения этого делать нельзя, даже если проверки прошли.
   */
  confirm: z.literal(true),
});

const checkSchema = applySchema.omit({ confirm: true });

/** Запрос на выпуск Let's Encrypt. */
const issueSchema = z.object({
  /** Адрес для писем Let's Encrypt об истечении срока. */
  email: z.string().trim().email('Адрес для уведомлений не похож на адрес'),
  /** Пробный выпуск испытательным центром — не тратит попытки настоящего. */
  staging: z.boolean().default(false),
  /**
   * Включать ли необязательные имена (autoconfig, autodiscover). По
   * умолчанию да: без них почтовые программы не находят автонастройку.
   * Но если запись ещё не создана, выпуск сорвётся целиком — тогда
   * человек снимает флажок и получает сертификат на главное.
   */
  includeOptional: z.boolean().default(true),
});

/**
 * Откуда взялся текущий сертификат (файл source рядом с ним) и как он
 * продлевается — оба вопроса разбирает admin/cert-renewal.ts. Здесь их
 * нет намеренно: те же сведения нужны разделу «Наблюдение», а два
 * маршрута, читающих один файл каждый по-своему, однажды разошлись бы в
 * ответе на вопрос «свой ли это сертификат» — и продление затёрло бы
 * чужой, потому что один из них считал иначе.
 */
export type { CertificateSource } from '../cert-renewal.js';

/** Сведения о сертификате без единого байта ключа. */
function toDto(info: CertificateInfo): Record<string, unknown> {
  return {
    commonName: info.commonName,
    subject: info.subject,
    issuer: info.issuer,
    names: info.names,
    validFrom: info.validFrom,
    validTo: info.validTo,
    daysLeft: info.daysLeft,
    serialNumber: info.serialNumber,
    fingerprint256: info.fingerprint256,
    selfSigned: info.selfSigned,
  };
}

function resultDto(result: TlsValidationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    issues: result.issues,
    certificate: result.certificate === null ? null : toDto(result.certificate),
    chain: result.chain.map(toDto),
    missingNames: result.missingNames,
  };
}

/**
 * Доверенные корни этой машины: их subject нужен, чтобы отличить
 * «цепочка полная» от «не хватает промежуточного». Читается один раз —
 * файл на полтораста сертификатов разбирается за десятки миллисекунд,
 * но делать это на каждый запрос незачем.
 */
let trustedRootsCache: ReadonlySet<string> | null = null;

async function trustedRootSubjects(): Promise<ReadonlySet<string> | undefined> {
  if (trustedRootsCache !== null) return trustedRootsCache;
  const candidates = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/ssl/cert.pem',
    '/etc/pki/tls/certs/ca-bundle.crt',
  ];
  for (const path of candidates) {
    try {
      await access(path);
      const text = await readFile(path, 'utf8');
      const { X509Certificate } = await import('node:crypto');
      const subjects = new Set<string>();
      for (const match of text.matchAll(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      )) {
        try {
          subjects.add(new X509Certificate(match[0]).subject);
        } catch {
          /* один нечитаемый корень не повод отказываться от остальных */
        }
      }
      if (subjects.size > 0) {
        trustedRootsCache = subjects;
        return trustedRootsCache;
      }
    } catch {
      /* пробуем следующий путь */
    }
  }
  // Хранилища доверенных корней нет — честно не отвечаем на вопрос
  // «доверяет ли этому центру мир», вместо того чтобы выдумать ответ.
  return undefined;
}

export async function adminTlsRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const dir = ctx.config.TLS_CERT_DIR;
  const certPath = join(dir, 'mail.crt');
  const keyPath = join(dir, 'mail.key');
  const sourcePath = join(dir, 'source');

  function names(): { required: string[]; optional: string[] } {
    return expectedCertificateNames(ctx.config.MAIL_DOMAIN, ctx.config.MAIL_HOSTNAME);
  }

  /**
   * Что стоит сейчас. Право на чтение — владельца, как у настроек сервера:
   * список имён в сертификате и срок его действия — это карта установки.
   */
  app.get('/tls', { preHandler: requireAdmin(app, 'serversettings.read') }, async () => {
    const expected = names();
    let current: TlsValidationResult | null = null;
    let unreadable = '';
    try {
      const [certificatePem, privateKeyPem] = await Promise.all([
        readFile(certPath, 'utf8'),
        readFile(keyPath, 'utf8'),
      ]);
      current = validateCertificateBundle({
        certificatePem,
        privateKeyPem,
        expectedNames: expected.required,
        optionalNames: expected.optional,
        ...(((await trustedRootSubjects()) ?? undefined) === undefined
          ? {}
          : { trustedRootSubjects: (await trustedRootSubjects()) as ReadonlySet<string> }),
      });
    } catch (err) {
      unreadable = err instanceof Error ? err.message : String(err);
    }

    const [source, renewal] = await Promise.all([
      readCertificateSource(dir),
      readRenewalReport(dir),
    ]);

    /*
     * Состояние автопродления едет тем же ответом, а не отдельным
     * маршрутом. Причина простая: на экране это один вопрос — «что стоит
     * и продлится ли оно само». Два запроса означали бы два разных
     * момента времени в одной таблице и мигание блока при обновлении.
     */
    return {
      source,
      sourceLabel: SOURCE_LABELS[source],
      expectedNames: expected.required,
      optionalNames: expected.optional,
      unreadable,
      current: current === null ? null : resultDto(current),
      renewal: {
        report: renewal.report,
        problem: renewal.problem,
        verdict: gradeRenewal(renewal, source),
        /*
         * Команды отдаются сервером, а не зашиты в интерфейс: путь к
         * скрипту знает сервер, и расхождение здесь означало бы
         * подсказку, которая никуда не ведёт.
         *
         * Кнопки «продлить сейчас» тут нет и быть не может — почему
         * именно, сказано в разделе «Сертификат» словами, на экране.
         */
        commands: {
          renew: RENEW_COMMAND,
          force: RENEW_FORCE_COMMAND,
          installTimer: RENEW_TIMER_COMMAND,
        },
      },
    };
  });

  /**
   * Проверка без применения. Отдельный шаг, а не «применим и посмотрим»:
   * неподходящая пара ключа и сертификата останавливает почту целиком,
   * и узнавать об этом после применения — слишком поздно.
   */
  app.post(
    '/tls/check',
    { preHandler: requireAdmin(app, 'serversettings.write') },
    async (request) => {
      const body = checkSchema.parse(request.body);
      const expected = names();
      const roots = await trustedRootSubjects();
      const result = validateCertificateBundle({
        certificatePem: body.certificate,
        privateKeyPem: body.privateKey,
        ...(body.chain === undefined ? {} : { chainPem: body.chain }),
        expectedNames: expected.required,
        optionalNames: expected.optional,
        ...(roots === undefined ? {} : { trustedRootSubjects: roots }),
      });
      return resultDto(result);
    },
  );

  /**
   * ВЫПУСТИТЬ LET'S ENCRYPT.
   *
   * Заказчик: «нет возможности заменить самоподписанный сертификат на
   * lets encrypt в интерфейсе». Верно: раздел умел показать срок и
   * принять СВОЙ сертификат, а выпустить бесплатный — нет, для этого шли
   * на сервер.
   *
   * Выпускает посредник: у сервера приложения нет доступа ни к Docker, ни
   * к /etc/letsencrypt, и не будет. Он же раскладывает файлы по стеку —
   * службы перечитывают их сами.
   *
   * Пробный выпуск (staging) существует ради ограничения Let's Encrypt:
   * пять неудач в час на домен. Проверить, что домен вообще указывает
   * сюда и 80-й порт доступен снаружи, дешевле испытательным центром —
   * его сертификат никуда не раскладывается.
   */
  app.post(
    '/tls/letsencrypt',
    { preHandler: requireAdmin(app, 'serversettings.write') },
    async (request) => {
      const body = issueSchema.parse(request.body);
      const agent = ctx.serviceAgent;
      if (!agent?.configured) {
        throw new ServiceAgentUnavailableError(
          'Выпуск из панели недоступен: не настроен посредник служб. На сервере это делает ' +
            'sudo bash install/renew-certs.sh --force',
        );
      }

      const expected = names();
      // Имена берём из настроек сервера, а не из запроса: сертификат должен
      // покрывать то, чем сервер представляется, а не то, что попросили.
      const domains = body.includeOptional
        ? [...expected.required, ...expected.optional]
        : [...expected.required];

      const result = await agent.issueLetsEncrypt({
        domains,
        email: body.email,
        staging: body.staging,
      });

      await audit(ctx, request, {
        action: 'tls.letsencrypt',
        targetType: 'settings',
        targetLabel: domains.join(', '),
        after: { staging: result.staging, certName: result.certName },
      });

      return {
        ok: true,
        staging: result.staging,
        domains,
        /** Хвост вывода certbot: по нему видно, что именно он сделал. */
        output: result.output,
        message: result.staging
          ? 'Пробный выпуск прошёл: домен подтверждается, порт 80 доступен снаружи. ' +
            'Испытательный сертификат никуда не установлен — повторите без пробного режима.'
          : 'Сертификат выпущен и разложен по стеку. Службы перечитают его в течение ' +
            'десяти секунд, перезапускать ничего не нужно.',
      };
    },
  );

  /** Применение: только после проверки и только с явным подтверждением. */
  app.post('/tls', { preHandler: requireAdmin(app, 'serversettings.write') }, async (request) => {
    const body = applySchema.parse(request.body);
    const expected = names();
    const roots = await trustedRootSubjects();
    const result = validateCertificateBundle({
      certificatePem: body.certificate,
      privateKeyPem: body.privateKey,
      ...(body.chain === undefined ? {} : { chainPem: body.chain }),
      expectedNames: expected.required,
      optionalNames: expected.optional,
      ...(roots === undefined ? {} : { trustedRootSubjects: roots }),
    });

    if (!result.ok) {
      // Отказ называет причину теми же словами, что показала проверка.
      const first = result.issues.find((issue) => issue.level === 'fail');
      throw new BadRequestError(
        first === undefined ? 'Сертификат не прошёл проверку.' : `${first.title}. ${first.detail}`,
      );
    }

    // Запись через временный файл и переименование: службы следят за
    // файлом и могут прочитать его в любой момент. Половина сертификата,
    // попавшая под чтение, означала бы остановку TLS на всех трёх сразу.
    const keyPem = result.fullchainPem === '' ? '' : body.privateKey.trim();
    const tmpCert = `${certPath}.new`;
    const tmpKey = `${keyPath}.new`;
    try {
      // Права задаются при СОЗДАНИИ файла; отдельного chmod поверх своего
      // же файла здесь нет намеренно. Он выглядит безобидно, но на каталоге,
      // примонтированном не с обычной файловой системы, отвечает EPERM — и
      // замена падала на нём, уже записав файл. Поймано живым прогоном.
      await writeFile(tmpCert, result.fullchainPem, { mode: 0o644 });
      await writeFile(tmpKey, `${keyPem}\n`, { mode: 0o600 });
      await rename(tmpKey, keyPath);
      await rename(tmpCert, certPath);
      await writeFile(sourcePath, 'custom\n', { mode: 0o644 });
    } catch (err) {
      // Недописанные файлы не должны пережить отказ: службы следят за
      // каталогом, и половина сертификата в нём — худший из исходов.
      await rm(tmpCert, { force: true }).catch(() => undefined);
      await rm(tmpKey, { force: true }).catch(() => undefined);
      throw new BadRequestError(
        'Не удалось записать сертификат в каталог сервера: ' +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Каталог infra/data/certs должен быть доступен серверу приложения на запись — ' +
          'это делает установщик (install/install.sh). Проверить: ' +
          'ls -ld infra/data/certs',
      );
    }

    // В аудит — отпечаток и имена. Ни байта ключа: журнал читают люди,
    // которым доступ к ключу не полагается, и он же уезжает в выгрузку.
    await audit(ctx, request, {
      action: 'tls.replace',
      targetType: 'serversettings',
      targetLabel: 'TLS-сертификат',
      after: {
        fingerprint256: result.certificate?.fingerprint256 ?? '',
        names: [...(result.certificate?.names ?? [])],
        validTo: result.certificate?.validTo ?? '',
        issuer: result.certificate?.issuer ?? '',
      },
    });
    app.log.info(
      {
        admin: currentAdmin(request).login,
        fingerprint: result.certificate?.fingerprint256 ?? '',
      },
      'заменён TLS-сертификат сервера',
    );

    return {
      ok: true,
      applied: resultDto(result),
      source: 'custom',
      /**
       * Обещание, которое интерфейс повторяет человеку: службы читают
       * файл в течение десяти секунд, а не мгновенно.
       */
      reloadSeconds: 10,
    };
  });
}
