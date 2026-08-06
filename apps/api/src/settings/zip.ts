/**
 * Запись ZIP-архива на диск — ровно столько формата, сколько нужно
 * выгрузке ящика.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СВОЙ, А НЕ БИБЛИОТЕКА
 * ------------------------------------------------------------------
 * Потому что здесь нужен один способ применения: «положить в файл поток
 * из тысяч небольших файлов, ничего не держа в памяти». Готовые пакеты
 * (archiver, yazl) умеют на порядок больше, тянут за собой зависимости и
 * добавляют к образу мегабайты — а продукт целиком должен помещаться на
 * VPS с 2 ГБ (см. NODE_OPTIONS в infra/docker-compose.yml). Формат при
 * этом простой и стабильный тридцать лет: заголовок перед данными,
 * оглавление в конце.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПИСЬМО СНАЧАЛА ЦЕЛИКОМ В ПАМЯТИ
 * ------------------------------------------------------------------
 * В заголовке файла внутри архива стоят контрольная сумма и оба размера —
 * сжатый и исходный. Узнать их до сжатия нельзя. У формата есть обход
 * (флаг 0x08 и «описатель данных» после данных), но он делает архив
 * неудобным для части распаковщиков и усложняет запись вдвое.
 *
 * Держать письмо в памяти целиком мы можем себе позволить, и это не
 * допущение: размер письма ограничен MESSAGE_MAX_BYTES (25 МБ), Postfix
 * настроен на тот же предел, письма больше в ящик просто не попадают.
 * ОДНО письмо за раз — не весь архив; ящик на десять гигабайт проходит
 * этим же кодом, не занимая больше десятков мегабайт.
 *
 * ------------------------------------------------------------------
 * ZIP64
 * ------------------------------------------------------------------
 * Обязателен: в исходном формате размер архива и смещения внутри него —
 * 32-битные, то есть потолок 4 ГБ и 65535 файлов. Ящик на гигабайты
 * упирается в оба, и упирается МОЛЧА — получился бы архив, который
 * открывается и показывает не те файлы. Поэтому расширенные поля
 * пишутся там, где значение не помещается, а хвост архива — в форме
 * ZIP64, как только перестало помещаться хоть что-нибудь.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { once } from 'node:events';

/** Порог, после которого значение в 32 бита не помещается. */
const U32_MAX = 0xffffffff;
/** Столько файлов помещается в оглавление исходного формата. */
const U16_MAX = 0xffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** Способ хранения: 0 — как есть, 8 — deflate. */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Флаг «имя файла в UTF-8» (бит 11).
 *
 * Без него имя папки по-русски приезжает в распаковщик как набор
 * вопросительных знаков: исходная кодировка имён в ZIP — CP437, и
 * распаковщик обязан считать имя ею, пока не сказано обратное.
 */
const FLAG_UTF8 = 0x0800;

/* ------------------------------------------------------------------ */
/* CRC-32                                                               */
/* ------------------------------------------------------------------ */

/**
 * Таблица CRC-32 (полином 0xEDB88320) — та же, что у zlib и ZIP.
 *
 * Считается один раз при загрузке модуля: 256 значений, доли миллисекунды.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Время в формате MS-DOS                                               */
/* ------------------------------------------------------------------ */

/**
 * Дата и время файла внутри архива.
 *
 * Формат древний: секунды с точностью до двух, год от 1980. Поэтому дата
 * письма 1975 года (а такие в архивах встречаются — часы отправителя врут)
 * прижимается к 1 января 1980, а не уезжает в отрицательные числа, из
 * которых распаковщик покажет что угодно.
 */
