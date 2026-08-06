/**
 * Сборщик показателей: снимает состояние по расписанию и складывает в базу.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПО РАСПИСАНИЮ, А НЕ НА КАЖДЫЙ ЗАПРОС ДАШБОРДА
 * ------------------------------------------------------------------
 * Три причины, и каждой хватило бы одной.
 *
 * 1. Загрузку процессора нельзя измерить одним обращением: в /proc/stat
 *    лежат накопленные счётчики, и доля занятого времени существует только
 *    как разность двух замеров (см. metrics-host.ts). Съёмка по расписанию
 *    даёт эту разность сама собой; съёмка «по открытию страницы» давала бы
 *    её лишь тому, кто открыл страницу дважды подряд.
 *
 * 2. Обход каталогов и опрос очереди стоят заметного времени. Привязав их
 *    к запросу, мы получили бы дашборд, который открывается секундами, и
 *    сервер, который занят тем сильнее, чем чаще на него смотрят.
 *
 * 3. Истории иначе не будет вовсе. График «за последние часы» существует
 *    только потому, что кто-то снимал показания все эти часы, — в том
 *    числе когда панель была закрыта.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СБОРЩИК НЕ ПАДАЕТ ЦЕЛИКОМ ИЗ-ЗА ОДНОГО ПОКАЗАТЕЛЯ
 * ------------------------------------------------------------------
 * Недоступная очередь, неподмонтированный том, отвалившийся Postgres —
 * это нормальные состояния почтового сервера, а не сбой сборщика. Каждый
 * источник опрашивается отдельно, и его отказ превращается в NULL в своей
 * колонке, а не в потерю всего снимка. Иначе первый же сбой стирал бы
 * историю всех остальных показателей — ровно тогда, когда она нужнее всего.
 */
import type { Logger } from 'pino';
import type { AdminDb } from './db.js';
import {
  directorySize,
  readMailboxDiskUsage,
  volumeUsage,
  type MailboxDiskReport,
  type VolumeUsage,
} from './metrics-disk.js';
import { HostMetricsReader, type HostSnapshot } from './metrics-host.js';
import { MetricsStore, type MetricSampleInput } from './metrics-store.js';
import type { QueueAgent } from './queue-agent.js';
import { RepeatGuard, noteRecovered, warnOnce } from './repeat-log.js';

/** Разрез занятого места: одна строка — одна статья расхода. */
export interface DiskSlice {
  id: string;
  title: string;
  bytes: number | null;
  /** Откуда взято число или почему его нет. */
  source: string;
}

/** Состояние очереди, каким его видно снаружи контейнера postfix. */
export interface QueueSnapshotBrief {
  available: boolean;
  total: number | null;
  deferred: number | null;
  oldestSeconds: number | null;
  /** Крупнейшие адресаты отсрочек: домен и сколько писем ему не уходит. */
  topDeferredDomains: Array<{ domain: string; count: number }>;
  /**
   * Очередь длиннее предела разбора — показанные числа НЕПОЛНЫ.
   *
   * Признак вынесен отдельным полем, а не только текстом в note: раздел
   * «Почтовый поток» о неполноте предупреждал, а дашборд показывал ровно
   * 20 000 как факт — то есть в самый заторный момент два раздела панели
   * говорили администратору разное об одной и той же очереди.
   */
  truncated: boolean;
  note: string;
}

/** Всё, что сборщик знает о ресурсах на момент последней съёмки. */
export interface ResourceSnapshot {
  takenAt: string;
  host: HostSnapshot;
  volumes: VolumeUsage[];
  /** Все тома оказались на одном устройстве — говорим об этом прямо. */
  singleDevice: boolean;
  slices: DiskSlice[];
  mailboxes: MailboxDiskReport;
  queue: QueueSnapshotBrief;
  /** Чего не увидеть из контейнера и почему. */
  unavailable: string[];
}

export interface MetricsCollectorOptions {
  db: AdminDb;
  logger: Logger;
  queueAgent: QueueAgent;
  /** Корень почтового хранилища (совпадает с mail_location Dovecot). */
  mailRoot: string;
  /** Каталог поисковых индексов Dovecot. */
  indexRoot: string;
  /** Каталог общего тома журналов. */
  logRoot: string;
  intervalSeconds: number;
  retentionDays: number;
  maxRows: number;
  /** Сколько времени отводится обходу одного каталога. */
  walkBudgetMs?: number;
}

export class MetricsCollector {
  readonly #opts: MetricsCollectorOptions;
  readonly #host = new HostMetricsReader();
  readonly #store: MetricsStore;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #last: ResourceSnapshot | null = null;
  /** Каждый сотый проход чистим историю: чаще незачем, реже опасно. */
  #ticks = 0;
  /**
   * Сторожа повторов: проход раз в минуту, а недоступная база лежит
   * часами. Без них одна поломка = 1440 одинаковых строк в сутки
   * (см. repeat-log.ts). Сторожа два, потому что причины разные и
   * глушить их надо порознь.
   */
  readonly #passFailures = new RepeatGuard();
  readonly #persistFailures = new RepeatGuard();

