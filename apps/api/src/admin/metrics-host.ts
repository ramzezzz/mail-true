/**
 * Показатели узла и контейнера: процессор, память, нагрузка.
 *
 * ------------------------------------------------------------------
 * ЧТО СЕРВЕР ПРИЛОЖЕНИЯ ВООБЩЕ МОЖЕТ УВИДЕТЬ
 * ------------------------------------------------------------------
 * Он живёт в контейнере и видит НЕ ВСЁ. Врать про остальное нельзя:
 * выдуманное число на дашборде хуже честного «недоступно», потому что по
 * нему принимают решения. Поэтому здесь перечислено ровно то, что реально
 * читается, и у каждого показателя названо место, откуда он взят.
 *
 *   /proc/stat      — счётчики времени процессора ВСЕГО УЗЛА. В контейнере
 *                     ядро подставляет не «свою» статистику, а общую: это
 *                     не подглядывание, а устройство /proc — счётчики
 *                     глобальные, и cgroup их не переписывает.
 *   /proc/meminfo   — память ВСЕГО УЗЛА, по той же причине.
 *   /proc/loadavg   — средняя нагрузка узла за 1/5/15 минут.
 *   /sys/fs/cgroup/cpu.stat      — процессорное время, потраченное ИМЕННО
 *                                  контейнером api (cgroup v2).
 *   /sys/fs/cgroup/memory.current — память, занятая контейнером api.
 *   /sys/fs/cgroup/{cpu.max,memory.max} — заданные контейнеру пределы;
 *                                  строка «max» означает «предела нет».
 *
 * ЧЕГО УВИДЕТЬ НЕЛЬЗЯ и почему об этом сказано словами на экране:
 *   * загрузка процессора и памяти ДРУГИМИ контейнерами (postfix, dovecot,
 *     postgres) — их cgroup серверу приложения не видны;
 *   * место, занятое очередью Postfix на диске, — каталог /var/spool/postfix
 *     в контейнер api не смонтирован.
 * И то, и другое даёт только сокет Docker, а сокет Docker — это права root
 * на всей машине (решение принято, см. комментарии про queue-agent
 * в infra/docker-compose.yml). Цена несоразмерна показу двух чисел.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗАГРУЗКА ПРОЦЕССОРА СЧИТАЕТСЯ РАЗНОСТЬЮ
 * ------------------------------------------------------------------
 * В /proc/stat и в cpu.stat лежат НАКОПЛЕННЫЕ счётчики с момента загрузки,
 * а не «загрузка сейчас». Мгновенного значения не существует вовсе: доля
 * занятого времени определена только на ОТРЕЗКЕ. Отсюда два следствия,
 * которые видно на экране:
 *   * первый замер после запуска не даёт процентов (сравнивать не с чем) —
 *     и это честный NULL, а не ноль;
 *   * между замерами обязан пройти заметный отрезок, иначе деление на
 *     крошечную разность даёт шум вместо числа.
 */
import { readFile } from 'node:fs/promises';

/** Наименьший отрезок между замерами, на котором доля ещё осмысленна. */
const MIN_DELTA_MS = 200;

/** Счётчики строки `cpu` из /proc/stat, уже сведённые к занятому и всему. */
export interface CpuTotals {
  /** Всё процессорное время: занятое плюс простой. */
  total: number;
  /** Занятое: всё, кроме idle и iowait. */
  busy: number;
}

/**
 * Разбор строки `cpu` из /proc/stat.
 *
 * iowait считается ПРОСТОЕМ, а не работой. Это не придирка: ожидание диска
 * означает, что процессор свободен и готов взять работу. Засчитав iowait
 * в занятость, мы показали бы «процессор загружен на 90 %» на сервере,
 * который на самом деле упёрся в диск, — и администратор пошёл бы менять
 * не то.
 *
 * null — строки `cpu` нет или она не разобралась: значит, показателя нет,
 * и лучше сказать это прямо.
 */
