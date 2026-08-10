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
import { readFile, writeFile, rename, rm, access, link, stat } from 'node:fs/promises';
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
   * Согласие заменить СВОЙ сертификат от удостоверяющего центра.
   *
   * Отдельное поле, а не общее «подтверждаю»: заменить самоподписанный
   * или прежний Let's Encrypt можно молча — терять там нечего. А вот
   * купленный сертификат уносит с собой приватный ключ, восстановимый
   * только из внешней копии, и такое подтверждают осознанно.
   */
  replaceCustom: z.boolean().default(false),
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

/** Куда ложится сертификат. Пути отдельным типом — ими же пользуется откат. */
export interface CertificatePaths {
  certPath: string;
  keyPath: string;
  sourcePath: string;
}

/** Итог замены: что удалось, а что пришлось возвращать назад. */
export interface CertificateInstallResult {
  /** Новая пара стоит на месте и source говорит «свой». */
  ok: boolean;
  /** Почему не получилось (человеческими словами, с состоянием на диске). */
  problem: string;
}

/**
 * Прежний файл, отложенный на время замены.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ НЕ СНИМОК В ПАМЯТЬ
 * ------------------------------------------------------------------
 * Раньше прежние файлы читались в память (`readIfExists`), а `catch`
 * возвращал `null` на ЛЮБОЙ отказ — и на «файла нет», и на «читать не
 * дают». Второе на штатной установке не исключение, а ПРАВИЛО: сервер
 * приложения работает под 5000:5000 (apps/api/Dockerfile), а закрытый
 * ключ создаётся с правами 600 и владельцем root — так делают и
 * install.sh, и renew-certs.sh, и посредник. То есть снимок ключа был
 * пуст ВСЕГДА.
 *
 * Дальше откат понимал пустой снимок как «файла и не было» и выполнял
 * `rm` — то есть на любом отказе последнего шага замены закрытый ключ
 * УДАЛЯЛСЯ. После этого не поднимаются ни nginx, ни Postfix, ни Dovecot:
 * ни HTTPS, ни IMAPS, ни submission, ни TLS на 25. А человеку при этом
 * отвечали «Прежний сертификат и ключ возвращены на место — почта
 * работает как раньше».
 *
 * Жёсткая ссылка решает обе беды разом: она не требует права ЧИТАТЬ
 * файл (нужно только право писать в каталог, а оно у сервера есть — им
 * же он кладёт новые файлы), и она не отбирает старые данные у
 * работающих служб: ссылка и оригинал — один и тот же файл, пока его не
 * заменит rename.
 */
interface Kept {
  path: string;
  /** Куда отложен прежний файл. null — отложить не удалось. */
  backup: string | null;
  /** Был ли файл на месте до замены. */
  existed: boolean;
}

/**
 * Откладывает прежний файл жёсткой ссылкой рядом.
 *
 * Отказ не останавливает замену: бывают тома, где жёстких ссылок нет.
 * Но он запоминается — и если замена сорвётся, человек услышит правду о
 * том, что вернуть прежний файл нечем, а не «всё на месте».
 */
async function keepPrevious(path: string): Promise<Kept> {
  const backup = `${path}.prev`;
  await rm(backup, { force: true }).catch(() => undefined);
  try {
    await stat(path);
  } catch {
    return { path, backup: null, existed: false };
  }
  try {
    await link(path, backup);
    return { path, backup, existed: true };
  } catch {
    return { path, backup: null, existed: true };
  }
}

