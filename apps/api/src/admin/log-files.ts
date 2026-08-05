/**
 * Чтение журналов из общего тома — с конца, страницами, без загрузки файла
 * в память.
 *
 * ЗАЧЕМ С КОНЦА. Журнал читают всегда с последних событий: «что сейчас
 * сломалось». Прочитать файл целиком нельзя — на живом сервере postfix.log
 * это десятки мегабайт, и один открытый экран админки положил бы сервер
 * приложения (потолок кучи 512 МБ, см. docker-compose.yml). Поэтому файл
 * читается кусками с конца, ровно пока не наберётся страница.
 *
 * ЛЕНИВАЯ ПОДГРУЗКА. Курсор — это смещение в байтах: «отдай то, что лежит
 * ДО этого места». Он устойчив к дописыванию (файл растёт с конца, старые
 * смещения не двигаются) и проверяется на проворот журнала: у файла
 * запоминается пара «устройство+inode», и если она изменилась, клиенту
 * честно говорится, что нужно начать сначала, а не отдаётся мусор.
 *
 * ПРЕДЕЛ ПРОСМОТРА. Отбор по уровню может не найти ни одной строки на
 * мегабайтах (искали ошибки, а их нет) — поэтому у одного запроса есть
 * потолок просмотренных байт. Дойдя до него, ответ возвращается пустым,
 * но с курсором: клиент продолжит с того же места, а сервер не встанет
 * на одном запросе.
 */
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../errors.js';
import {
  isLogSource,
  levelAtLeast,
  parseLogLine,
  type LogEntry,
  type LogLevel,
  type LogSource,
} from './mail-log.js';

/** Сколько байт читаем за один заход к диску. */
const CHUNK_BYTES = 64 * 1024;

/** Потолок просмотра на один запрос. */
const SCAN_BUDGET_BYTES = 4 * 1024 * 1024;

/** Строка длиннее этого — не строка журнала, а чей-то мусор; режем. */
const MAX_LINE_CHARS = 4000;

/** Имена файлов журналов в общем томе. */
export const LOG_FILE_NAMES: Readonly<Record<LogSource, string>> = {
  postfix: 'postfix.log',
  dovecot: 'dovecot.log',
  api: 'api.log',
};

export interface LogFileInfo {
  source: LogSource;
  path: string;
  /** Файла нет — служба ещё не написала ни строки или журнал не настроен. */
  present: boolean;
  sizeBytes: number;
  modifiedAt: Date | null;
  /** Опознаватель файла: меняется при провороте журнала. */
  fileId: string | null;
}

/** Строка журнала вместе с её местом в файле (оно же курсор). */
export interface LogLine extends LogEntry {
  /** Смещение начала строки в файле — из него получается курсор. */
  offset: number;
}

export interface ReadLogOptions {
  levelAtMost?: LogLevel;
  /** Подстрока для поиска, регистр не важен. */
  search?: string | undefined;
  limit: number;
  /** Отдавать только то, что лежит ДО этого смещения (лениво подгружаем старое). */
  before?: number | undefined;
  /** Опознаватель файла, полученный в прошлом ответе. */
  fileId?: string | undefined;
}

export interface ReadLogResult {
  items: LogLine[];
  /** Курсор следующей страницы; null — старее ничего нет. */
  nextBefore: number | null;
  fileId: string;
  sizeBytes: number;
  /**
   * Журнал провернулся между запросами — прошлый курсор больше ничего не
   * значит, и страница отдана с начала. Интерфейс обязан сказать об этом,
   * а не молча показать другое место.
   */
  rotated: boolean;
  /** Просмотр упёрся в потолок: строк нет, но старее ещё есть. */
  budgetExhausted: boolean;
}

/** Есть ли такой файл и что о нём известно. */
export async function describeLogFile(dir: string, source: LogSource): Promise<LogFileInfo> {
  const path = join(dir, LOG_FILE_NAMES[source]);
  try {
    const st = await stat(path);
    return {
      source,
      path,
      present: st.isFile(),
      sizeBytes: st.size,
      modifiedAt: st.mtime,
      fileId: `${st.dev}-${st.ino}`,
    };
  } catch {
    return { source, path, present: false, sizeBytes: 0, modifiedAt: null, fileId: null };
  }
}

/** Все известные журналы и их состояние — для выбора источника в интерфейсе. */
export async function listLogFiles(dir: string): Promise<LogFileInfo[]> {
  const sources = Object.keys(LOG_FILE_NAMES).filter(isLogSource);
  return Promise.all(sources.map((source) => describeLogFile(dir, source)));
}

/**
 * Провёрнутые куски журнала, лежащие рядом (postfix.log.20260805-201500,
 * dovecot.log.1 и их сжатые варианты). Не читаются — но их наличие
 * объясняет человеку, куда делась история за позавчера.
 */
