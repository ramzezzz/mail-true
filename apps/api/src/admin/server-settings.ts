/**
 * Хранилище настроек сервера: чтение с кэшем, запись, возврат к умолчанию.
 *
 * ------------------------------------------------------------------
 * ПОРЯДОК РАЗРЕШЕНИЯ ЗНАЧЕНИЯ
 * ------------------------------------------------------------------
 *   строка в server_settings  >  переменная окружения  >  умолчание в коде
 *
 * База ПОБЕЖДАЕТ окружение, а не наоборот. Обратный порядок означал бы,
 * что каждое обновление образа откатывает всё, что администратор задал
 * в панели: docker-compose.yml подставляет свои значения в окружение
 * почти для каждого ключа, и они «перебивали» бы базу при каждом старте.
 * А выбранный порядок даёт то, что нужно: сервер, где панелью никто не
 * пользовался, ведёт себя ровно как раньше (таблица пуста — работает
 * окружение), и ни одно обновление ничего не ломает.
 *
 * ------------------------------------------------------------------
 * ДВА СПОСОБА ЧИТАТЬ — И ЗАЧЕМ ИХ ДВА
 * ------------------------------------------------------------------
 * 1. ЖИВОЕ чтение (`int`, `bool`, `text`) — для настроек группы live.
 *    Значение спрашивается у хранилища при КАЖДОМ обращении, поэтому
 *    сохранение в панели действует со следующего запроса. Между походами
 *    в базу стоит короткий кэш: настройки читаются на каждый вход в
 *    панель и на каждое создание ящика, и запрос к Postgres на каждое
 *    такое обращение был бы платой ни за что. Своя же запись кэш сбрасывает
 *    немедленно — иначе человек нажимал бы «Сохранить» и видел старое.
 *
 * 2. ПОДМЕШИВАНИЕ В ОКРУЖЕНИЕ (`applyStoredEnv`) — для настроек группы
 *    restart. Вызывается ОДИН раз при старте, до разбора схем окружения,
 *    и кладёт сохранённые значения в process.env. Благодаря этому группу
 *    restart получают сразу все модули — почта, уведомления, логотипы,
 *    сбор чужой почты, — а не только те, куда дописан отдельный вызов.
 *    Цена ровно одна: значение начинает действовать после перезапуска
 *    контейнера api, о чём панель и предупреждает.
 *
 * ------------------------------------------------------------------
 * ЧТО СЮДА НЕ ПОПАДАЕТ
 * ------------------------------------------------------------------
 * Ключи, которых нет в списке разрешённого (server-settings-registry.ts),
 * не читаются ни первым способом, ни вторым. То есть строка в базе с
 * ключом `DATABASE_URL` или `SESSION_SECRET` не действует ни на что —
 * даже если её туда положили в обход панели.
 */
import { isIP } from 'node:net';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { BadRequestError } from '../errors.js';
import type { AdminDb } from './db.js';
import { isUndefinedTable } from './db.js';
import {
  findSetting,
  isEditable,
  SETTING_SPECS,
  type SettingSpec,
} from './server-settings-registry.js';

/** Откуда взято действующее значение. */
export type SettingSource = 'db' | 'env' | 'default';

/** Значение настройки в том виде, в каком его показывает панель. */
export type SettingValue = string | number | boolean;