export function parseProcStat(text: string): CpuTotals | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const values = line
    .slice(4)
    .trim()
    .split(/\s+/u)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  // user nice system idle iowait irq softirq steal ... — минимум до iowait
  if (values.length < 5) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  return { total, busy: total - idle };
}

/**
 * Доля занятого времени между двумя замерами, проценты 0..100.
 *
 * null, когда сравнивать не с чем или счётчики поехали назад (перезапуск
 * узла обнуляет их): отрицательная «загрузка» на графике — это ошибка,
 * которую видно, а тихо подставленный ноль — ошибка, которую не видно.
 */
export function cpuPercent(previous: CpuTotals, current: CpuTotals): number | null {
  const total = current.total - previous.total;
  const busy = current.busy - previous.busy;
  if (total <= 0 || busy < 0) return null;
  return clampPercent((busy / total) * 100);
}

/** Память узла из /proc/meminfo, байты. */
export interface MemInfo {
  total: number;
  /**
   * Сколько можно занять, не начав выгружать. Это MemAvailable, а НЕ
   * MemFree: страницы под кэшем страниц числятся занятыми, но отдаются по
   * первому требованию. По MemFree исправный сервер с горячим кэшем
   * выглядит как сервер на грани нехватки памяти — и администратор идёт
   * искать утечку, которой нет.
   */
  available: number;
}

export function parseMeminfo(text: string): MemInfo | null {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'mu').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = read('MemTotal');
  if (total === null || total <= 0) return null;
  const available = read('MemAvailable');
  if (available !== null) return { total, available };
  // Ядра старше 3.14 MemAvailable не печатают. Тогда приближение из
  // документации ядра: свободное плюс то, что отдаётся без выгрузки.
  const free = read('MemFree');
  if (free === null) return null;
  return { total, available: free + (read('Buffers') ?? 0) + (read('Cached') ?? 0) };
}

/** Средняя нагрузка за 1/5/15 минут из /proc/loadavg. */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/u);
  const nums = parts.slice(0, 3).map(Number);
  if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** Микросекунды процессорного времени контейнера из cgroup v2 cpu.stat. */
