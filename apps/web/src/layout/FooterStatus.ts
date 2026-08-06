/**
 * Расчёты для нижней строки состояния (см. Footer.tsx).
 *
 * Здесь нет ни React, ни DOM — только чистые функции. Так проверяется
 * поведение, которое иначе пришлось бы ловить через отрисовку: склонения,
 * пороги «только что», разбор состояния связи и, главное, отказ показывать
 * то, чего мы не знаем.
 *
 * Общее правило файла: НЕИЗВЕСТНОЕ ЗНАЧЕНИЕ ВОЗВРАЩАЕТСЯ КАК `null`,
 * а не как ноль. У квоты это не придирка: `GET /api/account` отдаёт
 * `quotaLimitBytes: 0`, когда плагин quota в Dovecot выключен и спросить
 * не у кого. Показать в таком случае «занято 0 из 0» значило бы сообщить
 * человеку неправду о его ящике.
 */

/** Русское склонение по числу: 1 письмо, 2 письма, 5 писем. */
export function plural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

/* ------------------------------------------------------------------ */
/* Занятое место                                                       */
/* ------------------------------------------------------------------ */

const UNITS: Array<[limit: number, suffix: string]> = [
  [1024 ** 3, 'ГБ'],
  [1024 ** 2, 'МБ'],
  [1024, 'КБ'],
];

/**
 * Байты человеческим текстом: «27 КБ», «3,2 ГБ», «1 ГБ».
 *
 * Дробная часть — только когда она что-то добавляет: «3,2 ГБ» полезнее
 * «3 ГБ», а «1,0 ГБ» — просто мусор в строке, которую и так читают краем
 * глаза. Разделитель дробной части русский (запятая), как во всём
 * остальном интерфейсе: `toLocaleString('ru-RU')`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  for (const [limit, suffix] of UNITS) {
    if (bytes >= limit) {
      const value = bytes / limit;
      // Один знак после запятой до 10 единиц, дальше он не читается
      const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
      return `${rounded.toLocaleString('ru-RU')} ${suffix}`;
    }
  }
  return `${Math.round(bytes).toLocaleString('ru-RU')} Б`;
}

export interface QuotaView {
  /** «Занято 27 КБ из 1 ГБ» — готовый текст для строки состояния. */
  text: string;
  /** Доля занятого, 0…1 — ширина полоски. */
  fraction: number;
  /**
   * Место кончается: полоска краснеет, но текст остаётся текстом — цвет
   * не единственный признак. Порог 90% взят между двумя порогами
   * Thunderbird (`mail.quota.mainwindow_threshold.warning` = 80,
   * `.critical` = 95): двух ступеней окраски строка в 28 точек не
   * заслуживает, а одна должна срабатывать тогда, когда ещё можно
   * что-то сделать.
   */
  nearlyFull: boolean;
}

/**
 * Занятое место из квоты — или `null`, когда квоты нет.
 *
 * `limit <= 0` значит «Dovecot не сообщил предела»: это НЕ безлимитный
 * ящик и не пустой ящик, это отсутствие сведений. Строка состояния в таком
 * случае про место молчит.
 */
export function quotaView(usedBytes: number, limitBytes: number): QuotaView | null {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return null;
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return null;
  const fraction = Math.min(1, usedBytes / limitBytes);
  return {
    text: `Занято ${formatBytes(usedBytes)} из ${formatBytes(limitBytes)}`,
    fraction,
    nearlyFull: fraction >= 0.9,
  };
}

/* ------------------------------------------------------------------ */
/* Счётчики папки                                                      */
/* ------------------------------------------------------------------ */

/** То немногое, что строке состояния нужно от папки. */
export interface FolderCounts {
  totalCount: number;
  unreadCount: number;
}

/**
 * «9 писем, 7 непрочитанных» — или `null`, если папка неизвестна.
 *
 * Непрочитанные упоминаются, только когда они есть: «0 непрочитанных»
 * в пустой строке состояния — шум, а не сведения.
 */
export function countsText(folder: FolderCounts | undefined): string | null {
  if (!folder) return null;
  const total = folder.totalCount;
  if (!Number.isFinite(total) || total < 0) return null;
  const head = `${total.toLocaleString('ru-RU')} ${plural(total, ['письмо', 'письма', 'писем'])}`;
  if (folder.unreadCount > 0) {
    const unread = folder.unreadCount.toLocaleString('ru-RU');
    return `${head}, ${unread} ${plural(folder.unreadCount, [
      'непрочитанное',
      'непрочитанных',
      'непрочитанных',
    ])}`;
  }
  return head;
}

/**
 * Идентификатор папки из адреса: `/inbox/`, `/inbox/123` → `inbox`.
 *
 * Взять его из `useParams` нельзя: каркас — маршрут без своего пути,
 * и параметры дочернего маршрута ему не достаются. Постоянные адреса
 * (`/search`, `/compose`, `/settings`) папками не являются.
 */