export interface ResolvedSetting {
  spec: SettingSpec;
  /** Действующее значение строкой — ровно как в окружении. */
  raw: string;
  source: SettingSource;
  /**
   * С ЧЕМ ЖИВОЙ ПРОЦЕСС СТАРТОВАЛ — то есть что на самом деле читают
   * модули группы restart прямо сейчас.
   *
   * Нужно ровно для одного, зато важного: понять, ждёт ли настройка
   * перезапуска. При старте сохранённые значения подмешиваются в
   * окружение (applyStoredEnv), поэтому сразу после запуска здесь и в
   * `raw` одно и то же. Разошлись — значит настройку меняли уже после
   * старта, и до перезапуска контейнера действует прежнее. Без этого
   * поля панель могла бы только обещать «нужен перезапуск» вообще, а не
   * говорить, что перезапуск нужен ИМЕННО СЕЙЧАС и ИМЕННО из-за этого.
   *
   * Это НЕ то же самое, что «строка в окружении сейчас». Разница
   * вылезает при сбросе: он возвращает окружению прежнее (файловое)
   * значение, и читать его как «с чем работает процесс» значило бы
   * сказать «перезапуск не нужен» о процессе, который до сих пор живёт
   * с тем, что было в базе. Поэтому значение старта помнится отдельно
   * (см. startedWith ниже) и переживает сброс.
   */
  envRaw: string | undefined;
  /** Кто и когда менял, если значение из базы. */
  updatedBy: string | null;
  updatedAt: Date | null;
}

interface StoredRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: Date;
}

/** Строка из базы вместе со следом «кто и когда». */
interface Stored {
  value: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ */
/* Разбор и проверка значений                                          */
/* ------------------------------------------------------------------ */

/** Приводит значение к каноничной строке; при негодном — понятный отказ. */
export function parseSettingValue(spec: SettingSpec, input: unknown): string {
  // Число и «да/нет» приходят из панели как есть — приводим их к строке,
  // всё прочее (объект, массив) значением настройки быть не может.
  let raw: string;
  if (typeof input === 'string') raw = input.trim();
  else if (typeof input === 'number' || typeof input === 'boolean') raw = String(input);
  else if (input === null || input === undefined) raw = '';
  else throw new BadRequestError(`Настройка «${spec.key}»: значение неподходящего вида.`);
  raw = raw.trim();

  if (raw === '') {
    if (spec.allowEmpty) return '';
    throw new BadRequestError(`Настройка «${spec.key}» не может быть пустой.`);
  }

  switch (spec.kind) {
    case 'int': {
      if (!/^-?\d+$/u.test(raw)) {
        throw new BadRequestError(`Настройка «${spec.key}» — целое число, а пришло «${raw}».`);
      }
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) {
        throw new BadRequestError(`Значение «${raw}» слишком велико для настройки «${spec.key}».`);
      }
      if (spec.min !== undefined && n < spec.min) {
        throw new BadRequestError(`Настройка «${spec.key}»: минимум ${spec.min}, а пришло ${n}.`);
      }
      if (spec.max !== undefined && n > spec.max) {
        throw new BadRequestError(`Настройка «${spec.key}»: максимум ${spec.max}, а пришло ${n}.`);
      }
      return String(n);
    }
    case 'bool': {
      const lower = raw.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lower)) return 'true';
      if (['false', '0', 'no', 'off'].includes(lower)) return 'false';
      throw new BadRequestError(`Настройка «${spec.key}» — да или нет, а пришло «${raw}».`);
    }
    case 'enum': {
      if (!spec.options?.includes(raw)) {
        throw new BadRequestError(
          `Настройка «${spec.key}» принимает одно из: ${(spec.options ?? []).join(', ')}. ` +
            `Пришло «${raw}».`,
        );
      }
      return raw;
    }
    case 'string': {
      if (raw.length > 512) {
        throw new BadRequestError(`Настройка «${spec.key}»: не длиннее 512 символов.`);
      }
      // Перевод строки в переменной окружения — способ подсунуть вторую
      // переменную тому, кто разбирает окружение построчно.
      if (/[\r\n\0]/u.test(raw)) {
        throw new BadRequestError(`Настройка «${spec.key}»: перевод строки в значении недопустим.`);
      }
      /*
       * Адреса резольверов проверяются ЗДЕСЬ, при сохранении.
       *
       * Дальше их получает dns.Resolver, а он принимает только IP и на
       * имени бросает синхронно. Одна опечатка («8.8.8» вместо
       * «8.8.8.8») или имя вместо адреса — и раздел «Домены и DNS»
       * отвечал 500 для ВСЕХ доменов сразу, причём сообщение не называло
       * ни причину, ни настройку. Сказать об этом надо в тот момент,
       * когда человек значение вводит.
       *
       * Имя сюда не годится и по существу: разрешать его пришлось бы
       * через тот же DNS, который мы и проверяем.
       */
      if (spec.key === 'DNS_CHECK_RESOLVERS' && raw.trim() !== '') {
        const bad = raw
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '' && isIP(item) === 0);
        if (bad.length > 0) {
          throw new BadRequestError(
            `Настройка «${spec.key}»: это не IP-адреса: ${bad.join(', ')}. ` +
              'Резольверы задаются адресами (1.1.1.1, 2606:4700:4700::1111): имя пришлось бы ' +
              'разрешать через тот же DNS, который мы проверяем.',
          );
        }
      }
      return raw;
    }
  }
}