export function parseCgroupCpuUsage(text: string): number | null {
  const match = /^usage_usec\s+(\d+)/mu.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Предел процессора из cpu.max: сколько ядер разрешено занять.
 *
 * Формат — «квота период» в микросекундах, либо «max период», когда
 * предела нет. Ноль ядер не бывает: null означает «не ограничен».
 */
export function parseCpuMax(text: string): number | null {
  const parts = text.trim().split(/\s+/u);
  if (parts.length < 2 || parts[0] === 'max') return null;
  const quota = Number(parts[0]);
  const period = Number(parts[1]);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

/** Число из файла cgroup; «max» и мусор дают null («предела нет»). */
export function parseCgroupNumber(text: string): number | null {
  const value = text.trim();
  if (value === '' || value === 'max') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Заведомо не выйти за 0..100: округление счётчиков иногда даёт 100,4. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/**
 * Показатель, который может быть недоступен.
 *
 * Пара «значение или null» плюс объяснение — единственная форма, в которой
 * такие числа можно отдавать наружу. Отдельное поле `note` существует
 * ровно чтобы на экране было ЧТО показать вместо прочерка: «недоступно»
 * без причины выглядит как поломка панели.
 */
export interface Measured {
  value: number | null;
  /** Откуда взято (или почему нет) — показывается человеку. */
  source: string;
}

export interface HostSnapshot {
  /** Загрузка процессора узла, проценты 0..100. */
  cpuNodePercent: Measured;
  /** Процессорное время контейнера api в процентах ОДНОГО ядра. */
  cpuApiPercent: Measured;
  /** Сколько ядер видит узел (для чтения loadavg и процентов ядра). */
  cpuCount: Measured;
  /** Предел ядер у контейнера api; null в value — предела нет. */
  cpuApiLimit: Measured;
  load1: Measured;
  memNodeTotal: Measured;
  memNodeUsed: Measured;
  memApiBytes: Measured;
  memApiLimit: Measured;
  /** Что снять не удалось и почему — список для показа на экране. */
  unavailable: string[];
}

const PROC_STAT = '/proc/stat';
const PROC_MEMINFO = '/proc/meminfo';
const PROC_LOADAVG = '/proc/loadavg';
const CG_CPU_STAT = '/sys/fs/cgroup/cpu.stat';
const CG_CPU_MAX = '/sys/fs/cgroup/cpu.max';
const CG_MEM_CURRENT = '/sys/fs/cgroup/memory.current';
const CG_MEM_MAX = '/sys/fs/cgroup/memory.max';

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Читатель показателей узла.
 *
 * Хранит предыдущий замер: без него загрузка процессора не вычисляется в
 * принципе (см. пояснение вверху файла). Состояние держится в объекте, а
 * не в модуле, чтобы проверка могла завести свой экземпляр и не зависеть
 * от порядка запуска остальных.
 */
export class HostMetricsReader {
  #prevCpu: { totals: CpuTotals; at: number } | null = null;
  #prevCgroupCpu: { usec: number; at: number } | null = null;

  /** Подставные пути — только для проверок; в бою читается /proc и /sys. */
  constructor(
    private readonly paths: {
      procStat?: string;
      meminfo?: string;
      loadavg?: string;
      cgCpuStat?: string;
      cgCpuMax?: string;
      cgMemCurrent?: string;
      cgMemMax?: string;
    } = {},
  ) {}

  async read(now = Date.now()): Promise<HostSnapshot> {
    const unavailable: string[] = [];
    const [statText, memText, loadText, cgCpuText, cgCpuMaxText, cgMemText, cgMemMaxText] =
      await Promise.all([
        readText(this.paths.procStat ?? PROC_STAT),
        readText(this.paths.meminfo ?? PROC_MEMINFO),
        readText(this.paths.loadavg ?? PROC_LOADAVG),
        readText(this.paths.cgCpuStat ?? CG_CPU_STAT),
        readText(this.paths.cgCpuMax ?? CG_CPU_MAX),
        readText(this.paths.cgMemCurrent ?? CG_MEM_CURRENT),
        readText(this.paths.cgMemMax ?? CG_MEM_MAX),
      ]);

    /* --- процессор узла --- */
    let cpuNode: Measured = { value: null, source: `${PROC_STAT} недоступен` };
    let cpuCount: Measured = { value: null, source: `${PROC_STAT} недоступен` };
    if (statText === null) {
      unavailable.push(
        `Загрузка процессора узла: файл ${PROC_STAT} не читается. Так бывает в ` +
          'урезанных окружениях без /proc — снять её больше неоткуда.',
      );
    } else {
      const cores = statText.split('\n').filter((l) => /^cpu\d+ /u.test(l)).length;
      cpuCount = { value: cores > 0 ? cores : null, source: PROC_STAT };
      const totals = parseProcStat(statText);
      if (!totals) {
        cpuNode = { value: null, source: `${PROC_STAT}: строка cpu не разобрана` };
        unavailable.push(`Загрузка процессора узла: в ${PROC_STAT} нет разбираемой строки «cpu».`);
      } else {
        const prev = this.#prevCpu;
        if (prev && now - prev.at >= MIN_DELTA_MS) {
          cpuNode = { value: cpuPercent(prev.totals, totals), source: `${PROC_STAT} (весь узел)` };
        } else {
          cpuNode = {
            value: null,
            source: `${PROC_STAT}: первый замер, сравнивать не с чем`,
          };
        }
        this.#prevCpu = { totals, at: now };
      }
    }

    /* --- процессор контейнера --- */
    let cpuApi: Measured = { value: null, source: `${CG_CPU_STAT} недоступен` };
    let cpuApiLimit: Measured = { value: null, source: `${CG_CPU_MAX} недоступен` };
    if (cgCpuText === null) {
      unavailable.push(
        `Доля процессора, которую занимает сам сервер приложения: ${CG_CPU_STAT} не читается. ` +
          'Это cgroup v2; на узле с cgroup v1 путь другой, и показателя не будет.',
      );
    } else {
      const usec = parseCgroupCpuUsage(cgCpuText);
      if (usec === null) {
        cpuApi = { value: null, source: `${CG_CPU_STAT}: нет usage_usec` };
      } else {
        const prev = this.#prevCgroupCpu;
        if (prev && now - prev.at >= MIN_DELTA_MS) {
          const elapsedUsec = (now - prev.at) * 1000;
          cpuApi = {
            value: clampCore(((usec - prev.usec) / elapsedUsec) * 100),
            source: `${CG_CPU_STAT} (контейнер api)`,
          };
        } else {
          cpuApi = { value: null, source: `${CG_CPU_STAT}: первый замер` };
        }
        this.#prevCgroupCpu = { usec, at: now };
      }
    }
    if (cgCpuMaxText !== null) {
      const limit = parseCpuMax(cgCpuMaxText);
      cpuApiLimit = {
        value: limit,
        source: limit === null ? `${CG_CPU_MAX}: предел не задан` : CG_CPU_MAX,
      };
    }

    /* --- память --- */
    let memTotal: Measured = { value: null, source: `${PROC_MEMINFO} недоступен` };
    let memUsed: Measured = { value: null, source: `${PROC_MEMINFO} недоступен` };
    const mem = memText === null ? null : parseMeminfo(memText);
    if (mem === null) {
      unavailable.push(
        `Память узла: ${PROC_MEMINFO} не читается или в нём нет MemTotal/MemAvailable.`,
      );
    } else {
      memTotal = { value: mem.total, source: `${PROC_MEMINFO} (весь узел)` };
      memUsed = {
        value: Math.max(0, mem.total - mem.available),
        source: `${PROC_MEMINFO}: MemTotal − MemAvailable`,
      };
    }

    let memApi: Measured = { value: null, source: `${CG_MEM_CURRENT} недоступен` };
    if (cgMemText === null) {
      unavailable.push(
        `Память, занятая самим сервером приложения: ${CG_MEM_CURRENT} не читается (cgroup v2).`,
      );
    } else {
      memApi = { value: parseCgroupNumber(cgMemText), source: `${CG_MEM_CURRENT} (контейнер api)` };
    }
    let memApiLimit: Measured = { value: null, source: `${CG_MEM_MAX} недоступен` };
    if (cgMemMaxText !== null) {
      const limit = parseCgroupNumber(cgMemMaxText);
      memApiLimit = {
        value: limit,
        source: limit === null ? `${CG_MEM_MAX}: предел не задан` : CG_MEM_MAX,
      };
    }

    /* --- нагрузка --- */
    const load = loadText === null ? null : parseLoadavg(loadText);
    const load1: Measured = {
      value: load ? load[0] : null,
      source: load ? `${PROC_LOADAVG} (весь узел)` : `${PROC_LOADAVG} недоступен`,
    };

    // То, чего не даст ни один файл под /proc и /sys: чужие контейнеры.
    // Говорим об этом ВСЕГДА, а не только при отказе, — иначе человек
    // будет считать показанное «загрузкой почтового сервера целиком».
    unavailable.push(
      'Загрузка процессора и памяти отдельными службами (postfix, dovecot, postgres, ' +
        'rspamd): их cgroup серверу приложения не видны. Показать их может только ' +
        'сокет Docker, а он даёт права root на всей машине — подключать его мы не будем.',
    );

    return {
      cpuNodePercent: cpuNode,
      cpuApiPercent: cpuApi,
      cpuCount,
      cpuApiLimit,
      load1,
      memNodeTotal: memTotal,
      memNodeUsed: memUsed,
      memApiBytes: memApi,
      memApiLimit,
      unavailable,
    };
  }
}

/** Проценты одного ядра: сверху не ограничены числом ядер, снизу — нулём. */
function clampCore(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}
