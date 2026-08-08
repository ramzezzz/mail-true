/**
 * Страна входа: загрузка базы и решение «пускать или нет».
 *
 * ------------------------------------------------------------------
 * ЧТО ЭТО ЗАКРЫВАЕТ И ЧЕГО НЕ ЗАКРЫВАЕТ
 * ------------------------------------------------------------------
 * Подобранный пароль выглядит для сервера как обычный вход: правильная
 * пара логин-пароль, никаких неудач в журнале, ограничения частоты и
 * запреты по адресу молчат — они ловят ПОПЫТКИ, а тут попытка удалась.
 * Единственное, что отличает такой вход от настоящего, — он приходит
 * оттуда, откуда ваши сотрудники не ходят.
 *
 * Отсюда обе стороны честного описания:
 *   • страна не защищает от подобранного пароля вообще — она защищает от
 *     того, что подбирающий сидит не там же, где вы;
 *   • подделать её нельзя иначе как через прокси в нужной стране, и это
 *     ровно та цена, которую мы хотим назначить.
 *
 * Проверяется ТОЛЬКО вход человека — в почту и в панель. Входящая почта
 * от чужих серверов по стране не фильтруется и фильтроваться не будет:
 * письмо из другой страны — это обычное письмо, а не подозрение.
 *
 * ------------------------------------------------------------------
 * КОГДА ПУСКАЕМ БЕЗ ВОПРОСОВ
 * ------------------------------------------------------------------
 * Три случая, и все три — намеренно в пользу входящего:
 *   1. Адрес из локальной сети. У него нет страны, и вход из офиса не
 *      должен зависеть от базы вовсе.
 *   2. Базы нет или она не загрузилась. Проверка, которая при своей же
 *      поломке запирает всех, хуже отсутствующей.
 *   3. Страна неизвестна. База отстаёт от жизни на месяцы, а адресные
 *      диапазоны выдают заново каждую неделю.
 *
 * Ответ «не знаю» никогда не превращается в отказ. Это сознательный
 * перекос: цена ложного отказа здесь — запертый администратор без другого
 * способа войти, цена ложного пропуска — вход, который всё равно виден в
 * журнале и всё равно требует верного пароля.
 */
import { readFile, stat } from 'node:fs/promises';
import type { Logger } from 'pino';
import { isPrivateIp, normalizeIp } from '../settings/access-log.js';
import { emptyIndex, lookupCountry, parseCountryCsv, type GeoIpIndex } from './parse.js';

export { lookupCountry, parseCountryCsv } from './parse.js';
export type { GeoIpIndex } from './parse.js';

/** Что делать со входом из страны не из списка. */
export type GeoIpPolicy = 'off' | 'log' | 'allow';

export interface GeoIpVerdict {
  /** Пускать ли. false бывает только при политике allow. */
  allowed: boolean;
  /** Код страны или null, если неизвестна (в том числе локальный адрес). */
  country: string | null;
  /** Словами — для журнала и для человека. */
  reason: string;
}

export interface GeoIpOptions {
  path: string;
  policy: GeoIpPolicy;
  /** Разрешённые страны, коды в верхнем регистре. */
  allowed: readonly string[];
  logger: Logger;
}

/**
 * База стран. Живёт одна на процесс: файл читается при первом обращении и
 * держится в памяти — десяток мегабайт текста превращается в пару
 * мегабайт типизированных массивов, а вход не должен ждать диска.
 */
export class GeoIpDatabase {
  #index: GeoIpIndex = emptyIndex();
  #loaded = false;
  #loading: Promise<void> | null = null;
  #error: string | null = null;
  #fileDate: Date | null = null;

  constructor(private readonly opts: GeoIpOptions) {}

  /** Включена ли проверка. off — база даже не читается. */
  get enabled(): boolean {
    return this.opts.policy !== 'off';
  }

  get policy(): GeoIpPolicy {
    return this.opts.policy;
  }

  /** Состояние для раздела «Наблюдение»: есть ли база и насколько свежая. */
  get state(): {
    loaded: boolean;
    rows: number;
    skipped: number;
    error: string | null;
    fileDate: Date | null;
  } {
    return {
      loaded: this.#loaded,
      rows: this.#index.rows,
      skipped: this.#index.skipped,
      error: this.#error,
      fileDate: this.#fileDate,
    };
  }

  /**
   * Читает файл базы. Повторные вызовы не перечитывают: пока процесс жив,
   * база одна. Обновление базы — это новый файл и перезапуск службы.
   */
  async load(): Promise<void> {
    if (this.#loaded || !this.enabled) return;
    // Несколько одновременных входов при холодном старте не должны читать
    // и разбирать файл каждый сам по себе.
    this.#loading ??= this.#read();
    await this.#loading;
  }

  async #read(): Promise<void> {
    try {
      const info = await stat(this.opts.path);
      this.#fileDate = info.mtime;
      const text = await readFile(this.opts.path, 'utf8');
      this.#index = parseCountryCsv(text);
      this.#loaded = true;
      this.#error = null;
      this.opts.logger.info(
        { rows: this.#index.rows, skipped: this.#index.skipped },
        'База стран загружена',
      );
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
      this.#loaded = false;
      // Не ошибка уровня error: отсутствие базы — это штатное состояние
      // сервера, на котором её не скачивали. Вход при этом работает.
      this.opts.logger.warn(
        { path: this.opts.path, err: this.#error },
        'База стран недоступна: вход по стране не проверяется',
      );
    } finally {
      this.#loading = null;
    }
  }

  /** Страна адреса или null. Локальные адреса — всегда null. */
  countryOf(ip: string): string | null {
    const value = normalizeIp(ip);
    if (value === '' || isPrivateIp(value)) return null;
    return lookupCountry(this.#index, value);
  }

  /**
   * Решение по входу. Никогда не бросает: сбой определения страны не
   * имеет права мешать человеку войти.
   */
  check(ip: string): GeoIpVerdict {
    if (this.opts.policy === 'off') {
      return { allowed: true, country: null, reason: 'проверка страны выключена' };
    }

    const value = normalizeIp(ip);
    if (value === '' || isPrivateIp(value)) {
      return { allowed: true, country: null, reason: 'локальная сеть' };
    }
    if (!this.#loaded) {
      return { allowed: true, country: null, reason: 'база стран не загружена' };
    }

    const country = lookupCountry(this.#index, value);
    if (country === null) {
      return { allowed: true, country: null, reason: 'страна адреса неизвестна' };
    }
    if (this.opts.policy === 'log') {
      return { allowed: true, country, reason: `вход из страны ${country}` };
    }
    // Пустой список при политике allow — это не «запретить всё», а
    // «список не заполнили». Запирать сервер из-за незаполненной
    // настройки нельзя.
    if (this.opts.allowed.length === 0) {
      return { allowed: true, country, reason: 'список разрешённых стран пуст' };
    }
    const allowed = this.opts.allowed.includes(country);
    return {
      allowed,
      country,
      reason: allowed ? `страна ${country} разрешена` : `страна ${country} не в списке разрешённых`,
    };
  }
}

/** Разбор списка стран из настройки: «RU, by ; KZ» → ['RU','BY','KZ']. */
export function parseCountryList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((part) => part.trim().toUpperCase())
        .filter((part) => /^[A-Z]{2}$/.test(part)),
    ),
  ];
}
