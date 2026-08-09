/**
 * Смена домена: составление плана и выполнение.
 *
 * ==================================================================
 * ГДЕ ЗДЕСЬ ТОЧКА НЕВОЗВРАТА
 * ==================================================================
 * Шаги идут так:
 *
 *   1 копия настроек   ─┐
 *   2 проверки          ├─ ничего не изменено; отказ на любом из них
 *   3 новый домен      ─┘  оставляет сервер ровно таким, каким он был
 *   ──────────────── ТОЧКА НЕВОЗВРАТА ────────────────
 *   4 перенос писем       переименование каталогов
 *   5 адреса в базе       одна транзакция
 *   6 проверка
 *
 * Между 4 и 5 откат ещё возможен и делается автоматически: если запись в
 * базу сорвалась, каталоги возвращаются на место, и сервер продолжает
 * работать со старым доменом. Именно поэтому переименование идёт ПЕРЕД
 * транзакцией, а не после: обратное переименование каталога — операция,
 * которая почти не может не получиться, а откат зафиксированной
 * транзакции невозможен вовсе.
 *
 * После шага 5 возврата нет, и панель говорит это прямо. Причина не в
 * технике — обратную замену адресов написать можно, — а в том, что за
 * секунды после переключения на новые адреса уже приходит почта, люди
 * входят под новыми именами, а внешние серверы запоминают новый MX.
 * «Откат», который вернёт адреса, но потеряет пришедшее в промежутке,
 * хуже честного «назад нельзя».
 *
 * ==================================================================
 * ЧТО ДЕЛАЕТ ПАНЕЛЬ И ЧЕГО ОНА НЕ МОЖЕТ
 * ==================================================================
 * Панель делает всё, что живёт в БАЗЕ и в ТОМЕ ПИСЕМ: адреса, алиасы,
 * настройки людей, каталоги почты и индексов, выпуск ключа DKIM. Этого
 * достаточно, чтобы почта на новый домен пошла сразу же — карты Postfix
 * и запросы Dovecot читаются прямо из базы, никакой перезагрузки
 * конфигурации им не нужно.
 *
 * Панель НЕ МОЖЕТ поменять то, что лежит внутри чужих контейнеров:
 * ключ DKIM в томе rspamd, server_name в nginx, MAIL_DOMAIN у сервиса
 * автонастройки, TLS-сертификаты. Для этого нужен сокет Docker, а он
 * равен правам root на всей машине — эта цена в продукте сознательно не
 * платится (см. пояснения к посреднику очереди в infra/postfix). Поэтому
 * четвёртая часть работы делается скриптом на сервере, и план говорит об
 * этом словами, а не умалчивает.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AdminContext } from './types.js';
import { exportSettings } from './backup-store.js';
import { buildDkimRecord, buildDmarcRecord, buildSpfRecord, checkDomainDns } from './dns.js';
import { dkimRecordName, generateDkimKeyPair } from './dkim-keygen.js';
import {
  breaksOf,
  estimateDowntime,
  hostnameForDomain,
  KEPT_ADDRESS_PLACES,
  manualStepsOf,
  normalizeDomain,
  type DnsRecordToPublish,
  type DomainChangeBlocker,
  type DomainChangePlan,
} from './domain-change.js';
import {
  checkSpace,
  crossDeviceBlocker,
  isRenameOnly,
  measureDomainStorage,
  moveDomainDirectories,
  rollbackMoves,
} from './domain-change-files.js';
import {
  countAddressRows,
  countDomainObjects,
  countFreeTextHits,
  collectBlockers,
  createTargetDomain,
  dropTargetDomain,
  domainIdOf,
  liveJobBlockers,
  rewriteAddresses,
} from './domain-change-store.js';
import {
  claimJob,
  finishJob,
  clearPointOfNoReturn,
  markPointOfNoReturn,
  saveBackup,
  saveSteps,
  touchJob,
  type DomainChangeStep,
} from './domain-change-jobs.js';

/* ================================================================== */
/* План                                                               */
/* ================================================================== */

export interface PlanInput {
  newDomain: string;
  /** Ключ DKIM: у уже созданного задания берётся его, иначе выпускается новый. */
  dkim?: { selector: string; publicKey: string };
  /** Спрашивать ли DNS. На повторных показах плана — да, это дёшево. */
  checkDns?: boolean;
}