export function dosDateTime(at: Date): { time: number; date: number } {
  const year = at.getFullYear();
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const capped = Math.min(year, 2107);
  const date = ((capped - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2);
  return { time, date };
}

/* ------------------------------------------------------------------ */
/* Имена внутри архива                                                  */
/* ------------------------------------------------------------------ */

/**
 * Приводит имя к тому, что можно записать на диск после распаковки.
 *
 * Здесь не «на всякий случай», а защита: имя складывается из пути папки
 * IMAP и темы письма, то есть из ДАННЫХ. Папка может называться `..`,
 * тема — содержать `/` или управляющие символы, и распакованный архив
 * тогда пишет файл мимо своего каталога. Это классическая дыра («Zip
 * Slip»), и закрывается она здесь, а не в распаковщике.
 */
export function safeEntryName(name: string): string {
  const cleaned = cleanSegment(name);
  return cleaned === '' ? 'без имени' : cleaned;
}

/**
 * Чистка одного отрезка пути; пустая строка означает «здесь не осталось
 * ничего осмысленного».
 *
 * Отдельно от safeEntryName ровно из-за этой пустой строки: имени файла
 * подставить вместо неё «без имени» надо, а уровню пути — не надо, такой
 * уровень просто выбрасывается.
 */
function cleanSegment(name: string): string {
  return (
    name
      // Разделитель пути, управляющие символы и то, что запрещено в именах
      // файлов Windows. Разделитель здесь не забыт: имя складывается из
      // темы письма, а тема со слэшем — обычное дело.
      // Запрет на управляющие символы снят осознанно: чистка от них —
      // и есть смысл этой строки.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f/<>:"\\|?*]/gu, ' ')
      .replace(/\s+/gu, ' ')
      // Две и больше точек подряд — это `..`, то есть уход на уровень выше.
      .replace(/\.{2,}/gu, '.')
      // Точки по краям: ведущая делает файл скрытым в Unix, хвостовую
      // Windows молча отбрасывает — и два разных имени становятся одним.
      .replace(/^[.\s]+/u, '')
      .replace(/[.\s]+$/u, '')
  );
}

/** То же для пути целиком: каждый уровень чистится отдельно. */
export function safeEntryPath(parts: readonly string[]): string {
  return parts
    .map((part) => cleanSegment(part))
    .filter((part) => part !== '')
    .join('/');
}

/* ------------------------------------------------------------------ */
/* Запись                                                               */
/* ------------------------------------------------------------------ */

interface CentralEntry {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Сколько байт архив уже занял и сколько в нём файлов. */
export interface ZipProgress {
  entries: number;
  bytes: number;
}

export class ZipWriter {
  readonly #stream: WriteStream;
  readonly #entries: CentralEntry[] = [];
  #offset = 0;
  #closed = false;

  constructor(path: string) {
    this.#stream = createWriteStream(path);
  }

  get bytesWritten(): number {
    return this.#offset;
  }

  get entryCount(): number {
    return this.#entries.length;
  }

  /**
   * Записывает буфер в поток, дожидаясь готовности.
   *
   * Ожидание обязательно: без него запись гигабайтного архива копит в
   * памяти всё, что диск не успел принять, и процесс упирается в потолок
   * кучи (512 МБ) на ящике, который прекрасно поместился бы на диск.
   */
  async #write(chunk: Buffer): Promise<void> {
    if (!this.#stream.write(chunk)) await once(this.#stream, 'drain');
    this.#offset += chunk.length;
  }

  /**
   * Добавляет файл в архив.
   *
   * `data` — готовые байты (у нас это письмо целиком, как его отдал IMAP).
   * Сжимаем только если от этого есть польза: письмо, состоящее из уже
   * сжатого вложения (jpeg, zip, docx), от deflate вырастает, и хранить
   * его как есть и быстрее, и меньше.
   */
  async add(name: string, data: Buffer, at: Date): Promise<void> {
    if (this.#closed) throw new Error('Архив уже закрыт');

    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(at);

    const deflated = deflateRawSync(data, { level: 6 });
    const compressed = deflated.length < data.length;
    const method = compressed ? METHOD_DEFLATE : METHOD_STORE;
    const payload: Buffer = compressed ? deflated : data;

    const offset = this.#offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    // Версия 2.0 — минимальная, поддерживающая deflate и каталоги.
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    await this.#write(local);
    await this.#write(nameBuf);
    await this.#write(payload);

    this.#entries.push({
      name: nameBuf,
      method,
      time,
      date,
      crc,
      compressedSize: payload.length,
      size: data.length,
      offset,
    });
  }

  /** Оглавление и хвост. После него архив можно открывать. */
  async finish(): Promise<number> {
    if (this.#closed) return this.#offset;
    this.#closed = true;

    const centralOffset = this.#offset;
    for (const entry of this.#entries) {
      await this.#write(centralRecord(entry));
    }
    const centralSize = this.#offset - centralOffset;

    /*
     * Нужен ли ZIP64. Проверяются ровно те три величины, которые в
     * исходном формате 32- и 16-битные: число файлов, размер оглавления
     * и его смещение. Смещение — самое частое: оно упирается в 4 ГБ
     * раньше всего остального.
     */
    const needsZip64 =
      this.#entries.length > U16_MAX || centralOffset > U32_MAX || centralSize > U32_MAX;

    if (needsZip64) {
      const eocd64 = Buffer.alloc(56);
      eocd64.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      // Размер этой записи без первых 12 байт — так велит формат.
      eocd64.writeBigUInt64LE(BigInt(44), 4);
      // Кем создан (4.5) и что нужно для чтения (4.5 = ZIP64).
      eocd64.writeUInt16LE(45, 12);
      eocd64.writeUInt16LE(45, 14);
      eocd64.writeUInt32LE(0, 16);
      eocd64.writeUInt32LE(0, 20);
      eocd64.writeBigUInt64LE(BigInt(this.#entries.length), 24);
      eocd64.writeBigUInt64LE(BigInt(this.#entries.length), 32);
      eocd64.writeBigUInt64LE(BigInt(centralSize), 40);
      eocd64.writeBigUInt64LE(BigInt(centralOffset), 48);
      const eocd64Offset = this.#offset;
      await this.#write(eocd64);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(eocd64Offset), 8);
      locator.writeUInt32LE(1, 16);
      await this.#write(locator);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    // При ZIP64 сюда кладутся «все единицы» — знак «настоящее значение
    // в записи ZIP64 выше». Иначе распаковщик прочтёт обрезанное число.
    eocd.writeUInt16LE(Math.min(this.#entries.length, U16_MAX), 8);
    eocd.writeUInt16LE(Math.min(this.#entries.length, U16_MAX), 10);
    eocd.writeUInt32LE(Math.min(centralSize, U32_MAX), 12);
    eocd.writeUInt32LE(Math.min(centralOffset, U32_MAX), 16);
    eocd.writeUInt16LE(0, 20);
    await this.#write(eocd);

    await new Promise<void>((resolve, reject) => {
      this.#stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return this.#offset;
  }

  /** Закрывает поток, не дописывая оглавление: задание сорвалось. */
  async abort(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => this.#stream.close(() => resolve()));
  }
}

/** Одна запись оглавления, при необходимости — с полем ZIP64. */
function centralRecord(entry: CentralEntry): Buffer {
  // Расширенное поле нужно ровно тем записям, у которых что-то не влезло
  // в 32 бита. Писать его всем подряд нельзя: часть распаковщиков считает
  // лишнее поле ошибкой.
  const bigOffset = entry.offset > U32_MAX;
  const bigSize = entry.size > U32_MAX || entry.compressedSize > U32_MAX;
  const extraParts: Buffer[] = [];
  if (bigOffset || bigSize) {
    const values: bigint[] = [];
    // Порядок значений в поле 0x0001 задан форматом и НЕ произвольный:
    // сперва исходный размер, потом сжатый, потом смещение. Пишутся
    // только те, что помечены «все единицы» в основной записи.
    if (bigSize) values.push(BigInt(entry.size), BigInt(entry.compressedSize));
    if (bigOffset) values.push(BigInt(entry.offset));
    const body = Buffer.alloc(4 + values.length * 8);
    body.writeUInt16LE(0x0001, 0);
    body.writeUInt16LE(values.length * 8, 2);
    values.forEach((value, i) => body.writeBigUInt64LE(value, 4 + i * 8));
    extraParts.push(body);
  }
  const extra = extraParts.length > 0 ? Buffer.concat(extraParts) : Buffer.alloc(0);

  const head = Buffer.alloc(46);
  head.writeUInt32LE(SIG_CENTRAL, 0);
  // Кем создан: старший байт 3 — Unix (тогда права из внешних атрибутов
  // читаются правильно), младший — версия формата.
  head.writeUInt16LE((3 << 8) | (bigOffset || bigSize ? 45 : 20), 4);
  head.writeUInt16LE(bigOffset || bigSize ? 45 : 20, 6);
  head.writeUInt16LE(FLAG_UTF8, 8);
  head.writeUInt16LE(entry.method, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(bigSize ? U32_MAX : entry.compressedSize, 20);
  head.writeUInt32LE(bigSize ? U32_MAX : entry.size, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(extra.length, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  // Внешние атрибуты: обычный файл с правами 0644, сдвинутыми в старшее
  // слово, — так распакованный файл не оказывается исполняемым.
  head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  head.writeUInt32LE(bigOffset ? U32_MAX : entry.offset, 42);

  return Buffer.concat([head, entry.name, extra]);
}
