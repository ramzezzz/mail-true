/**
 * Страна по адресу: разбор страновой базы и поиск по ней.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ВООБЩЕ ПОЯВИЛОСЬ, ЕСЛИ РАНЬШЕ БЫЛО НАПИСАНО «НЕ БУДЕМ»
 * ------------------------------------------------------------------
 * В журнале доступа (settings/access-log.ts) прямо сказано: страну по
 * адресу не определяем, потому что для этого нужна либо база в сотни
 * мегабайт, либо запрос в чужую службу — то есть выдача адресов наших
 * пользователей наружу.
 *
 * Второй довод остаётся в силе и здесь: наружу не уходит ничего, поиск
 * идёт по файлу на диске. А первый касался ГОРОДСКОЙ базы. Страновая —
 * это список диапазонов и двухбуквенных кодов, десяток мегабайт текстом,
 * и для ответа «вход из другой страны» её достаточно с запасом. Города,
 * координаты, провайдера мы не знаем и знать не хотим.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ CSV, А НЕ ГОТОВЫЙ ЧИТАТЕЛЬ MMDB
 * ------------------------------------------------------------------
 * Двоичный формат MaxMind читается сторонним пакетом. Пакет — это ещё
 * одна зависимость в службе, которая разбирает данные из интернета, и
 * ещё один разбор бинарного формата в том же процессе, что и почта.
 * Текстовый список диапазонов разбирается тридцатью строками, которые
 * видно целиком, и проверяется обычными тестами.
 *
 * ------------------------------------------------------------------
 * КАК ХРАНИТСЯ
 * ------------------------------------------------------------------
 * Двести тысяч диапазонов в виде объектов съели бы десятки мегабайт
 * памяти — на VPS с двумя гигабайтами это заметная доля. Поэтому границы
 * лежат в типизированных массивах: IPv4 — парой Uint32Array, IPv6 —
 * парой BigUint64Array по старшим 64 битам адреса. Страновых кодов в мире
 * меньше трёхсот, поэтому у каждой строки хранится не код, а номер в
 * словаре — один байт.
 *
 * Старших 64 бит IPv6 достаточно: страновые записи не бывают мельче /64,
 * в базе они /32–/48.
 */

/** Готовый к поиску набор диапазонов. */
export interface GeoIpIndex {
  /** Начала диапазонов IPv4, по возрастанию. */
  v4start: Uint32Array;
  v4end: Uint32Array;
  /** Номер страны в словаре countries. */
  v4country: Uint8Array;
  v6start: BigUint64Array;
  v6end: BigUint64Array;
  v6country: Uint8Array;
  /** Двухбуквенные коды; индекс 0 — «страна неизвестна». */
  countries: string[];
  /** Сколько строк разобрано и сколько пропущено как негодные. */
  rows: number;
  skipped: number;
}

/** Пустой набор: база не загружена. Поиск по нему всегда «не знаю». */
export function emptyIndex(): GeoIpIndex {
  return {
    v4start: new Uint32Array(0),
    v4end: new Uint32Array(0),
    v4country: new Uint8Array(0),
    v6start: new BigUint64Array(0),
    v6end: new BigUint64Array(0),
    v6country: new Uint8Array(0),
    countries: [''],
    rows: 0,
    skipped: 0,
  };
}

/** Адрес IPv4 числом. undefined — это не IPv4. */
export function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const byte = Number(part);
    if (byte > 255) return undefined;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

/**
 * Старшие 64 бита адреса IPv6.
 *
 * Форма `::ffff:1.2.3.4` здесь намеренно НЕ поддерживается: такой адрес —
 * это IPv4, и приводить его к общему виду обязан вызывающий (для этого
 * есть normalizeIp в журнале доступа). Иначе один и тот же адрес искался
 * бы то в одной половине базы, то в другой.
 */