/**
 * Собирает план. НИЧЕГО не меняет — ни строки в базе, ни файла на диске.
 *
 * Именно поэтому план можно пересчитывать сколько угодно раз, в том числе
 * перед самым запуском: он всегда описывает сервер таким, каков он сейчас,
 * а не каким был в момент первого нажатия.
 */
export async function buildDomainChangePlan(
  ctx: AdminContext,
  input: PlanInput,
): Promise<{
  plan: DomainChangePlan;
  dkim: { selector: string; publicKey: string; privatePem?: string };
}> {
  const oldDomain = normalizeDomain(ctx.config.MAIL_DOMAIN);
  const newDomain = normalizeDomain(input.newDomain);
  const oldHostname = normalizeDomain(ctx.config.MAIL_HOSTNAME);
  const newHostname = hostnameForDomain(oldDomain, oldHostname, newDomain);
  const selector = input.dkim?.selector ?? 'mail';

  const keys =
    input.dkim !== undefined
      ? { selector, publicKey: input.dkim.publicKey }
      : (() => {
          const pair = generateDkimKeyPair();
          return { selector, publicKey: pair.publicKey, privatePem: pair.privatePem };
        })();

  const [objects, tables, freeText, storage, blockers] = await Promise.all([
    countDomainObjects(ctx.db, oldDomain),
    countAddressRows(ctx.db, oldDomain),
    countFreeTextHits(ctx.db, oldDomain),
    measureDomainStorage(ctx.config.ADMIN_MAIL_ROOT, ctx.config.ADMIN_MAIL_INDEX_ROOT, oldDomain),
    collectBlockers(ctx.db, oldDomain, newDomain),
  ]);

  const renameOnly = await isRenameOnly(ctx.config.ADMIN_MAIL_ROOT, oldDomain);
  const space = await checkSpace(ctx.config.ADMIN_MAIL_ROOT, renameOnly);
  /*
   * Разные устройства — ПРЕПЯТСТВИЕ, а не предупреждение.
   *
   * Раньше здесь было предупреждение «письма придётся копировать, простой
   * будет дольше расчётного»: план проходил, человек соглашался, а
   * копирования в продукте нет ни строки — смена домена падала EXDEV уже
   * ПОСЛЕ точки невозврата. Пусть лучше кнопка не нажимается, чем нажатие
   * оставляет сервер в состоянии, из которого панель не умеет выйти.
   */
  const crossDevice = crossDeviceBlocker(renameOnly, ctx.config.ADMIN_MAIL_ROOT, oldDomain);
  if (crossDevice) blockers.push(crossDevice);
  if (!space.ok) {
    blockers.push({
      id: 'no-space',
      message:
        `На томе писем свободно ${formatBytes(space.freeBytes)}, а начинать можно от ` +
        `${formatBytes(space.requiredBytes)}.`,
      fix:
        'Освободите место: раздел «Ресурсы» показывает, что именно его занимает — письма, ' +
        'индексы поиска или журналы. Смена домена на полном диске оборвётся посередине.',
    });
  }

  const rows = tables.reduce((sum, t) => sum + t.rows, 0);
  const counts = {
    mailboxes: objects.mailboxes,
    aliases: objects.aliases,
    disposableAliases: objects.disposableAliases,
    messages: storage.messages,
    bytes: storage.bytes,
    rows,
    tables,
    freeTextHits: freeText,
  };

  const dnsToPublish = dnsRecordsToPublish({
    newDomain,
    newHostname,
    selector,
    publicKey: keys.publicKey,
  });

  let dnsReady = false;
  let dnsSummary = 'Записи нового домена не проверялись.';
  if (input.checkDns !== false) {
    const report = await checkDomainDns(newDomain, {
      mailHostname: newHostname,
      publicIpv4: ctx.config.MAIL_PUBLIC_IPV4,
      dkimSelector: selector,
      dkimPublicKey: keys.publicKey,
      imapsPort: ctx.config.IMAPS_PORT,
      submissionPort: ctx.config.SUBMISSION_PORT,
      pop3sPort: ctx.config.POP3S_PORT,
      servers: resolversOf(ctx),
      // Предел ожидания короче обычного намеренно: план человек ждёт,
      // глядя на экран, а «записи ещё не видны» — совершенно нормальный
      // ответ на этом шаге, ради которого не стоит держать его минуту.
      timeoutMs: 2500,
      only: ['mx', 'dkim', 'spf', 'dmarc'],
    });
    const bad = report.checks.filter((c) => c.required && c.status !== 'ok');
    dnsReady = report.resolver.reachable && bad.length === 0;
    dnsSummary = !report.resolver.reachable
      ? 'Спросить DNS не удалось — ни один резольвер не ответил. Проверить готовность записей нечем.'
      : bad.length === 0
        ? `Записи ${newDomain} видны снаружи: MX, SPF, DKIM и DMARC на месте.`
        : `Ещё не видны снаружи: ${bad.map((c) => c.title).join(', ')}. ` +
          'DNS расходится по интернету часами — опубликуйте записи и подождите.';
    if (!dnsReady) {
      /*
       * Не блокировка, а предупреждение — и это осознанный выбор. Записи
       * нового домена бывают опубликованы у регистратора, но ещё не
       * разошлись; бывает и так, что зона обслуживается внутренним DNS,
       * которого публичные резольверы не видят вовсе. Запретить смену
       * домена в этих случаях значило бы поставить панель выше человека,
       * который лучше знает свою зону. Предупредить — обязательно.
       */
    }
  }

  const warnings: string[] = [];
  if (storage.withoutAccounting > 0) {
    warnings.push(
      `${String(storage.withoutAccounting)} ящик(ов) не имеют файла учёта Dovecot — их объём ` +
        'в оценке не учтён. На перенос это не влияет: переезжает каталог целиком.',
    );
  }
  if (!storage.present && objects.mailboxes > 0) {
    warnings.push(
      `Каталог ${storage.path} не виден из контейнера api, хотя в базе ${String(objects.mailboxes)} ` +
        'ящик(ов). Письма переехать не смогут — проверьте, что том писем примонтирован.',
    );
  }
  if (objects.filters > 0) {
    warnings.push(
      `В ${String(objects.filters)} фильтр(ах) встречается старый домен (условия или пересылка). ` +
        'Они продолжат работать: старые адреса принимаются и после смены. Проверьте их, когда ' +
        'решите отпустить старый домен.',
    );
  }
  if (objects.disposableAliases > 0) {
    warnings.push(
      `${String(objects.disposableAliases)} одноразовых адреса(ов) переедут вместе со всеми, ` +
        'и прежние их варианты продолжат приниматься.',
    );
  }
  const plan: DomainChangePlan = {
    createdAt: new Date().toISOString(),
    oldDomain,
    newDomain,
    oldHostname,
    newHostname,
    counts,
    space: {
      path: space.path,
      freeBytes: space.freeBytes,
      totalBytes: space.totalBytes,
      requiredBytes: space.requiredBytes,
      renameOnly: space.renameOnly,
      ok: space.ok,
    },
    dkim: {
      selector,
      recordName: dkimRecordName(selector, newDomain),
      publicKey: keys.publicKey,
      record: buildDkimRecord(keys.publicKey),
    },
    dnsToPublish,
    dnsReady,
    dnsSummary,
    blockers,
    breaks: breaksOf(oldDomain, newDomain, objects.mailboxes),
    manual: manualStepsOf(newDomain, newHostname),
    keeps: KEPT_ADDRESS_PLACES,
    downtimeSeconds: estimateDowntime(counts),
    warnings,
  };

  return { plan, dkim: keys };
}