const NOT_FOLDERS = new Set(['search', 'compose', 'settings', 'login']);

export function folderIdFromPath(pathname: string): string | null {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || NOT_FOLDERS.has(first)) return null;
  return decodeURIComponent(first);
}

/* ------------------------------------------------------------------ */
/* Состояние связи                                                     */
/* ------------------------------------------------------------------ */

/**
 * `ok` — последний разговор с сервером удался;
 * `unreachable` — последняя попытка не дошла (сеть есть, сервера нет);
 * `offline` — сети нет по мнению самого браузера.
 */
export type LinkState = 'ok' | 'unreachable' | 'offline';

/**
 * Отказ, означающий «до сервера не достучались».
 *
 * Различение важное. Ответ 4xx — это ОТВЕТ: сервер жив, он просто говорит
 * «нельзя» или «не найдено», и красить строку состояния в «нет связи» из-за
 * чужого письма было бы враньём. А вот 5xx и отказ самого `fetch` значат
 * ровно то, что написано: обратный прокси не смог достучаться до сервера
 * приложения (502/503/504 от nginx, когда контейнер api остановлен) либо
 * запрос не ушёл вовсе.
 */
export function isUnreachableError(error: unknown): boolean {
  if (error == null) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return status >= 500;
  // Не наша ApiError — значит, до разбора ответа дело не дошло:
  // `fetch` бросает TypeError, когда соединения не случилось.
  return true;
}

/** Снимок одного запроса из кэша react-query — всё, что нам от него нужно. */
export interface QuerySnapshot {
  key: readonly unknown[];
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  error: unknown;
  hasData: boolean;
  /**
   * Сколько попыток этого запроса подряд не удалось ПРЯМО СЕЙЧАС.
   * Обнуляется react-query при первом же успехе.
   */
  failureCount: number;
  /** Чем закончилась последняя неудавшаяся попытка. */
  failureReason: unknown;
}

export interface MailStatus {
  link: LinkState;
  /**
   * Когда почтовые данные в последний раз пришли с сервера.
   * `null` — ещё ни разу: показывать «обновлено» нечего.
   */
  updatedAt: number | null;
}

/** Запросы, по которым судим о свежести списка: папки и письма. */
function isMailQuery(key: readonly unknown[]): boolean {
  const head = key[0];
  return head === 'folders' || head === 'messages';
}

/**
 * Состояние связи и свежесть списка — из того, что уже произошло.
 *
 * Почему так, а не отдельной пробой сервера. Опрашивать `/healthz` по
 * таймеру значило бы завести постоянный поток запросов ради строчки внизу
 * экрана — на каждой открытой вкладке каждого пользователя. Между тем
 * приложение и без того разговаривает с сервером: список папок, страницы
 * писем, перезапрос при возврате во вкладку. Каждый такой разговор уже
 * содержит ответ на оба вопроса — дошло ли и когда. Здесь он просто
 * прочитан. Ноль дополнительных запросов.
 *
 * Смотрим на ДВА признака, и второй появился после проверки на живом стенде.
 *
 *   1. Осевшая ошибка: сравниваются ВРЕМЕНА, а не флаги. «Была ошибка»
 *      ничего не значит, если после неё запрос удался; значение имеет
 *      только случившееся последним.
 *
 *   2. Неудавшаяся попытка ПРЯМО СЕЙЧАС (`failureCount`). Одного первого
 *      признака оказалось мало: при остановленном контейнере api nginx
 *      отвечал 502, но react-query держал запрос в состоянии «идёт»
 *      и НЕ ОСЕДАЛ в ошибку — ни через пять секунд, ни через двадцать
 *      четыре (проверено, журнал сети приложен к работе). Строка всё это
 *      время писала «Обновление…», то есть ровно то же, что и при
 *      исправном сервере. Между тем react-query отмечает каждую
 *      неудавшуюся попытку сразу, ещё до повтора, — и человеку надо
 *      сказать об отказе тогда же, а не после трёх кругов ожидания.
 *      Счётчик обнуляется при первом успехе, поэтому тревога снимается
 *      сама собой.
 */
export function mailStatus(snapshots: readonly QuerySnapshot[], online: boolean): MailStatus {
  let lastSuccess = 0;
  let lastFailure = 0;
  let failingNow = false;
  for (const snapshot of snapshots) {
    if (!isMailQuery(snapshot.key)) continue;
    if (snapshot.hasData && snapshot.dataUpdatedAt > lastSuccess) {
      lastSuccess = snapshot.dataUpdatedAt;
    }
    if (snapshot.errorUpdatedAt > lastFailure && isUnreachableError(snapshot.error)) {
      lastFailure = snapshot.errorUpdatedAt;
    }
    if (snapshot.failureCount > 0 && isUnreachableError(snapshot.failureReason)) {
      failingNow = true;
    }
  }

  // Мнение браузера о сети сильнее наших догадок: сеть выключена —
  // сервер тут ни при чём, и совет «повторить» бесполезен.
  const broken = failingNow || lastFailure > lastSuccess;
  const link: LinkState = !online ? 'offline' : broken ? 'unreachable' : 'ok';
  return { link, updatedAt: lastSuccess > 0 ? lastSuccess : null };
}