export function ipv6ToHigh64(ip: string): bigint | undefined {
  const value = ip.trim().toLowerCase();
  if (!value.includes(':')) return undefined;
  if (value.includes('.')) return undefined;
  const halves = value.split('::');
  if (halves.length > 2) return undefined;

  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (head.length + tail.length > 8) return undefined;

  const groups: string[] = [
    ...head,
    ...new Array<string>(8 - head.length - tail.length).fill('0'),
    ...tail,
  ];

  let result = 0n;
  // Только первые четыре группы: это и есть старшие 64 бита.
  for (let i = 0; i < 4; i += 1) {
    const group = groups[i] ?? '0';
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

/**
 * Разбор строк вида `1.0.0.0,1.0.0.255,AU`.
 *
 * Кавычки вокруг полей допускаются — их ставит часть выгрузок. Строка, в
 * которой что-то не так, ПРОПУСКАЕТСЯ, а не роняет разбор: база
 * скачивается из интернета, и одна битая строка в двухстах тысячах не
 * повод остаться вовсе без определения страны. Сколько пропущено — видно
 * в rows/skipped, и это показывается в панели.
 */
export function parseCountryCsv(text: string): GeoIpIndex {
  const v4: Array<{ start: number; end: number; country: number }> = [];
  const v6: Array<{ start: bigint; end: bigint; country: number }> = [];
  const countries: string[] = [''];
  const byCode = new Map<string, number>();
  let skipped = 0;

  const codeIndex = (code: string): number => {
    const known = byCode.get(code);
    if (known !== undefined) return known;
    // Больше 255 стран не бывает, но если выгрузка окажется странной —
    // лишние коды станут «неизвестно», а не сломают Uint8Array.
    if (countries.length > 255) return 0;
    const index = countries.length;
    countries.push(code);
    byCode.set(code, index);
    return index;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    if (cells.length < 3) {
      skipped += 1;
      continue;
    }
    const [from, to, rawCode] = cells as [string, string, string];
    const code = rawCode.toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      skipped += 1;
      continue;
    }

    const start4 = ipv4ToNumber(from);
    const end4 = ipv4ToNumber(to);
    if (start4 !== undefined && end4 !== undefined) {
      if (start4 > end4) {
        skipped += 1;
        continue;
      }
      v4.push({ start: start4, end: end4, country: codeIndex(code) });
      continue;
    }

    const start6 = ipv6ToHigh64(from);
    const end6 = ipv6ToHigh64(to);
    if (start6 !== undefined && end6 !== undefined && start6 <= end6) {
      v6.push({ start: start6, end: end6, country: codeIndex(code) });
      continue;
    }
    skipped += 1;
  }

  // Поиск двоичный, поэтому порядок обязателен. Выгрузка приходит
  // отсортированной, но полагаться на это нельзя: перепутанный порядок
  // дал бы не ошибку, а тихо неверные ответы.
  v4.sort((a, b) => a.start - b.start);
  v6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const index: GeoIpIndex = {
    v4start: new Uint32Array(v4.length),
    v4end: new Uint32Array(v4.length),
    v4country: new Uint8Array(v4.length),
    v6start: new BigUint64Array(v6.length),
    v6end: new BigUint64Array(v6.length),
    v6country: new Uint8Array(v6.length),
    countries,
    rows: v4.length + v6.length,
    skipped,
  };
  v4.forEach((row, i) => {
    index.v4start[i] = row.start;
    index.v4end[i] = row.end;
    index.v4country[i] = row.country;
  });
  v6.forEach((row, i) => {
    index.v6start[i] = row.start;
    index.v6end[i] = row.end;
    index.v6country[i] = row.country;
  });
  return index;
}

/**
 * Двухбуквенный код страны или null, если адрес не найден.
 *
 * null — это «не знаю», и он никогда не должен превращаться в отказ во
 * входе: база может отстать от жизни, а адрес — оказаться из диапазона,
 * появившегося позже неё.
 */
export function lookupCountry(index: GeoIpIndex, ip: string): string | null {
  const v4 = ipv4ToNumber(ip);
  if (v4 !== undefined) return search(index.v4start, index.v4end, index.v4country, v4, index);

  const v6 = ipv6ToHigh64(ip);
  if (v6 !== undefined) return search(index.v6start, index.v6end, index.v6country, v6, index);

  return null;
}

function search(
  starts: Uint32Array | BigUint64Array,
  ends: Uint32Array | BigUint64Array,
  codes: Uint8Array,
  needle: number | bigint,
  index: GeoIpIndex,
): string | null {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    // Диапазоны не пересекаются, поэтому достаточно найти последний,
    // начало которого не больше искомого адреса, и проверить его конец.
    if (starts[mid]! <= needle) {
      if (ends[mid]! >= needle) {
        const code = index.countries[codes[mid]!];
        return code === undefined || code === '' ? null : code;
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return null;
}