function resolversOf(ctx: AdminContext): string[] | undefined {
  const list = ctx.config.DNS_CHECK_RESOLVERS.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return list.length > 0 ? list : undefined;
}

/** Записи, которые надо опубликовать ДО начала. */
export function dnsRecordsToPublish(input: {
  newDomain: string;
  newHostname: string;
  selector: string;
  publicKey: string;
}): DnsRecordToPublish[] {
  return [
    {
      name: input.newDomain,
      type: 'MX',
      value: `10 ${input.newHostname}.`,
      required: true,
      why: 'Без неё чужие серверы не узнают, куда нести почту для нового домена.',
    },
    {
      name: input.newDomain,
      type: 'TXT',
      value: buildSpfRecord(input.newHostname),
      required: true,
      why: 'Разрешает нашему серверу отправлять от имени нового домена. Без неё письма уйдут в спам.',
    },
    {
      name: dkimRecordName(input.selector, input.newDomain),
      type: 'TXT',
      value: buildDkimRecord(input.publicKey),
      required: true,
      why:
        'Публичный ключ подписи. Выпущен только что и нигде больше не существует: ' +
        'опубликуйте его ДО смены домена — DNS расходится по интернету часами, ' +
        'а подписывать письма сервер начнёт сразу.',
    },
    {
      name: `_dmarc.${input.newDomain}`,
      type: 'TXT',
      value: buildDmarcRecord(input.newDomain),
      required: false,
      why: 'Что делать чужому серверу с письмом, не прошедшим проверку, и куда слать отчёты.',
    },
    {
      name: input.newHostname,
      type: 'A',
      value: 'адрес этого сервера',
      required: true,
      why: 'Имя из записи MX должно вести на сервер, иначе почту некуда доставлять.',
    },
    {
      name: `autoconfig.${input.newDomain}`,
      type: 'CNAME',
      value: `${input.newHostname}.`,
      required: false,
      why: 'Автонастройка почтовых программ. Без неё людям придётся вводить серверы руками.',
    },
    {
      name: `admin.${input.newDomain}`,
      type: 'CNAME',
      value: `${input.newHostname}.`,
      required: false,
      why: 'Панель управления по новому имени.',
    },
  ];
}

