/**
 * Сбор истории входов из двух источников: своей таблицы и журналов
 * почтовых служб.
 *
 * Чтение журналов идёт готовым постраничным читателем (admin/log-files.ts):
 * он умеет ровно то, что здесь нужно, — читать файл С КОНЦА кусками, не
 * загружая его в память, и останавливаться, упершись в потолок просмотра.
 * Заводить второй такой же ради этого раздела было бы обидной ошибкой:
 * на живом сервере dovecot.log — десятки мегабайт, и наивное чтение
 * положило бы сервер приложения (потолок кучи 512 МБ).
 *
 * ------------------------------------------------------------------
 * ОТБОР ПО ЯЩИКУ ИДЁТ ДВАЖДЫ, И ЭТО НЕ ЛИШНЕЕ
 * ------------------------------------------------------------------
 * Сперва читатель отбрасывает строки, в которых адреса ящика нет вовсе
 * (подстрокой) — это дёшево и убирает 99% журнала. Потом разбор достаёт
 * адрес из поля `user=<…>` и сравнивает его ТОЧНО. Первый отбор — про
 * скорость, второй — про правду: подстрока «test@mail.local» встретится
 * и в строке про «test@mail.local.example», и в теме доставленного письма.
 * Владелец ящика обязан видеть ТОЛЬКО свои события, и держится это на
 * втором сравнении, а не на первом.
 */
import { readLogPage, type ReadLogOptions } from '../admin/log-files.js';
import type { LogSource } from '../admin/mail-log.js';
import {
  dovecotAccessFromParts,
  markService,
  mergeAccessEvents,
  postfixAccessFromParts,
  type AccessEvent,
} from './access-log.js';
import type { AccessRow } from './owner-db.js';

/**
 * Сколько страниц журнала перебирать за один запрос.
 *
 * Предел нужен потому, что подходящих строк может не найтись вовсе:
 * человек не заходил по IMAP месяц, а журнал за этот месяц — гигабайт.
 * Дойдя до предела, отвечаем тем, что нашли, и не держим сервер на одном
 * запросе. Пропущенное не теряется: свои записи о веб-входах лежат
 * в базе и до них это не относится.
 */
const MAX_LOG_PAGES = 6;

/** Сколько строк просить у читателя за раз. */
const LOG_PAGE_LINES = 400;

export interface LogAccessOptions {
  dir: string;
  email: string;
  /** Сколько событий нужно самое большее. */
  limit: number;
  /**
   * Адреса, с которых подключается сам сервер приложения, — ВСЕ, какие за
   * ним знали, а не только сегодняшние (см. service-addresses.ts).
   */
  own: ReadonlySet<string>;
  now?: Date | undefined;
}

/**
 * События входа этого ящика из журнала одной службы.
 *
 * Отсутствие файла — не авария: журнал может быть не настроен, служба
 * может ещё ничего не написать. Тогда источника просто нет, и раздел
 * показывает то, что знает сам.
 */
export async function readLogAccess(
  source: Extract<LogSource, 'dovecot' | 'postfix'>,
  opts: LogAccessOptions,
): Promise<AccessEvent[]> {
  const now = opts.now ?? new Date();
  const parse = source === 'dovecot' ? dovecotAccessFromParts : postfixAccessFromParts;
  const events: AccessEvent[] = [];
  let before: number | undefined;
  let fileId: string | undefined;

  for (let page = 0; page < MAX_LOG_PAGES && events.length < opts.limit; page += 1) {
    const options: ReadLogOptions = {
      limit: LOG_PAGE_LINES,
      search: opts.email,
      before,
      fileId,
    };
    let result;
    try {
      result = await readLogPage(opts.dir, source, options, now);
    } catch {
      // Файла нет или он недоступен — источника просто не будет.
      break;
    }
    fileId = result.fileId;
    for (const line of result.items) {
      // Времени в записи может не быть вовсе (продолжение стека, мусор) —
      // тогда событие не построить: «когда» здесь главная колонка.
      if (!line.at) continue;
      /*
       * Читатель журнала Dovecot оставляет в тексте и того, кто сказал:
       * `imap-login: Login: user=<…>`. Это нужно ему самому (строка об
       * ошибке доставки без ящика бессмысленна), а нам мешает — поле
       * `user=` ищется по всему тексту, и приставку надо снять.
       */
      const text = line.text.startsWith(`${line.component}:`)
        ? line.text.slice(line.component.length + 1).trimStart()
        : line.text;
      const event = parse(line.component, text, line.at);
      if (!event) continue;
      // Второе, точное сравнение — см. пояснение в шапке файла.
      if (!sameMailbox(text, opts.email)) continue;
      events.push(markService(event, opts.own));
      if (events.length >= opts.limit) break;
    }
    if (result.nextBefore === null) break;
    before = result.nextBefore;
  }
  return events;
}

/** Точное совпадение ящика — единственная защита от чужих событий. */
function sameMailbox(text: string, email: string): boolean {
  const needle = email.toLowerCase();
  const user = /user=<([^>]*)>/.exec(text)?.[1];
  if (user !== undefined) return user.trim().toLowerCase() === needle;
  const sasl = /sasl_username=([^\s,]+)/.exec(text)?.[1];
  if (sasl !== undefined) return sasl.trim().toLowerCase() === needle;
  return false;
}

/** Своя запись в форме события — чтобы стоять в одном списке с журнальными. */
export function toAccessEvent(row: AccessRow): AccessEvent {
  return {
    at: row.at,
    channel: row.channel,
    success: row.success,
    ip: row.ip,
    userAgent: row.userAgent,
    service: false,
    detail: row.detail,
    origin: 'app',
  };
}

export interface CollectAccessOptions {
  dir: string;
  email: string;
  limit: number;
  /** Свои записи из таблицы истории. */
  own: AccessRow[];
  /** Адреса самого сервера приложения — см. LogAccessOptions.own. */
  serviceAddresses: ReadonlySet<string>;
  /** Читать ли журналы служб (на стенде без тома их просто нет). */
  withLogs: boolean;
  now?: Date | undefined;
}

/**
 * Итоговый список: свои записи и журнальные, свежие сверху.
 *
 * Обрезка до `limit` делается ПОСЛЕ слияния, а не в каждом источнике:
 * иначе двадцать журнальных строк вытеснили бы из ответа веб-вход,
 * случившийся минутой раньше, — то есть ровно ту запись, ради которой
 * раздел и открывают.
 */
export async function collectAccess(opts: CollectAccessOptions): Promise<AccessEvent[]> {
  const own = opts.own.map(toAccessEvent);
  if (!opts.withLogs) return mergeAccessEvents(own).slice(0, opts.limit);

  const base = {
    dir: opts.dir,
    email: opts.email,
    limit: opts.limit,
    own: opts.serviceAddresses,
    now: opts.now,
  };
  const [dovecot, postfix] = await Promise.all([
    readLogAccess('dovecot', base),
    readLogAccess('postfix', base),
  ]);
  return mergeAccessEvents(own, dovecot, postfix).slice(0, opts.limit);
}