/** Значение строкой -> значение того типа, который ждёт панель. */
export function typedValue(spec: SettingSpec, raw: string): SettingValue {
  if (spec.kind === 'int') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  /*
   * «Да» пишут по-разному, и панель обязана понимать все написания.
   *
   * Раньше здесь стояло `raw === 'true' || raw === '1'`, а соседняя
   * функция bool() — та, по которой значение читает САМ СЕРВЕР, —
   * принимала ещё yes и on. Расхождение стоило прямой лжи на экране: в
   * infra/.env штатно лежат `DOVECOT_DISABLE_PLAINTEXT_AUTH=yes` и
   * `UNBOUND_DNSSEC=yes` (так их пишет установщик и так их читают сами
   * службы), а панель показывала оба переключателя ВЫКЛЮЧЕННЫМИ. То есть
   * сообщала, что пароль принимается по нешифрованному соединению и
   * подписи DNS не проверяются, — когда всё было наоборот.
   *
   * Список написаний здесь и в bool() обязан совпадать: это одно и то же
   * значение, прочитанное для двух разных читателей.
   */
  if (spec.kind === 'bool') return isTruthy(raw);
  return raw;
}

/**
 * «Да» во всех написаниях, которые встречаются в infra/.env.
 *
 * Одна функция на двоих читателей — экран и код сервера — намеренно.
 * Раньше их было две, и они разошлись: панель принимала только true/1, а
 * `bool()` ещё yes/on. В файле же штатно лежат
 * `DOVECOT_DISABLE_PLAINTEXT_AUTH=yes` и `UNBOUND_DNSSEC=yes` (так их
 * пишет установщик и так их читают сами службы) — и панель показывала оба
 * переключателя ВЫКЛЮЧЕННЫМИ. То есть сообщала, что пароль ходит по
 * нешифрованному соединению и подписи DNS не проверяются, когда всё было
 * ровно наоборот.
 *
 * Регистр и пробелы по краям не значат ничего: значение правят руками в
 * текстовом файле, и «YES» с пробелом на конце — обычное дело.
 */