/* ================================================================== */
/* Выполнение                                                         */
/* ================================================================== */

export interface DomainChangeRunnerOptions {
  ctx: AdminContext;
  logger: Logger;
  /** Куда класть резервную копию настроек перед началом. */
  backupDir: string;
}

export class DomainChangeRunner {
  readonly #id = randomUUID().slice(0, 32);
  #running: Promise<void> | null = null;

  constructor(private readonly opts: DomainChangeRunnerOptions) {}

  /** Идёт ли смена домена прямо сейчас в этом процессе. */
  get busy(): boolean {
    return this.#running !== null;
  }

  /**
   * Разбирает задание, брошенное упавшим процессом.
   *
   * Продолжить его нельзя: неизвестно, на каком шаге всё оборвалось, а
   * повторить переименование каталога вслепую — верный способ смешать
   * два хранилища. Поэтому задание помечается сорвавшимся, и человек
   * получает не «висит вечно», а текст с указанием, где смотреть.
   */
  async recoverAbandoned(): Promise<void> {
    const db = this.opts.ctx.db;
    const rows = await db.query<{ id: string; passed: boolean }>(
      `SELECT id::text AS id, point_of_no_return_at IS NOT NULL AS passed
         FROM domain_change_jobs
        WHERE state = 'running'
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '5 minutes')`,
    );
    for (const row of rows) {
      await finishJob(db, Number(row.id), {
        state: 'failed',
        error: row.passed
          ? 'Сервер приложения перезапустился уже ПОСЛЕ начала переноса. Проверьте раздел ' +
            '«Ящики»: если адреса уже в новом домене, смена состоялась и осталось выполнить ' +
            'шаг на сервере (infra/scripts/change-domain.sh). Если адреса прежние — ' +
            'проверьте каталог писем и повторите смену.'
          : 'Сервер приложения перезапустился до начала переноса. Ничего не изменилось — ' +
            'составьте план заново.',
      });
      this.opts.logger.warn(
        { jobId: row.id, passedPointOfNoReturn: row.passed },
        'Брошенное задание смены домена помечено сорвавшимся',
      );
    }
  }