/**
 * Сколько ждать ответа, прежде чем назвать молчание отказом.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО — самая дорогая находка этой работы, и найдена
 * она только на живом стенде. Останавливаем контейнер api: запрос из
 * браузера НЕ ОТКАЗЫВАЕТ. Он висит. Проверено прямо в странице —
 * `fetch('/api/folders')` не разрешился и не отверг обещание за восемь
 * секунд, хотя обратный прокси к этому времени уже ответил 502 на уровне
 * сети. Состояние запроса в react-query при этом остаётся нетронутым:
 * `fetchStatus: "fetching"`, `fetchFailureCount: 0`, `error: null`,
 * `errorUpdatedAt: 0` — и так двадцать четыре секунды и дальше.
 *
 * Отсюда вывод, который стоит запомнить: НЕЛЬЗЯ СТРОИТЬ ПОКАЗ СОСТОЯНИЯ
 * СВЯЗИ НА ОТКАЗАХ ЗАПРОСОВ. Отказа может не быть вовсе. Единственное,
 * что видно снаружи наверняка, — что ответа нет. Молчание дольше этого
 * срока и есть наблюдаемый факт: сервер не отвечает. Не догадка.
 *
 * Двенадцать секунд — с запасом к настоящему долгому ответу: чтение
 * большой папки по IMAP укладывается в единицы секунд. Меньше — начнём
 * пугать людей на медленной сети; больше — человек успеет решить, что
 * сломан интерфейс.
 */
export const SILENCE_MS = 12_000;

/** Молчит ли сервер дольше положенного. `since` — начало разговора. */
export function isSilent(since: number | null, now: number): boolean {
  if (since == null) return false;
  return now - since >= SILENCE_MS;
}

/**
 * Итоговое состояние связи. Уже известный отказ важнее молчания: он
 * точнее, а молчание — лишь его наблюдаемая тень.
 */
export function resolveLink(base: LinkState, silent: boolean): LinkState {
  if (base !== 'ok') return base;
  return silent ? 'unreachable' : 'ok';
}

/* ------------------------------------------------------------------ */
/* «Обновлено N минут назад»                                           */
/* ------------------------------------------------------------------ */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Порог, до которого показываем «только что», а не «0 минут назад». */
export const JUST_NOW_MS = 45 * SECOND;

/**
 * «только что» / «минуту назад» / «7 минут назад» / «2 часа назад» /
 * «вчера в 22:15» / «5 авг в 14:20».
 *
 * Дальше суток относительное время перестаёт что-либо значить («37 часов
 * назад» никто не переводит в уме), поэтому там — обычная дата.
 */
export function updatedText(updatedAt: number, now: number): string {
  const age = Math.max(0, now - updatedAt);
  if (age < JUST_NOW_MS) return 'Обновлено только что';
  if (age < 2 * MINUTE) return 'Обновлено минуту назад';
  if (age < HOUR) {
    // Именно floor, а не round: при округлении к ближайшему последняя
    // половина часа подписывалась бы «60 минут назад».
    const minutes = Math.floor(age / MINUTE);
    return `Обновлено ${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`;
  }
  if (age < 24 * HOUR) {
    const hours = Math.floor(age / HOUR);
    return `Обновлено ${hours} ${plural(hours, ['час', 'часа', 'часов'])} назад`;
  }
  const date = new Date(updatedAt);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = date
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
    .replace(/\./g, '')
    .replace(/\s+г$/u, '');
  return `Обновлено ${day} в ${time}`;
}

/**
 * Через сколько миллисекунд текст выше может поменяться.
 *
 * Ради этой функции всё и затевалось. Обновлять подпись раз в секунду —
 * это 3600 перерисовок в час ради строки, которая меняется 60 раз; а раз
 * в минуту «в лоб» — это подпись «только что», висящая до полутора минут.
 * Здесь считается расстояние до БЛИЖАЙШЕЙ границы, за которой текст станет
 * другим, и будильник ставится ровно на неё: пока написано «только что»,
 * следующее пробуждение — через 45 секунд после обновления, а не через
 * секунду; после часа — раз в час.
 *
 * Ни одно из пробуждений не ходит на сервер: пересчитывается строка,
 * данные остаются те же.
 */
export function nextTickDelay(age: number): number {
  if (age < JUST_NOW_MS) return JUST_NOW_MS - age;
  if (age < 2 * MINUTE) return 2 * MINUTE - age;
  if (age < HOUR) return MINUTE - (age % MINUTE);
  if (age < 24 * HOUR) return HOUR - (age % HOUR);
  // Дальше показывается дата — она не меняется вовсе; просыпаемся редко
  return HOUR;
}