  constructor(opts: MetricsCollectorOptions) {
    this.#opts = opts;
    this.#store = new MetricsStore(opts.db);
  }

  /** Последний снятый снимок; null — съёмки ещё не было. */
  get latest(): ResourceSnapshot | null {
    return this.#last;
  }

  start(): void {
    const seconds = this.#opts.intervalSeconds;
    if (seconds <= 0 || this.#timer) return;
    // Первый проход сразу: он ставит опорную точку для разности счётчиков
    // процессора. Без него первые проценты появились бы только через
    // интервал, и панель после перезапуска показывала бы прочерк.
    void this.runOnce().catch(() => undefined);
    this.#timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        warnOnce(this.#passFailures, this.#opts.logger, err, 'Проход сборщика показателей не удался');
      });
    }, seconds * 1000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Один проход: снять всё, что доступно, и записать строку истории. */
  async runOnce(): Promise<ResourceSnapshot> {
    // Проходы не наезжают друг на друга: обход большого каталога может не
    // уложиться в интервал, а два обхода разом — это удвоенная нагрузка
    // на диск ровно в тот момент, когда он и так занят.
    if (this.#running && this.#last) return this.#last;
    this.#running = true;
    try {
      const snapshot = await this.collect();
      this.#last = snapshot;
      await this.persist(snapshot)
        .then(() => {
          // О возврате записи сообщаем один раз: без этого по журналу
          // не понять, когда именно история снова стала полной.
          noteRecovered(
            this.#persistFailures,
            this.#opts.logger,
            'Снимки показателей снова пишутся в базу',
          );
        })
        .catch((err: unknown) => {
          // Недоступная база не должна лишать дашборд текущего состояния:
          // историю потеряем, «прямо сейчас» покажем.
          warnOnce(
            this.#persistFailures,
            this.#opts.logger,
            err,
            'Снимок показателей не записан в базу',
          );
        });
      this.#ticks += 1;
      if (this.#ticks % 100 === 1) {
        await this.#store
          .prune(this.#opts.retentionDays, this.#opts.maxRows)
          .catch(() => undefined);
      }
      return snapshot;
    } finally {
      this.#running = false;
    }
  }

  private async collect(): Promise<ResourceSnapshot> {
    const { mailRoot, indexRoot, logRoot } = this.#opts;
    const budget = this.#opts.walkBudgetMs ?? 3000;

    // Всё разом: последовательно это складывалось бы в секунды, а между
    // первым и последним измерением набегала бы заметная разница во времени,
    // из-за которой числа в одном «снимке» относились бы к разным моментам.
    const [host, volMail, volIndex, volLogs, mailboxes, indexSize, logsSize, dbSize, queue] =
      await Promise.all([
        this.#host.read(),
        volumeUsage(mailRoot),
        volumeUsage(indexRoot),
        volumeUsage(logRoot),
        readMailboxDiskUsage(mailRoot),
        directorySize(indexRoot, budget),
        directorySize(logRoot, budget),
        this.#store.databaseSize().catch(() => null),
        this.readQueue(),
      ]);

    const volumes = [volMail, volIndex, volLogs].filter((v): v is VolumeUsage => v !== null);
    const devices = new Set(volumes.map((v) => v.device));
    const singleDevice = volumes.length > 1 && devices.size === 1;

    const slices: DiskSlice[] = [
      {
        id: 'vmail',
        title: 'Письма',
        bytes: mailboxes.available ? mailboxes.totalBytes : null,
        source: mailboxes.available
          ? `Учёт квоты Dovecot (${mailRoot}/*/*/maildirsize)`
          : mailboxes.note,
      },
      {
        id: 'mailindex',
        title: 'Поисковые индексы',
        bytes: indexSize.complete ? indexSize.bytes : null,
        source: indexSize.complete
          ? `Обход каталога ${indexRoot}`
          : `Обход ${indexRoot} не уложился в ${budget} мс — число было бы неполным`,
      },
      {
        id: 'logs',
        title: 'Журналы служб',
        bytes: logsSize.complete ? logsSize.bytes : null,
        source: logsSize.complete
          ? `Обход каталога ${logRoot}`
          : `Обход ${logRoot} не уложился в ${budget} мс`,
      },
      {
        id: 'db',
        title: 'База данных',
        bytes: dbSize ? dbSize.totalBytes - dbSize.indexBytes : null,
        source: dbSize
          ? 'pg_database_size − pg_indexes_size (спрошено у самой базы)'
          : 'База не ответила на запрос о своём размере',
      },
      {
        id: 'dbindex',
        title: 'Индексы базы',
        bytes: dbSize ? dbSize.indexBytes : null,
        source: dbSize ? 'pg_indexes_size (спрошено у самой базы)' : 'База не ответила',
      },
      {
        id: 'queue',
        title: 'Очередь Postfix',
        bytes: null,
        source:
          'Недоступно: каталог /var/spool/postfix в контейнер api не смонтирован. ' +
          'Его объём на диске дал бы только сокет Docker, а это права root на всей ' +
          'машине — подключать его мы не будем. Число писем в очереди и возраст ' +
          'самого старого видны и без него, через посредника в контейнере postfix',
      },
    ];

    const unavailable = [...host.unavailable];
    if (!mailboxes.available) unavailable.push(mailboxes.note);
    if (!queue.available) unavailable.push(queue.note);
    if (singleDevice) {
      unavailable.push(
        'Письма, индексы и журналы лежат на ОДНОМ устройстве: свободное место у них ' +
          'общее, и переполнение журналами остановит приём почты. Разрез по статьям ' +
          'расхода ниже показывает, что именно занимает этот том',
      );
    }

    return {
      takenAt: new Date().toISOString(),
      host,
      volumes,
      singleDevice,
      slices,
      mailboxes,
      queue,
      unavailable,
    };
  }

  /**
   * Очередь через посредника в контейнере postfix.
   *
   * Крупнейшие адресаты отсрочек сводятся ПО ДОМЕНАМ, а не по адресам.
   * Причина простая: когда чужой сервер лежит, в очереди оказываются сотни
   * разных адресов ОДНОГО домена, и список адресов ничего не объясняет.
   * Список доменов объясняет сразу: «двести писем не уходят на example.com».
   */
  private async readQueue(): Promise<QueueSnapshotBrief> {
    if (!this.#opts.queueAgent.configured) {
      return {
        available: false,
        total: null,
        deferred: null,
        oldestSeconds: null,
        topDeferredDomains: [],
        truncated: false,
        note:
          'Очередь недоступна: не настроен посредник к Postfix (QUEUE_AGENT_TOKEN). ' +
          'Сокет Docker вместо него мы не подключаем — это права root на всей машине',
      };
    }
    try {
      const snapshot = await this.#opts.queueAgent.snapshot();
      const now = Date.now();
      let oldest: number | null = null;
      let deferred = 0;
      const byDomain = new Map<string, number>();
      for (const message of snapshot.messages) {
        const age = Math.floor((now - message.arrivalTime.getTime()) / 1000);
        if (Number.isFinite(age) && (oldest === null || age > oldest)) oldest = age;
        if (message.queueName === 'deferred') {
          deferred += 1;
          /*
           * Считаем ПИСЬМА, а не адресатов. Раньше письмо, адресованное трём
           * сотрудникам одного домена, добавляло домену три — и сумма
           * столбца «Писем» на дашборде превышала плитку «отложено» ровно на
           * число лишних адресатов. Администратор видел «на example.com не
           * уходит 300 писем» при 100 письмах в очереди и искал недостающие.
           * Домены внутри одного письма при этом разные считаются каждый:
           * письмо действительно не уходит к обоим.
           */
          const domains = new Set<string>();
          for (const recipient of message.recipients) {
            domains.add(recipient.address.split('@')[1]?.toLowerCase() ?? '(без домена)');
          }
          for (const domain of domains) {
            byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
          }
        }
      }
      const topDeferredDomains = [...byDomain.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
      return {
        available: true,
        total: snapshot.messages.length,
        deferred,
        oldestSeconds: oldest,
        topDeferredDomains,
        truncated: snapshot.truncated,
        note: snapshot.truncated
          ? 'Очередь длиннее предела разбора: показанное неполно'
          : 'Посредник в контейнере postfix (postqueue -j)',
      };
    } catch (err) {
      return {
        available: false,
        total: null,
        deferred: null,
        oldestSeconds: null,
        topDeferredDomains: [],
        truncated: false,
        note: `Очередь не опрошена: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async persist(snapshot: ResourceSnapshot): Promise<void> {
    const volume = snapshot.volumes[0] ?? null;
    const slice = (id: string): number | null =>
      snapshot.slices.find((s) => s.id === id)?.bytes ?? null;
    const sample: MetricSampleInput = {
      cpuNodePercent: snapshot.host.cpuNodePercent.value,
      cpuApiPercent: snapshot.host.cpuApiPercent.value,
      load1: snapshot.host.load1.value,
      memNodeTotal: snapshot.host.memNodeTotal.value,
      memNodeUsed: snapshot.host.memNodeUsed.value,
      memApiBytes: snapshot.host.memApiBytes.value,
      diskTotal: volume?.totalBytes ?? null,
      diskFree: volume?.freeBytes ?? null,
      vmailBytes: slice('vmail'),
      mailindexBytes: slice('mailindex'),
      logsBytes: slice('logs'),
      dbBytes: slice('db'),
      dbIndexBytes: slice('dbindex'),
      queueTotal: snapshot.queue.total,
      queueDeferred: snapshot.queue.deferred,
      queueOldestSeconds: snapshot.queue.oldestSeconds,
    };
    await this.#store.insertSample(sample);
  }
}
