/**
 * Что происходило с почтой на одноразовые адреса: сколько пришло, кто
 * писал, когда последний раз.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ИСТОЧНИК — ЖУРНАЛ, А НЕ СЧЁТЧИК В БАЗЕ
 * ------------------------------------------------------------------
 * Счётчик пришлось бы наращивать в момент доставки, а доставкой занимается
 * Postfix, у которого нет ни базы, ни ловушек: единственный способ узнать
 * от него о письме — прочитать строку журнала. Врезаться в путь доставки
 * ради счётчика (свой milter, своя политика, свой транспорт) означало бы
 * поставить между письмом и ящиком лишнюю деталь, которая умеет ломаться.
 * Раздел статистики того не стоит: почта важнее счётчика.
 *
 * Готовая таблица mail_flow_events (миграция 0007) тоже не подходит, и это
 * стоит записать, чтобы не открывать заново: её собиратель хранит КОНЕЧНОГО
 * получателя (`to=`), а одноразовый адрес виден только в `orig_to=` — то
 * есть все письма на все псевдонимы человека лежат там неотличимо, под
 * адресом его основного ящика.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЧИСЛА ЧЕСТНО НАЗВАНЫ «ЗА ОКНО»
 * ------------------------------------------------------------------
 * Журнал проворачивается по размеру. «Всего писем» за всё время по нему не
 * посчитать, и притворяться нельзя: ноль в такой графе человек прочитает
 * как «на адрес никто не писал» и спокойно оставит работать адрес, который
 * на деле давно продан. Поэтому наружу отдаётся `windowDays` — глубина
 * того куска журнала, который удалось прочитать, — и интерфейс обязан её
 * показать рядом с числом.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПРОХОД ОДИН НА ВЕСЬ СПИСОК
 * ------------------------------------------------------------------
 * Отправитель и адрес назначения лежат в РАЗНЫХ строках журнала, связанных
 * идентификатором очереди:
 *
 *   qmgr[112]: D79895A9CB: from=<shop@example.org>, size=318, nrcpt=1
 *   lmtp[11200]: D79895A9CB: to=<ivanov@mail.local>, orig_to=<shop-2f4c@mail.local>, … status=sent
 *
 * Значит, отбор по одному адресу подстрокой не годится: строку с
 * отправителем он отбросит. Поэтому проход по журналу делается ОДИН,
 * неотфильтрованный, и сразу на все адреса ящика — за него собираются и
 * доставки, и отправители, и отказы. Читать журнал заново на каждый адрес
 * значило бы перечитать его столько раз, сколько у человека адресов.
 */
import { readLogPage } from '../admin/log-files.js';
import type { DisposableSender, DisposableTraffic } from './types.js';

/**
 * Сколько страниц журнала перебирать за один запрос.
 *
 * Предел нужен потому, что нужных строк может не найтись вовсе: адрес
 * завели вчера, а журнал за неделю — сотни мегабайт. Дойдя до предела,
 * отвечаем тем, что нашли, и честно называем получившуюся глубину окна.
 */
const MAX_PAGES = 40;

/** Сколько строк просить у читателя за раз. */
const PAGE_LINES = 400;

/** Сколько отправителей показывать по одному адресу. */
const MAX_SENDERS = 20;

/** `orig_to=<shop-2f4c@mail.local>` — адрес до раскрытия алиаса. */
const ORIG_TO = /\borig_to=<([^>]*)>/;
/** `from=<shop@example.org>` — отправитель. */
const FROM = /\bfrom=<([^>]*)>/;
/** `to=<shop-2f4c@mail.local>` — получатель (в строках отказа). */
const TO = /\bto=<([^>]*)>/;
/** `status=sent` / `status=bounced` — чем кончилась попытка. */
const STATUS = /\bstatus=(\w+)/;

interface Hit {
  address: string;
  at: Date;
  queueId: string | null;
  sender: string | null;
}

/**
 * Собирает наблюдения по всем адресам ящика за один проход по журналу.
 *
 * Ключи ответа — адреса в нижнем регистре. Адрес, о котором в журнале не
 * нашлось ни строки, в ответе всё равно есть — с нулями: «писем не было»
 * это тоже ответ, и отличать его от «не посчитали» человеку не нужно.
 *
 * Возвращает null, если журнала нет вовсе: тогда интерфейс не показывает
 * ни чисел, ни нулей — выдумывать «писем не приходило» по отсутствующему
 * журналу нельзя.
 */