/** Атомарная запись: временный файл рядом плюс переименование. */
async function writeAtomic(path: string, data: Buffer | string, mode: number): Promise<void> {
  const tmp = `${path}.new`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

/**
 * ЗАМЕНА СЕРТИФИКАТА ЦЕЛИКОМ ИЛИ НИКАК.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО СЛОМАНО
 * ------------------------------------------------------------------
 * Замена состояла из четырёх записей подряд без единого отката:
 * два временных файла, rename ключа, rename сертификата, запись source.
 * Отказ ЛЮБОЙ из последних трёх оставлял каталог в состоянии, из которого
 * выйти было уже нечем:
 *
 *   * ключ переименован, сертификат — нет. На диске несходящаяся пара:
 *     старый ключ безвозвратно перезаписан новым, а сертификат остался
 *     прежним. Службы перечитывают каталог в течение десяти секунд
 *     (infra/nginx/watch-certs.sh) и TLS падает РАЗОМ у nginx, Postfix и
 *     Dovecot — то есть перестают работать и панель, и почта. При этом
 *     ответ гласил «Не удалось записать сертификат в каталог сервера», то
 *     есть «ничего не произошло», и человек шёл проверять права каталога,
 *     а не поднимать почту;
 *
 *   * пара заменена, а source не записан. В файле остаётся letsencrypt,
 *     и автопродление (cert-renewal.ts судит именно по этому файлу)
 *     затирает только что поставленный свой сертификат — молча, ночью,
 *     руками certbot.
 *
 * ------------------------------------------------------------------
 * КАК СДЕЛАНО
 * ------------------------------------------------------------------
 * 1. Прежние файлы откладываются ЖЁСТКОЙ ССЫЛКОЙ рядом ДО первой записи
 *    (см. keepPrevious). Не копией в память: закрытый ключ серверу
 *    приложения не читается вовсе, и «снимок» его всегда был пуст.
 * 2. source пишется ПЕРВЫМ. Порядок выбран по тому, что останется после
 *    жёсткой смерти процесса (её никаким try/catch не поймать): «source
 *    говорит свой, а сертификат ещё старый» означает пропущенное
 *    продление — это видно в разделе «Сертификат» и лечится за минуту;
 *    обратный порядок означал бы затёртый автопродлением свой сертификат.
 * 3. Ключ и сертификат — двумя переименованиями подряд. Данные к этому
 *    моменту уже на диске, поэтому между ними только два системных
 *    вызова: окно, в которое может попасть чтение служб, — микросекунды.
 *    Само окно закрыто не порядком переименований (сторожа считают хеш по
 *    ОБОИМ файлам, так что порядок им безразличен), а тем, что сторож
 *    перечитывает пару только после двух одинаковых замеров подряд —
 *    см. infra/nginx/watch-certs.sh и точки входа Postfix и Dovecot.
 * 4. Любой отказ — откат к снимку. И ответ говорит ровно то, что вышло:
 *    вернулись ли файлы на место. Если откат не удался, человек обязан
 *    узнать, что почта СЕЙЧАС не работает, а не искать права каталога.
 */
export async function installCertificateFiles(
  paths: CertificatePaths,
  input: { fullchainPem: string; privateKeyPem: string },
): Promise<CertificateInstallResult> {
  const { certPath, keyPath, sourcePath } = paths;
  const kept = {
    cert: await keepPrevious(certPath),
    key: await keepPrevious(keyPath),
    source: await keepPrevious(sourcePath),
  };

  /** Докуда дошли — по этому строится и откат, и объяснение. */
  let stage: 'nothing' | 'source' | 'key' | 'done' = 'nothing';
  try {
    await writeAtomic(sourcePath, 'custom\n', 0o644);
    stage = 'source';
    // Права задаются при СОЗДАНИИ файла; отдельного chmod поверх своего
    // же файла здесь нет намеренно. Он выглядит безобидно, но на каталоге,
    // примонтированном не с обычной файловой системы, отвечает EPERM — и
    // замена падала на нём, уже записав файл. Поймано живым прогоном.
    await writeFile(`${certPath}.new`, input.fullchainPem, { mode: 0o644 });
    await writeFile(`${keyPath}.new`, `${input.privateKeyPem}\n`, { mode: 0o600 });
    await rename(`${keyPath}.new`, keyPath);
    stage = 'key';
    await rename(`${certPath}.new`, certPath);
    stage = 'done';
    // Замена удалась — отложенные копии больше не нужны.
    for (const item of [kept.cert, kept.key, kept.source]) {
      if (item.backup) await rm(item.backup, { force: true }).catch(() => undefined);
    }
    return { ok: true, problem: '' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Недописанные файлы не должны пережить отказ: службы следят за
    // каталогом, и половина сертификата в нём — худший из исходов.
    await rm(`${certPath}.new`, { force: true }).catch(() => undefined);
    await rm(`${keyPath}.new`, { force: true }).catch(() => undefined);

    const notRestored: string[] = [];
    /*
     * Возврат прежнего файла — ТОЛЬКО из отложенной копии.
     *
     * Удалять то, что лежало здесь до нас, нельзя ни при каких условиях:
     * это и есть та ошибка, из-за которой закрытый ключ пропадал
     * насовсем. `rm` остаётся ровно для одного случая — файла не было, а
     * мы его создали.
     */
    const restore = async (item: Kept): Promise<void> => {
      try {
        if (!item.existed) {
          await rm(item.path, { force: true });
          return;
        }
        if (item.backup === null) {
          notRestored.push(item.path);
          return;
        }
        await rename(item.backup, item.path);
      } catch {
        notRestored.push(item.path);
      }
    };
    if (stage !== 'nothing') await restore(kept.source);
    if (stage === 'key' || stage === 'done') await restore(kept.key);
    if (stage === 'done') await restore(kept.cert);
    // Отложенные копии тех файлов, до которых замена не дошла, тоже
    // убираем: каталог сторожат службы, и лишний .prev им ни к чему.
    for (const item of [kept.cert, kept.key, kept.source]) {
      if (item.backup) await rm(item.backup, { force: true }).catch(() => undefined);
    }

    if (notRestored.length > 0) {
      return {
        ok: false,
        problem:
          `Замена оборвалась (${reason}), и вернуть прежние файлы не удалось: ` +
          `${notRestored.join(', ')}. TLS сейчас может не работать НИ У ОДНОЙ службы — ` +
          'ни у почты, ни у панели. Восстановите пару из резервной копии на сервере ' +
          '(каталог infra/data/certs) или выпустите сертификат заново: ' +
          `${RENEW_FORCE_COMMAND}`,
      };
    }
    return {
      ok: false,
      problem:
        `Не удалось записать сертификат в каталог сервера: ${reason}. Прежний сертификат ` +
        'и ключ возвращены на место — почта работает как раньше. Каталог infra/data/certs ' +
        'должен быть доступен серверу приложения на запись — это делает установщик ' +
        '(install/install.sh). Проверить: ls -ld infra/data/certs',
    };
  }
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
      /*
       * СЕРТИФИКАТ И КЛЮЧ ЧИТАЮТСЯ РАЗДЕЛЬНО.
       *
       * Раньше их брал один Promise.all в одном try, и любая ошибка гасила
       * весь разбор. А ключ на штатной установке недоступен: и установщик,
       * и продление Let's Encrypt кладут его с правами только для
       * владельца-root, тогда как сервер приложения работает под другим
       * пользователем. То есть на настоящем сервере раздел «Сертификат»
       * не показывал НИЧЕГО — ни срока, ни имён, ни разбора, — а вместо
       * этого писал «EACCES: permission denied».
       *
       * Проверено живой проверкой на стенде: ответ содержал ровно
       * `unreadable: EACCES … mail.key` и `current: null`.
       *
       * В разработке это не видно: там сертификат обычно ставили ИЗ
       * панели, и файл создавал сам сервер.
       *
       * Ключ нужен ровно одной проверке — «пара сходится». Нет ключа —
       * будет предупреждение об этом, остальное покажем.
       */
      const certificatePem = await readFile(certPath, 'utf8');
      const privateKeyPem = await readFile(keyPath, 'utf8').catch(() => undefined);
      current = validateCertificateBundle({
        certificatePem,
        ...(privateKeyPem === undefined ? {} : { privateKeyPem }),
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
        /*
         * Срок фактического сертификата передаётся оценке: у своего
         * сертификата автопродления нет, и «в порядке» на кончившемся
         * вчера — это зелёная строка о неработающем TLS.
         */
        verdict: gradeRenewal(renewal, source, Date.now(), current?.certificate?.daysLeft ?? null),
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

      /*
       * Свой сертификат не затирается без явного согласия.
       *
       * ------------------------------------------------------------------
       * ЧТО БЫЛО
       * ------------------------------------------------------------------
       * Выпуск Let's Encrypt раскладывает по стеку новый ключ и новый
       * сертификат поверх старых. Если там лежал купленный у
       * удостоверяющего центра — его приватный ключ пропадал безвозвратно,
       * восстановить можно было только из внешней копии.
       *
       * Консольный путь этот случай закрывает давно: renew-certs.sh
       * отказывается работать при source=custom и требует
       * MT_REPLACE_CUSTOM_CERT=1. Панель шла мимо этой защиты — и на той же
       * странице сама советовала эту переменную. Кнопка при этом стояла
       * рядом, без подтверждения: одно нажатие «Выпустить и установить»
       * поверх купленного сертификата.
       *
       * Пробный выпуск (staging) безопасен — его сертификат никуда не
       * раскладывается, поэтому его не трогаем.
       */
      if (!body.staging) {
        const installed = await readCertificateSource(ctx.config.TLS_CERT_DIR);
        if (installed === 'custom' && !body.replaceCustom) {
          throw new BadRequestError(
            'Сейчас установлен свой сертификат от удостоверяющего центра. Выпуск Let’s ' +
              'Encrypt заменит его вместе с приватным ключом, и вернуть прежний можно будет ' +
              'только из своей копии. Если это и нужно — подтвердите замену.',
          );
        }
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
            'десяти секунд, перезапускать ничего не нужно. ' +
            /*
             * ПРО ПРОДЛЕНИЕ ГОВОРИМ СРАЗУ.
             *
             * Выпуск из панели раскладывает файлы и ставит отметку
             * «letsencrypt», но НЕ заводит ни таймера продления, ни
             * отчёта: это умеет только install/renew-certs.sh на самой
             * машине. Раньше ответ обещал «перезапускать ничего не
             * нужно» и молчал об этом, а человек узнавал случайно —
             * жёлтой строкой «Отчёта о продлении на сервере нет» в
             * другом блоке, недели спустя. Сертификат Let's Encrypt
             * живёт 90 дней, и молчание здесь стоит ровно этих дней.
             */
            'Автопродление при этом НЕ включилось: его ставят на самой машине, одной ' +
            `командой — ${RENEW_TIMER_COMMAND}. Без неё сертификат придётся выпускать ` +
            'заново вручную каждые 90 дней.',
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

    // Запись через временный файл и переименование, с откатом к прежней
    // паре на любом отказе: службы следят за файлом и могут прочитать его
    // в любой момент. Несходящаяся пара, попавшая под чтение, означала бы
    // остановку TLS на всех трёх сразу (см. installCertificateFiles).
    /*
     * На диск идёт ПРОВЕРЕННЫЙ блок, а не весь вставленный текст.
     *
     * Проверка разбирает первый блок PRIVATE KEY, а записывалось всё,
     * что вставили: заголовки Bag Attributes от `openssl pkcs12`, второй
     * (старый) ключ, посторонний текст. Проверяли одно, записывали
     * другое — и при двух ключах в файле службы могли взять не тот.
     */
    const keyPem = result.privateKeyPem;
    const outcome = await installCertificateFiles(
      { certPath, keyPath, sourcePath },
      { fullchainPem: result.fullchainPem, privateKeyPem: keyPem },
    );
    if (!outcome.ok) throw new BadRequestError(outcome.problem);

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