export async function listRotatedFiles(dir: string, source: LogSource): Promise<string[]> {
  const base = LOG_FILE_NAMES[source];
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.startsWith(`${base}.`)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Страница журнала: самые свежие строки, подходящие под отбор.
 *
 * Возвращаются в порядке «свежие сверху» — в этом же порядке они и нужны
 * на экране.
 */
export async function readLogPage(
  dir: string,
  source: LogSource,
  options: ReadLogOptions,
  now: Date = new Date(),
): Promise<ReadLogResult> {
  const info = await describeLogFile(dir, source);
  if (!info.present || info.fileId === null) {
    throw new LogFileMissingError(source, info.path);
  }

  // Курсор от прошлого файла применять нельзя: смещения в новом файле
  // указывают на другие строки. Честно начинаем сначала и говорим об этом.
  const rotated = options.fileId !== undefined && options.fileId !== info.fileId;
  const before = rotated ? undefined : options.before;

  const threshold = options.levelAtMost ?? 'debug';
  const needle = options.search?.trim().toLowerCase() ?? '';

  const handle = await open(info.path, 'r');
  try {
    let end = Math.min(before ?? info.sizeBytes, info.sizeBytes);
    let tail = Buffer.alloc(0);
    let scanned = 0;
    const items: LogLine[] = [];
    let lowestReturned: number | null = null;

    while (end > 0 && items.length < options.limit && scanned < SCAN_BUDGET_BYTES) {
      const size = Math.min(CHUNK_BYTES, end);
      const start = end - size;
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, start);
      scanned += size;
      const data = tail.length > 0 ? Buffer.concat([buffer, tail]) : buffer;

      // Границы строк внутри куска. Первый отрезок (до первого перевода
      // строки) может быть началом строки из предыдущего куска — тогда он
      // переносится в хвост, а не разбирается как отдельная строка.
      const breaks: number[] = [];
      for (let i = 0; i < data.length; i += 1) {
        if (data[i] === 0x0a) breaks.push(i);
      }

      const complete: Array<{ offset: number; text: string }> = [];
      if (breaks.length === 0) {
        tail = data;
      } else {
        const firstBreak = breaks[0]!;
        if (start === 0) {
          complete.push({ offset: 0, text: data.subarray(0, firstBreak).toString('utf8') });
        }
        for (let k = 0; k < breaks.length - 1; k += 1) {
          const from = breaks[k]! + 1;
          const to = breaks[k + 1]!;
          complete.push({ offset: start + from, text: data.subarray(from, to).toString('utf8') });
        }
        // В хвост уходит начало строки ВМЕСТЕ с её переводом строки.
        //
        // Перевод здесь обязателен, и это не мелочь: без него следующий
        // кусок оканчивался бы ровно перед переводом, его последняя
        // строка выглядела бы недописанной и молча терялась. На каждой
        // границе куска (каждые 64 КБ) из журнала пропадала бы строка —
        // ровно та, которую человек и ищет.
        tail = start === 0 ? Buffer.alloc(0) : data.subarray(0, firstBreak + 1);
      }

      // Идём от свежих к старым: это и порядок выдачи.
      for (let k = complete.length - 1; k >= 0 && items.length < options.limit; k -= 1) {
        const line = complete[k]!;
        const raw = line.text.replace(/\r$/, '');
        if (raw.trim() === '') continue;
        const entry = parseLogLine(source, raw.slice(0, MAX_LINE_CHARS), now);
        if (!levelAtLeast(entry.level, threshold)) continue;
        if (needle !== '' && !raw.toLowerCase().includes(needle)) continue;
        items.push({ ...entry, offset: line.offset });
        lowestReturned = line.offset;
      }

      end = start;
    }

    const nextBefore = lowestReturned ?? end;
    return {
      items,
      nextBefore: nextBefore > 0 ? nextBefore : null,
      fileId: info.fileId,
      sizeBytes: info.sizeBytes,
      rotated,
      budgetExhausted: items.length === 0 && nextBefore > 0,
    };
  } finally {
    await handle.close();
  }
}

/** Журнала нет: службу либо не настроили писать в файл, либо она молчала. */
export class LogFileMissingError extends ApiError {
  constructor(
    readonly source: LogSource,
    readonly path: string,
  ) {
    super(
      503,
      'LOG_FILE_MISSING',
      `Журнал «${source}» недоступен: файла ${path} нет. Общий том с журналами ` +
        'подключается в infra/docker-compose.yml (том maillogs); проверьте, что ' +
        'служба запущена и пишет в него.',
    );
    this.name = 'LogFileMissingError';
  }
}

/**
 * Последовательное чтение НОВОГО хвоста файла — для разбора истории
 * доставки (см. flow-collector.ts). Читает от `fromOffset` до конца и
 * отдаёт целые строки; недописанный хвост остаётся на следующий раз.
 */
export async function readNewLines(
  path: string,
  fromOffset: number,
  maxBytes: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const st = await stat(path);
  if (fromOffset >= st.size) return { lines: [], nextOffset: fromOffset };
  const end = Math.min(st.size, fromOffset + maxBytes);
  const stream = createReadStream(path, { start: fromOffset, end: end - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  const lastBreak = data.lastIndexOf(0x0a);
  if (lastBreak < 0) {
    // Целой строки не набралось — ждём, пока служба допишет. Двигать
    // смещение здесь нельзя: половина строки разобралась бы как мусор.
    return { lines: [], nextOffset: fromOffset };
  }
  const text = data.subarray(0, lastBreak).toString('utf8');
  return {
    lines: text.split('\n').filter((line) => line.trim() !== ''),
    nextOffset: fromOffset + lastBreak + 1,
  };
}