export async function readTraffic(opts: {
  dir: string;
  addresses: readonly string[];
  now?: Date;
}): Promise<Map<string, DisposableTraffic> | null> {
  const now = opts.now ?? new Date();
  const wanted = new Set(opts.addresses.map((a) => a.toLowerCase()));
  if (wanted.size === 0) return new Map();

  const hits: Hit[] = [];
  const rejects: Hit[] = [];
  /** Идентификатор очереди → отправитель. Заполняется по ходу прохода. */
  const senderOf = new Map<string, string>();

  let oldest: Date | null = null;
  let before: number | undefined;
  let fileId: string | undefined;
  let sawFile = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result;
    try {
      result = await readLogPage(
        opts.dir,
        'postfix',
        { limit: PAGE_LINES, before, fileId },
        now,
      );
    } catch {
      // Журнала нет или он недоступен — источника просто не будет.
      break;
    }
    sawFile = true;
    fileId = result.fileId;

    for (const line of result.items) {
      if (line.at && (oldest === null || line.at < oldest)) oldest = line.at;

      /*
       * Отправитель запоминается ВСЕГДА, а не только для наших адресов:
       * читая журнал с конца, мы встречаем строку доставки раньше строки
       * с отправителем того же письма, и на момент встречи ещё не знаем,
       * понадобится ли она. Карта маленькая: в ней живут только письма из
       * прочитанного окна.
       */
      if (line.queueId && !senderOf.has(line.queueId)) {
        const from = FROM.exec(line.text);
        if (from?.[1]) senderOf.set(line.queueId, from[1].toLowerCase());
      }

      if (!line.at) continue;

      const orig = ORIG_TO.exec(line.text);
      if (orig?.[1]) {
        const address = orig[1].toLowerCase();
        if (wanted.has(address)) {
          const status = STATUS.exec(line.text)?.[1];
          // Считается только доставленное. Отложенная попытка (deferred)
          // — это то же самое письмо, которое приедет ещё раз: сложив их,
          // мы показали бы «пять писем» там, где письмо было одно.
          if (status === undefined || status === 'sent') {
            hits.push({ address, at: line.at, queueId: line.queueId, sender: null });
          }
        }
        continue;
      }

      /*
       * Отказы. Выключенный адрес отбивается ещё на команде RCPT TO, и
       * очереди у такого письма нет вовсе (в журнале — NOQUEUE), зато в
       * той же строке стоят и отправитель, и получатель.
       *
       * Показывать их стоит: «после выключения на адрес постучались ещё
       * 40 раз» — это ответ на вопрос «правильно ли я его выключил».
       */
      if (line.text.includes('reject:')) {
        const to = TO.exec(line.text)?.[1]?.toLowerCase();
        if (to && wanted.has(to)) {
          rejects.push({
            address: to,
            at: line.at,
            queueId: null,
            sender: FROM.exec(line.text)?.[1]?.toLowerCase() ?? null,
          });
        }
      }
    }

    if (result.nextBefore === null) break;
    before = result.nextBefore;
  }

  if (!sawFile) return null;

  // Отправители доставленных писем известны только теперь, когда проход
  // окончен и карта очередей заполнена целиком.
  for (const hit of hits) {
    if (hit.sender === null && hit.queueId) hit.sender = senderOf.get(hit.queueId) ?? null;
  }

  const windowDays = oldest
    ? Math.max(1, Math.round((now.getTime() - oldest.getTime()) / 86_400_000))
    : 1;

  const out = new Map<string, DisposableTraffic>();
  for (const address of wanted) {
    const mine = hits.filter((h) => h.address === address);
    const mineRejected = rejects.filter((h) => h.address === address);
    out.set(address, {
      received: mine.length,
      rejected: mineRejected.length,
      lastAt: mine.length > 0 ? maxAt(mine).toISOString() : null,
      senders: topSenders([...mine, ...mineRejected]),
      windowDays,
    });
  }
  return out;
}

const maxAt = (list: readonly Hit[]): Date =>
  list.reduce((a, b) => (a.at > b.at ? a : b)).at;

/**
 * Кто писал на адрес.
 *
 * Сортировка по СВЕЖЕСТИ, а не по числу писем: вопрос, ради которого сюда
 * смотрят, — «кто пишет на адрес СЕЙЧАС», и рассылка, замолчавшая полгода
 * назад, не должна оттеснять сегодняшнего спамера просто потому, что
 * писем от неё когда-то было больше.
 */
function topSenders(list: readonly Hit[]): DisposableSender[] {
  const byAddress = new Map<string, { count: number; last: Date }>();
  for (const hit of list) {
    if (!hit.sender) continue;
    const seen = byAddress.get(hit.sender);
    if (seen) {
      seen.count += 1;
      if (hit.at > seen.last) seen.last = hit.at;
    } else {
      byAddress.set(hit.sender, { count: 1, last: hit.at });
    }
  }
  return [...byAddress.entries()]
    .map(([address, v]) => ({ address, count: v.count, lastAt: v.last.toISOString() }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, MAX_SENDERS);
}