export function isTruthy(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/**
 * Значение из окружения, если оно там осмысленно задано.
 *
 * Пустая строка считается «не задано» для всех типов, кроме тех, у кого
 * пустота — осмысленное значение (allowEmpty). Так сделано потому, что
 * docker-compose.yml подставляет `${VAR:-умолчание}` почти везде, и пустая
 * переменная означает ровно «человек стёр значение», а не «пусть будет 0».
 * Раньше пустой числовой ключ превращался в ноль (Number('') === 0), и,
 * например, стёртый MAIL_FLOW_RETENTION_DAYS означал бы «хранить ноль дней».
 */
function fromEnv(spec: SettingSpec, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[spec.key];
  if (value === undefined) return undefined;
  if (value === '' && !spec.allowEmpty) return undefined;
  return value;
}

/* ------------------------------------------------------------------ */
/* Хранилище                                                           */
/* ------------------------------------------------------------------ */

export interface ServerSettingsOptions {
  /**
   * Подключение к базе. null означает «базы нет»: хранилище работает
   * только на окружении и умолчаниях. Так его собирают проверки маршрутов,
   * которым до настроек сервера дела нет.
   */
  db: Pick<AdminDb, 'query'> | null;
  env?: NodeJS.ProcessEnv;
  /** Срок годности кэша, мс. */
  cacheMs?: number;
  logger?: Logger;
}

export class ServerSettings {
  readonly #db: Pick<AdminDb, 'query'> | null;
  readonly #env: NodeJS.ProcessEnv;
  readonly #cacheMs: number;
  readonly #logger: Logger | undefined;

  #cache: Map<string, Stored> = new Map();
  #expiresAt = 0;
  #inFlight: Promise<Map<string, Stored>> | null = null;
  /** О ненайденной таблице говорим в журнал один раз, а не каждые пять секунд. */
  #warnedMissingTable = false;

  constructor(opts: ServerSettingsOptions) {
    this.#db = opts.db;
    this.#env = opts.env ?? process.env;
    this.#cacheMs = opts.cacheMs ?? 5000;
    this.#logger = opts.logger;
  }

  /** Сбрасывает кэш: своя же запись обязана быть видна немедленно. */
  invalidate(): void {
    this.#expiresAt = 0;
  }

  async #stored(): Promise<Map<string, Stored>> {
    if (this.#db === null) return new Map();
    if (Date.now() < this.#expiresAt) return this.#cache;
    // Параллельные запросы не должны превращаться в параллельные походы
    // в базу: панель открывают вкладками, и все они приходят разом.
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = (async () => {
      try {
        const rows = await this.#db!.query<StoredRow>(
          'SELECT key, value, updated_by, updated_at FROM server_settings',
        );
        const next = new Map<string, Stored>();
        for (const row of rows) {
          // Ключ не из списка разрешённого не действует ни на что.
          if (!isEditable(row.key)) continue;
          next.set(row.key, {
            value: row.value,
            updatedBy: row.updated_by,
            updatedAt: row.updated_at,
          });
        }
        this.#cache = next;
        this.#expiresAt = Date.now() + this.#cacheMs;
        return next;
      } catch (err) {
        if (isUndefinedTable(err)) {
          if (!this.#warnedMissingTable) {
            this.#warnedMissingTable = true;
            this.#logger?.warn(
              'Таблицы настроек сервера нет. Примените ' +
                'infra/postgres/migrations/0001_baseline.sql — до этого раздел ' +
                '«Настройки сервера» покажет значения из окружения и не даст их менять.',
            );
          }
          // Пустой кэш с обычным сроком годности: без него каждый запрос
          // ходил бы в базу за той же ошибкой.
          this.#cache = new Map();
          this.#expiresAt = Date.now() + this.#cacheMs;
          return this.#cache;
        }
        // Отказ базы не должен превращать настройку в ноль: отдаём
        // последнее известное, а решение принимает вызывающий по
        // окружению и умолчанию.
        this.#logger?.warn(
          { err },
          'Не удалось прочитать настройки сервера, работаем по окружению',
        );
        this.#expiresAt = Date.now() + this.#cacheMs;
        return this.#cache;
      } finally {
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }

  /** Действующее значение настройки вместе с тем, откуда оно взято. */
  async resolve(key: string): Promise<ResolvedSetting> {
    const spec = findSetting(key);
    if (!spec) throw new BadRequestError(`Неизвестная настройка «${key}».`);
    const stored = spec.group === 'locked' ? undefined : (await this.#stored()).get(key);
    return this.#combine(spec, stored);
  }

  /** Все настройки перечня, в порядке перечня. */
  async resolveAll(): Promise<ResolvedSetting[]> {
    const stored = await this.#stored();
    return SETTING_SPECS.map((spec) =>
      this.#combine(spec, spec.group === 'locked' ? undefined : stored.get(spec.key)),
    );
  }

  #combine(spec: SettingSpec, stored: Stored | undefined): ResolvedSetting {
    /*
     * Два разных «из окружения», и путать их нельзя.
     *
     *   fileRaw — что окружение даёт СЕЙЧАС. Это и есть то, к чему
     *             возвращает сброс и с чем поднимется контейнер.
     *   envRaw  — с чем этот процесс СТАРТОВАЛ. Пока настройку не
     *             трогали, оба совпадают; после сохранения или сброса
     *             расходятся — и ровно на этом расхождении держится
     *             честное «перезапуск нужен прямо сейчас».
     */
    const fileRaw = fromEnv(spec, this.#env);
    const envRaw = startedWith.get(spec.key) ?? fileRaw;
    if (stored !== undefined) {
      return {
        spec,
        raw: stored.value,
        source: 'db',
        envRaw,
        updatedBy: stored.updatedBy,
        updatedAt: stored.updatedAt,
      };
    }
    if (fileRaw !== undefined) {
      return { spec, raw: fileRaw, source: 'env', envRaw, updatedBy: null, updatedAt: null };
    }
    return { spec, raw: spec.def, source: 'default', envRaw, updatedBy: null, updatedAt: null };
  }

  /* --- типизованное чтение для кода, который настройкой пользуется --- */

  /**
   * Целое значение настройки. Негодное значение из базы или окружения
   * не роняет запрос: берётся умолчание, а в журнал уходит предупреждение.
   * Настройка обязана быть безопасной в отказе — иначе одна опечатка
   * в панели останавливает работу с ящиками целиком.
   */
  async int(key: string): Promise<number> {
    const spec = findSetting(key);
    if (!spec) throw new Error(`Неизвестная настройка «${key}»`);
    const { raw } = await this.resolve(key);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return Number(spec.def);
    if (spec.min !== undefined && n < spec.min) return Number(spec.def);
    if (spec.max !== undefined && n > spec.max) return Number(spec.def);
    return n;
  }

  async bool(key: string): Promise<boolean> {
    const { raw } = await this.resolve(key);
    return isTruthy(raw);
  }

  async text(key: string): Promise<string> {
    const { raw } = await this.resolve(key);
    return raw;
  }

  /* --- запись --- */

  /** Сохраняет значение. Возвращает состояние настройки до и после. */
  async set(
    key: string,
    input: unknown,
    adminLogin: string,
  ): Promise<{ before: ResolvedSetting; after: ResolvedSetting }> {
    const spec = this.specForWrite(key);
    const before = await this.resolve(key);
    const value = parseSettingValue(spec, input);
    if (this.#db === null) {
      throw new BadRequestError('Хранилище настроек недоступно: нет подключения к базе.');
    }
    await this.#db.query(
      `INSERT INTO server_settings (key, value, updated_by, updated_at)
            VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
      [key, value, adminLogin.slice(0, 128)],
    );
    this.invalidate();
    return { before, after: await this.resolve(key) };
  }

  /** Убирает значение из базы: настройка возвращается к окружению/умолчанию. */
  async reset(key: string): Promise<{ before: ResolvedSetting; after: ResolvedSetting }> {
    this.specForWrite(key);
    const before = await this.resolve(key);
    if (this.#db === null) {
      throw new BadRequestError('Хранилище настроек недоступно: нет подключения к базе.');
    }
    await this.#db.query('DELETE FROM server_settings WHERE key = $1', [key]);
    /*
     * И ИЗ ОКРУЖЕНИЯ ТОЖЕ.
     *
     * При старте все незалоченные значения из базы подмешиваются в
     * `process.env` (applyStoredEnv). После удаления строки значение
     * читалось оттуда — то есть сброс не возвращал ничего: настройка
     * группы «действует сразу» продолжала работать со старым значением до
     * перезапуска, а панель подписывала его «из окружения (infra/.env)»,
     * хотя такой строки в файле нет. Администратор шёл её искать и не
     * находил.
     *
     * ВОЗВРАЩАЕМ прежнее значение, а не удаляем ключ. Удаление ломало
     * тот самый случай, ради которого сброс и нужен: строка стоит в
     * infra/.env руками (её туда написал установщик), поверх неё в
     * панели задали своё, потом нажали «вернуть к умолчанию». Значение
     * из файла исчезало из окружения живого процесса, а из самого файла
     * его никто не убирал — панель показывала умолчание продукта, а
     * после ближайшего перезапуска возвращалось написанное в файле.
     * Теперь сброс возвращает ровно к тому, что в файле, и это же
     * значение панель и показывает.
     */
    forgetStoredEnv(key, this.#env);
    this.invalidate();
    return { before, after: await this.resolve(key) };
  }

  /* ------------------------------------------------------------------ */
  /* Долг перед infra/.env                                                */
  /* ------------------------------------------------------------------ */
  /*
   * Сброс настройки убирает значение из базы И строку из infra/.env —
   * иначе панель показывает умолчание, а служба поднимается с прежним.
   * Строку убирает посредник, а он бывает недоступен: перезапускается, не
   * настроен, сеть моргнула. Тогда сброс остаётся сделанным наполовину, и
   * догнать его надо при ближайшем пересоздании службы.
   *
   * Помним ИМЕННО ЭТО — какие строки панель хотела убрать и не смогла.
   * Раньше список собирался иначе: «значение сейчас берётся из файла, а
   * не из базы» — под такой признак попадает не только забытый след
   * панели, но и любая настройка, которую человек прописал в infra/.env
   * своей рукой. Пересоздание ради одной настройки молча стирало
   * соседние, написанные при установке, — и то же самое проделывало бы
   * снова после каждого обновления.
   *
   * Отличить «моё, забытое» от «чужого, написанного руками» по
   * содержимому файла невозможно, и гадать здесь нельзя: цена ошибки —
   * тихо выключенная защита (например, разрешённые страны входа).
   */

  /** Записывает долг: строку из infra/.env убрать не удалось. */
  async oweEnvUnset(key: string, service: string): Promise<void> {
    if (this.#db === null) return;
    await this.#db.query(
      `INSERT INTO server_settings_env_debt (key, service)
            VALUES ($1, $2)
       ON CONFLICT (key, service) DO NOTHING`,
      [key, service],
    );
  }

  /** Долги этой службы — что убрать из infra/.env при пересоздании. */
  async envUnsetDebt(service: string): Promise<string[]> {
    if (this.#db === null) return [];
    const rows = await this.#db.query<{ key: string }>(
      'SELECT key FROM server_settings_env_debt WHERE service = $1 ORDER BY key',
      [service],
    );
    return rows.map((row) => row.key);
  }

  /** Гасит долги: строки из infra/.env убраны. */
  async clearEnvUnsetDebt(keys: readonly string[], service: string): Promise<void> {
    if (this.#db === null || keys.length === 0) return;
    await this.#db.query(
      'DELETE FROM server_settings_env_debt WHERE service = $1 AND key = ANY($2::text[])',
      [service, [...keys]],
    );
  }

  /**
   * Описание настройки, которую разрешено записывать. Публичный метод, а
   * не внутренний: групповое сохранение обязано отказать по locked-ключу
   * ДО того, как начнёт сравнивать значения, — иначе присланный в общей
   * форме `MAIL_DOMAIN` с тем же значением молча проглотился бы, и панель
   * решила бы, что менять его можно.
   */
  specForWrite(key: string): SettingSpec {
    const spec = findSetting(key);
    if (!spec) throw new BadRequestError(`Неизвестная настройка «${key}».`);
    if (spec.group === 'locked') {
      throw new BadRequestError(
        `Настройка «${key}» не меняется из панели. ${spec.reason ?? ''}`.trim(),
      );
    }
    return spec;
  }
}

/* ------------------------------------------------------------------ */
/* Живые пределы уборки для фоновых сборщиков                           */
/* ------------------------------------------------------------------ */

/** Сколько хранить и сколько строк держать. */
export interface RetentionLimits {
  retentionDays: number;
  maxRows: number;
}

/**
 * Пределы, спрошенные ЗАНОВО перед каждой уборкой.
 *
 * Сборщики живут месяцами и получают свои настройки один раз, при сборке
 * в admin/index.ts. Для сроков хранения это была бы ложь: панель обещает
 * «действует сразу», а уборщик продолжал бы вытеснять по значению,
 * прочитанному при старте контейнера, — и человек, поставивший «хранить
 * 30 дней вместо 14», не получил бы ничего до перезапуска. Поэтому
 * пределы спрашиваются перед каждой уборкой, а не запоминаются.
 */
export type RetentionLimitsReader = () => Promise<RetentionLimits>;

/** Готовый читатель пределов по двум ключам перечня. */
export function retentionReader(
  settings: ServerSettings,
  daysKey: string,
  rowsKey: string,
): RetentionLimitsReader {
  return async () => ({
    retentionDays: await settings.int(daysKey),
    maxRows: await settings.int(rowsKey),
  });
}

/* ------------------------------------------------------------------ */
/* Доступ к хранилищу из маршрутов                                      */
/* ------------------------------------------------------------------ */

/** Запасное хранилище: без базы, только окружение и умолчания. */
let envOnly: ServerSettings | null = null;

/**
 * Хранилище настроек из контекста админки.
 *
 * Поле в контексте необязательное — контекст собирают и проверки
 * маршрутов, которым до настроек сервера дела нет, и требовать от них
 * живую базу значило бы тащить Postgres в каждую проверку. Отсутствие
 * означает ровно «настройки только из окружения», то есть прежнее
 * поведение, а не отказ.
 */
export function settingsOf(ctx: { serverSettings?: ServerSettings }): ServerSettings {
  if (ctx.serverSettings) return ctx.serverSettings;
  envOnly ??= new ServerSettings({ db: null });
  return envOnly;
}

/* ------------------------------------------------------------------ */
/* Подмешивание в окружение при старте (группа restart)                 */
/* ------------------------------------------------------------------ */

export interface ApplyStoredEnvOptions {
  connectionString: string;
  env?: NodeJS.ProcessEnv;
  /** Куда сказать о результате. Логгера при старте ещё может не быть. */
  onInfo?: (message: string) => void;
  onWarn?: (message: string) => void;
}

/**
 * Читает сохранённые настройки и кладёт их в окружение — ДО того, как
 * схемы окружения модулей разберут его.
 *
 * Отказ здесь никогда не мешает старту. Настройки в базе — это уточнение
 * поверх окружения; недоступная база означает «работаем как раньше, по
 * файлу», а не «сервер не поднимается». Обратное поведение превратило бы
 * необязательную возможность в новую точку отказа почтового сервера.
 *
 * Возвращает число применённых значений.
 */
/**
 * Ключи, которые в `process.env` положили МЫ (из базы, при старте), и
 * ЧТО В ОКРУЖЕНИИ ЛЕЖАЛО ДО ЭТОГО (undefined — строки не было вовсе).
 *
 * Нужны сбросу настройки. «Вернуть к умолчанию» удаляет строку из базы, и
 * дальше значение читается из окружения — а там лежит ровно то, что этот
 * же процесс туда и записал при старте. В итоге сброс не возвращал
 * ничего: настройка группы «действует сразу» продолжала работать со
 * старым значением до перезапуска, а панель подписывала его «из
 * окружения (infra/.env)», хотя такой строки в файле нет и не было.
 *
 * Прежнее значение помним, а не забываем: подмешивание МОГЛО НАКРЫТЬ
 * строку, написанную человеком в infra/.env своей рукой. Просто удалить
 * ключ значит стереть её из окружения живого процесса, не убрав из
 * файла, — сброс делался бы наполовину и отменялся сам собой при первом
 * же перезапуске.
 */
const appliedFromDb = new Map<string, string | undefined>();

/**
 * С ЧЕМ ЭТОТ ПРОЦЕСС СТАРТОВАЛ — значения, попавшие в окружение при
 * старте и уже прочитанные схемами окружения модулей.
 *
 * Отдельно от appliedFromDb и НЕ забывается при сбросе. Причина в группе
 * restart: её значение читают один раз при старте, и после сброса живой
 * процесс продолжает работать со старым — пока контейнер не перезапустят.
 * Без этой памяти панель отвечала бы «настройка вернулась к умолчанию,
 * перезапуск не нужен» о процессе, который до сих пор живёт с прежним
 * значением. Настроек в этой группе 59, и молча соврать о любой из них —
 * это, например, обещать закрытый нешифрованный вход при открытом.
 */
const startedWith = new Map<string, string>();

/**
 * Забыть значение, подмешанное в окружение из базы, вернув на его место
 * прежнее — то, что стояло в окружении до подмешивания.
 *
 * Вызывается сбросом настройки: после удаления строки из базы значение из
 * `process.env` обязано уйти вместе с ней, иначе «вернуть к умолчанию» не
 * возвращает ничего.
 */
/**
 * Кладёт значения из базы в окружение и запоминает, какие именно.
 *
 * Отдельной функцией — чтобы её можно было проверить без базы: путь
 * «значение легло в окружение → сброс его оттуда убрал» и есть суть
 * дефекта, из-за которого «вернуть к умолчанию» не возвращало ничего.
 */
export function applyRowsToEnv(
  rows: ReadonlyArray<{ key: string; value: string }>,
  env: NodeJS.ProcessEnv,
): number {
  let applied = 0;
  for (const row of rows) {
    const spec = findSetting(row.key);
    // Неизвестный ключ и всё, что менять нельзя, не действует ни на что:
    // строка в базе не должна уметь подменить строку подключения.
    if (!spec || spec.group === 'locked') continue;
    // Прежнее значение запоминаем ОДИН раз: повторный вызов не должен
    // выдать наше же подмешанное значение за «то, что было в файле».
    if (!appliedFromDb.has(row.key)) appliedFromDb.set(row.key, env[row.key]);
    env[row.key] = row.value;
    startedWith.set(row.key, row.value);
    applied += 1;
  }
  return applied;
}

export function forgetStoredEnv(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!appliedFromDb.has(key)) return false;
  const before = appliedFromDb.get(key);
  // Именно возврат, а не удаление: под нашим значением могла лежать
  // строка из infra/.env, и она обязана вернуться на своё место.
  if (before === undefined) delete env[key];
  else env[key] = before;
  appliedFromDb.delete(key);
  return true;
}

export async function applyStoredEnv(opts: ApplyStoredEnvOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: 1,
    // Короткий предел: это шаг старта, и висеть на нём нельзя.
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  try {
    const result = await pool.query<StoredRow>(
      'SELECT key, value, updated_by, updated_at FROM server_settings',
    );
    const applied = applyRowsToEnv(result.rows, env);
    if (applied > 0) {
      opts.onInfo?.(`Настройки сервера из базы: применено значений — ${applied}`);
    }
    return applied;
  } catch (err) {
    if (isUndefinedTable(err)) {
      opts.onWarn?.(
        'Таблицы настроек сервера нет — работаем по infra/.env. Примените ' +
          'infra/postgres/migrations/0001_baseline.sql.',
      );
      return 0;
    }
    opts.onWarn?.(
      `Не удалось прочитать настройки сервера из базы, работаем по infra/.env: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