  /** Запускает задание в фоне. Ответ маршрута его не ждёт. */
  start(jobId: number): void {
    if (this.#running !== null) return;
    this.#running = this.#run(jobId)
      .catch((err: unknown) => {
        this.opts.logger.error({ err, jobId }, 'Смена домена сорвалась');
      })
      .finally(() => {
        this.#running = null;
      });
  }

  /** Дождаться окончания — для корректной остановки и для проверок. */
  async drain(): Promise<void> {
    await this.#running;
  }

  async #run(jobId: number): Promise<void> {
    const { ctx, logger } = this.opts;
    const db = ctx.db;

    const job = await claimJob(db, jobId, this.#id);
    if (!job) return;

    const steps = job.steps.length > 0 ? [...job.steps] : [];
    const flush = async (): Promise<void> => {
      await saveSteps(db, jobId, steps).catch(() => undefined);
    };
    const beat = setInterval(() => {
      void touchJob(db, jobId, this.#id).catch(() => undefined);
    }, 5000);
    beat.unref();

    const step = (id: string): DomainChangeStep => {
      const found = steps.find((s) => s.id === id);
      if (!found) throw new Error(`Неизвестный шаг ${id}`);
      return found;
    };
    const begin = async (id: string): Promise<DomainChangeStep> => {
      const s = step(id);
      s.state = 'running';
      s.startedAt = new Date().toISOString();
      await flush();
      return s;
    };
    const done = async (s: DomainChangeStep, detail: string): Promise<void> => {
      s.state = 'ok';
      s.detail = detail;
      s.finishedAt = new Date().toISOString();
      await flush();
    };

    /** Отказ на шаге. Текст уходит и в шаг, и в само задание. */
    class StepFailure extends Error {
      constructor(
        readonly step: DomainChangeStep,
        message: string,
      ) {
        super(message);
      }
    }

    try {
      /* --- 1. Резервная копия настроек --------------------------- */
      const backupStep = await begin('backup');
      const file = await exportSettings(db, ctx.branding, {
        hostname: job.oldHostname,
        domain: job.oldDomain,
      });
      await mkdir(this.opts.backupDir, { recursive: true });
      const backupPath = join(
        this.opts.backupDir,
        `before-domain-change-${String(jobId)}-${job.oldDomain}.json`,
      );
      const body = `${JSON.stringify(file, null, 2)}\n`;
      await writeFile(backupPath, body, { mode: 0o600 });
      const size = (await stat(backupPath)).size;
      await saveBackup(db, jobId, backupPath, size);
      await done(
        backupStep,
        `${backupPath} (${formatBytes(size)}). Внутри хэши паролей — файл секретный.`,
      );

      /* --- 2. Повторная проверка условий ------------------------- */
      const checkStep = await begin('checks');
      const blockers: DomainChangeBlocker[] = (await liveJobBlockers(db)).filter(
        (b) => b.id !== 'change-running',
      );
      const storage = await measureDomainStorage(
        ctx.config.ADMIN_MAIL_ROOT,
        ctx.config.ADMIN_MAIL_INDEX_ROOT,
        job.oldDomain,
      );
      const renameOnly = await isRenameOnly(ctx.config.ADMIN_MAIL_ROOT, job.oldDomain);
      const space = await checkSpace(ctx.config.ADMIN_MAIL_ROOT, renameOnly);
      // Тома могли переставить между планом и запуском — спрашиваем заново,
      // и обязательно ДО точки невозврата (шаг 4).
      const crossDevice = crossDeviceBlocker(renameOnly, ctx.config.ADMIN_MAIL_ROOT, job.oldDomain);
      if (crossDevice) blockers.push(crossDevice);
      if (!space.ok) {
        blockers.push({
          id: 'no-space',
          message: `Свободно ${formatBytes(space.freeBytes)}, нужно ${formatBytes(space.requiredBytes)}.`,
          fix: 'Освободите место и повторите.',
        });
      }
      if (blockers.length > 0) {
        throw new StepFailure(
          checkStep,
          `Условия изменились с момента показа плана: ${blockers
            .map((b) => b.message)
            .join(' ')} Ничего не тронуто.`,
        );
      }
      await done(
        checkStep,
        `Свободно ${formatBytes(space.freeBytes)}; чужих заданий, пишущих в ящики, нет.`,
      );

      /* --- 3. Новый домен и ключ DKIM ---------------------------- */
      const domainStep = await begin('domain');
      const oldDomainId = await domainIdOf(db, job.oldDomain);
      if (oldDomainId === null) {
        throw new StepFailure(
          domainStep,
          `Домен ${job.oldDomain} исчез из базы между планом и запуском. Ничего не тронуто.`,
        );
      }
      const newDomainId = await createTargetDomain(db, job.newDomain, {
        selector: job.dkimSelector,
        publicKey: job.dkimPublicKey ?? '',
        record: job.dkimPublicKey ? buildDkimRecord(job.dkimPublicKey) : '',
      });
      await done(
        domainStep,
        `Домен ${job.newDomain} заведён, ключ DKIM (${job.dkimSelector}) привязан. ` +
          'Подписывать письма новым ключом rspamd начнёт после шага на сервере.',
      );

      /* --- 4. ТОЧКА НЕВОЗВРАТА: перенос писем -------------------- */
      const filesStep = await begin('files');
      await markPointOfNoReturn(db, jobId);
      const moved = await moveDomainDirectories(
        ctx.config.ADMIN_MAIL_ROOT,
        ctx.config.ADMIN_MAIL_INDEX_ROOT,
        job.oldDomain,
        job.newDomain,
        // Последняя застава: сюда мы приходим уже за точкой невозврата, и
        // перенос между устройствами обязан отказаться, а не начаться.
        { renameOnly },
      );
      await done(
        filesStep,
        moved.length === 0
          ? 'Переносить нечего: каталога писем у домена не было.'
          : `${moved.map((m) => `${m.from} → ${m.to}`).join('; ')} ` +
              `(${formatBytes(storage.bytes)}, ${String(storage.messages)} писем) — переименованием, мгновенно.`,
      );

      /* --- 5. Адреса в базе -------------------------------------- */
      const dbStep = await begin('database');
      let outcome;
      try {
        outcome = await rewriteAddresses(db, {
          oldDomain: job.oldDomain,
          newDomain: job.newDomain,
          oldDomainId,
          newDomainId,
          mailRoot: ctx.config.ADMIN_MAIL_ROOT,
        });
      } catch (err) {
        /*
         * Транзакция откатилась целиком — значит адреса прежние, и не на
         * своём месте остались только каталоги. Возвращаем их, и сервер
         * продолжает работать как раньше.
         *
         * А раз он работает как раньше — убираем и следы подготовки:
         *
         *   отметку точки невозврата, потому что её не случилось. Иначе
         *   панель говорила бы «назад нельзя» про переезд, которого не
         *   было, — самая дорогая ложь на этом экране;
         *
         *   заведённый домен, потому что иначе сервер молча продолжает
         *   принимать почту для имени, переезд на которое сорвался, и
         *   отбивать её как «нет такого ящика». Удаляется только пустой
         *   (см. dropTargetDomain) — ящиков в нём и не появилось.
         *
         * Оба следа найдены живой проверкой: без них сорвавшаяся смена
         * оставляла работающий сервер, о котором панель сообщала прямо
         * противоположное.
         */
        const rollback = await rollbackMoves(moved);
        await clearPointOfNoReturn(db, jobId).catch(() => undefined);
        const removed = await dropTargetDomain(db, job.newDomain).catch(() => false);
        /*
         * Говорим ровно то, что вышло. Возврат каталогов может не удаться
         * (в старый путь уже доставили письмо — ENOTEMPTY), и обещать
         * «ничего не потеряно» в этом случае нельзя: почта ящиков лежит
         * под новым доменом, а база указывает на старый, и разбираться
         * придётся руками на диске.
         */
        if (rollback.failed.length > 0) {
          const paths = rollback.failed.map((item) => item.to).join(', ');
          filesStep.state = 'failed';
          filesStep.detail = `Каталоги вернуть не удалось: ${paths}`;
          throw new StepFailure(
            dbStep,
            `Переписать адреса не удалось: ${errorText(err)}. ХУЖЕ ТОГО: каталоги писем ` +
              `не удалось вернуть на место (${paths}). Почта этих ящиков лежит по новому ` +
              'пути, а адреса в базе остались старыми — ящики будут выглядеть пустыми. ' +
              'Верните каталоги вручную и только потом составляйте план заново.',
          );
        }
        filesStep.state = 'skipped';
        filesStep.detail = 'Каталоги возвращены на место: запись в базу не удалась.';
        throw new StepFailure(
          dbStep,
          `Переписать адреса не удалось: ${errorText(err)}. Каталоги писем возвращены ` +
            'на место, сервер работает со старым доменом' +
            (removed ? `, домен ${job.newDomain} убран.` : '.') +
            ' Ничего не потеряно — разберитесь с причиной и составьте план заново.',
        );
      }
      await done(
        dbStep,
        `Ящиков ${String(outcome.mailboxes)}, алиасов ${String(outcome.aliases)}, ` +
          `строк настроек ${String(outcome.tables.reduce((s, t) => s + t.rows, 0))} ` +
          `в ${String(outcome.tables.length)} таблицах. ` +
          `Заведено ${String(outcome.legacyAliases)} алиас(ов) «старый адрес → новый»` +
          (outcome.duplicatesRemoved > 0
            ? `; убрано ${String(outcome.duplicatesRemoved)} алиас(ов), ставших дублями.`
            : '.'),
      );

      /* --- 6. Проверка ------------------------------------------- */
      const verifyStep = await begin('verify');
      const after = await countDomainObjects(db, job.newDomain);
      const legacy = await countDomainObjects(db, job.oldDomain);
      const problems: string[] = [];
      if (after.mailboxes !== outcome.mailboxes) {
        problems.push(
          `в новом домене ${String(after.mailboxes)} ящик(ов), а переехать должно было ` +
            `${String(outcome.mailboxes)}`,
        );
      }
      if (outcome.mailboxes > 0 && legacy.aliases === 0) {
        problems.push(
          'в старом домене не осталось ни одного алиаса — почта на прежние адреса не пойдёт',
        );
      }
      const newStorage = await measureDomainStorage(
        ctx.config.ADMIN_MAIL_ROOT,
        ctx.config.ADMIN_MAIL_INDEX_ROOT,
        job.newDomain,
      );
      if (storage.present && !newStorage.present) {
        problems.push(`каталог ${newStorage.path} не читается — письма могли не переехать`);
      }
      /*
       * СЛУЧАЙ «КАТАЛОГА НЕ БЫЛО ВИДНО» — тоже расхождение, а не норма.
       *
       * Если каталог старого домена не прочитался ещё на плане
       * (`storage.present === false`), проверка выше пропускалась целиком:
       * условие начиналось с `storage.present`. Дальше шаг переноса
       * молча закрывался как «переносить нечего», адреса переписывались,
       * а сверка сравнивала базу с базой и всегда сходилась — задание
       * заканчивалось словом «выполнено».
       *
       * На деле это значит: адреса переехали, письма — нет. Dovecot
       * заводит по новым путям пустые maildir'ы, и ВСЕ пользователи видят
       * пустые ящики. Предупреждение об этом в плане есть, но последняя
       * точка проверки обязана поймать такой исход и не выдавать зелёный
       * отчёт — откат тут уже не предусмотрен, и знать надо сразу.
       */
      if (!storage.present && outcome.mailboxes > 0 && moved.length === 0) {
        problems.push(
          `каталог писем старого домена не читался (${storage.path}), переносить было нечего — ` +
            'адреса переехали, а письма остались там, где лежали: ящики будут выглядеть пустыми',
        );
      }
      if (problems.length > 0) {
        verifyStep.state = 'failed';
        verifyStep.detail = problems.join('; ');
        await flush();
        await finishJob(db, jobId, {
          state: 'failed',
          error:
            `Перенос выполнен, но проверка нашла расхождения: ${problems.join('; ')}. ` +
            'Разберитесь по разделам «Ящики» и «Алиасы» — назад операция уже не отыгрывается.',
          steps,
          counts: {
            mailboxes: outcome.mailboxes,
            aliases: outcome.aliases,
            messages: storage.messages,
            bytes: storage.bytes,
          },
        });
        return;
      }
      await done(
        verifyStep,
        `В домене ${job.newDomain}: ${String(after.mailboxes)} ящик(ов), ` +
          `${String(newStorage.messages)} писем на ${formatBytes(newStorage.bytes)}. ` +
          `Старый домен ${job.oldDomain} принимает почту через ${String(legacy.aliases)} алиас(ов).`,
      );

      await finishJob(db, jobId, {
        state: 'done',
        error: null,
        steps,
        counts: {
          mailboxes: outcome.mailboxes,
          aliases: outcome.aliases,
          messages: storage.messages,
          bytes: storage.bytes,
        },
      });
      logger.info(
        { jobId, from: job.oldDomain, to: job.newDomain, mailboxes: outcome.mailboxes },
        'Смена домена выполнена',
      );
    } catch (err) {
      const message = err instanceof StepFailure ? err.message : errorText(err);
      if (err instanceof StepFailure) {
        err.step.state = 'failed';
        err.step.detail = message;
        err.step.finishedAt = new Date().toISOString();
      }
      for (const s of steps)
        if (s.state === 'pending' || s.state === 'running') s.state = 'skipped';
      await finishJob(db, jobId, { state: 'failed', error: message, steps });
      logger.error({ err, jobId }, 'Смена домена не выполнена');
    } finally {
      clearInterval(beat);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Байты по-человечески. Тот же вид, что в остальной панели. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1)} ${units[unit] ?? 'Б'}`;
}
