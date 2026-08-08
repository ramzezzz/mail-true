/**
 * Белые и чёрные списки антиспама: какие они бывают и что в них можно класть.
 *
 * ------------------------------------------------------------------
 * ГДЕ ЖИВУТ ДАННЫЕ
 * ------------------------------------------------------------------
 * В файлах infra/rspamd/maps.d/*.map, которые читает модуль multimap
 * (infra/rspamd/local.d/multimap.conf). Сервер приложения к этим файлам
 * доступа НЕ имеет и не должен: каталог примонтирован в контейнер rspamd,
 * а не в api. Пишет их сам rspamd по запросу /savemap — то есть правка из
 * панели доезжает до фильтра тем же процессом, который её потом читает,
 * и вопрос «а применилось ли» не возникает.
 *
 * Копии списков в Postgres НЕТ намеренно. Копия означала бы два источника
 * истины: правку прямо в файле (а его правят при разборе инцидента с ssh)
 * панель бы не увидела и при первом же сохранении затёрла.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПРАВЯТСЯ НЕ ВСЕ СПИСКИ
 * ------------------------------------------------------------------
 * Два файла из восьми панель показывает только на чтение:
 *
 *   local_domains.map      свои домены. Их ведёт entrypoint контейнера
 *                          rspamd по MAIL_DOMAIN; правка руками разъедется
 *                          с настоящим списком доменов сервера.
 *   blacklist_content.map  регулярные выражения по всему письму. Ошибка в
 *                          выражении — это не «правило не сработало», а
 *                          отказ разбора карты; плюс на нём держится
 *                          проверка GTUBE (см. infra/test-antispam.sh).
 *                          Поле ввода регулярных выражений в панели —
 *                          это кнопка «сломать фильтр всем разом».
 */

/** Что кладут в список: адрес, домен или адрес отправляющего сервера. */
export type SpamListValue = 'address' | 'domain' | 'ip';

export interface SpamListSpec {
  id: string;
  /** Имя файла в infra/rspamd/maps.d. По нему карта ищется среди карт rspamd. */
  file: string;
  title: string;
  /** Разрешающий (минус к оценке) или запрещающий (плюс). */
  tone: 'allow' | 'deny';
  value: SpamListValue;
  /** Символ rspamd и его вес — то, что реально произойдёт с письмом. */
  symbol: string;
  score: number;
  /** Можно ли править из панели. */
  editable: boolean;
  /** Зачем список нужен и чем чреват — показывается рядом со списком. */
  hint: string;
  /**
   * Зачем этот список заводят — текст для ПУСТОГО списка.
   *
   * Пустая таблица с надписью «Список пуст» не отвечает на единственный
   * вопрос, который возникает перед пустым списком: а что сюда вообще
   * кладут и в каком случае? Раньше администратору приходилось угадывать
   * это по названию, и разрешённые серверы (IP) путали с разрешёнными
   * отправителями — при том, что подделать можно ровно одно из двух.
   */
  purpose: string;
  /** Пример записи. Показывается и в пустом списке, и в поле ввода. */
  example: string;
}

export const SPAM_LISTS: readonly SpamListSpec[] = [
  {
    id: 'whitelist_from',
    file: 'whitelist_from.map',
    title: 'Разрешённые отправители',
    tone: 'allow',
    value: 'address',
    symbol: 'WHITELIST_SENDER_ADDRESS',
    score: -10,
    editable: true,
    purpose:
      'Сюда вносят конкретных людей, письма которых у вас уже уезжали в спам по ошибке: ' +
      'бухгалтера контрагента, отправителя счетов, рассылку с важными уведомлениями. ' +
      'Разрешение действует только на этот адрес, не на весь его домен.',
    example: 'director@partner-company.com',
    hint:
      'Письма с этого адреса получают −10 баллов — этого хватает, чтобы перебить типовое ' +
      'ложное срабатывание. Адрес отправителя подделывается: разрешая адрес, вы разрешаете ' +
      'и того, кто им прикинется',
  },
  {
    id: 'whitelist_domains',
    file: 'whitelist_domains.map',
    title: 'Разрешённые домены',
    tone: 'allow',
    value: 'domain',
    symbol: 'WHITELIST_SENDER_DOMAIN',
    score: -6,
    editable: true,
    purpose:
      'Сюда вносят домены организаций, с которыми вы работаете постоянно и чьи письма ' +
      'должны доходить всегда: контрагенты, головной офис, обслуживающие сервисы. ' +
      'Разрешение действует на всех отправителей домена сразу.',
    example: 'partner-company.com',
    hint:
      'Весь домен отправителя получает −6 баллов. Не вносите сюда бесплатные почтовые ' +
      'службы (mail.ru, gmail.com): это разрешение для всех, у кого там есть ящик',
  },
  {
    id: 'whitelist_ip',
    file: 'whitelist_ip.map',
    title: 'Разрешённые серверы (IP)',
    tone: 'allow',
    value: 'ip',
    symbol: 'WHITELIST_IP',
    score: -6,
    editable: true,
    purpose:
      'Сюда вносят почтовые серверы, которым вы доверяете: сервер головного офиса, ' +
      'сервер рассылок, шлюз филиала. Адрес сервера — единственное, что отправитель ' +
      'подделать не может, поэтому этот список надёжнее двух предыдущих.',
    example: '203.0.113.25',
    hint:
      'Адрес отправляющего сервера, а не отправителя. Подделать его нельзя — это самый ' +
      'надёжный из разрешающих списков. Принимаются и подсети вида 203.0.113.0/24',
  },
  {
    id: 'blacklist_from',
    file: 'blacklist_from.map',
    title: 'Запрещённые отправители',
    tone: 'deny',
    value: 'address',
    symbol: 'BLACKLIST_SENDER_ADDRESS',
    score: 12,
    editable: true,
    purpose:
      'Сюда вносят конкретных отправителей, от которых письма не нужны совсем: ' +
      'назойливую рассылку, адрес, с которого пришло мошенническое письмо. ' +
      'Запрет действует только на этот адрес.',
    example: 'spammer@example.org',
    hint:
      '+12 баллов: письмо уходит в папку «Спам» (порог 6), но приём не отклоняется — ' +
      'до отказа (15) одного этого правила не хватает, и это сделано намеренно',
  },
  {
    id: 'blacklist_domains',
    file: 'blacklist_domains.map',
    title: 'Запрещённые домены',
    tone: 'deny',
    value: 'domain',
    symbol: 'BLACKLIST_SENDER_DOMAIN',
    score: 10,
    editable: true,
    purpose:
      'Сюда вносят домены, с которых вам массово пишут посторонние. Запрет действует ' +
      'на всех отправителей домена сразу — сначала убедитесь, что оттуда не пишут коллеги ' +
      'или контрагенты.',
    example: 'spam-sender.example',
    hint: '+10 баллов всем письмам домена. Проверьте, что с этого домена вам не пишут коллеги',
  },
  {
    id: 'blacklist_url_domains',
    file: 'blacklist_url_domains.map',
    title: 'Запрещённые домены в ссылках',
    tone: 'deny',
    value: 'domain',
    symbol: 'BLACKLIST_URL_DOMAIN',
    score: 8,
    editable: true,
    purpose:
      'Сюда вносят домены сайтов, ссылки на которые встречаются в нежелательных письмах: ' +
      'мошеннические страницы входа, «магазины», рекламные площадки. Отправитель при этом ' +
      'может быть каким угодно и меняться каждый день — ловится именно ссылка.',
    example: 'phishing-site.example',
    hint:
      '+8 баллов письму, в тексте которого есть ссылка на этот домен. Отправитель при этом ' +
      'может быть любым — так ловят рассылки, меняющие адрес каждый день',
  },
  {
    id: 'local_domains',
    file: 'local_domains.map',
    title: 'Свои домены',
    tone: 'allow',
    value: 'domain',
    symbol: 'LOCAL_SENDER_DOMAIN',
    score: -2,
    editable: false,
    purpose:
      'Здесь перечислены домены самого сервера. Список ведётся автоматически и нужен, ' +
      'чтобы письма между своими не выглядели подозрительными для внешних проверок.',
    example: 'mail.local',
    hint:
      'Ведётся автоматически по MAIL_DOMAIN при запуске контейнера rspamd. Домены сервера ' +
      'добавляются в разделе «Домены и DNS», а не здесь',
  },
  {
    id: 'blacklist_content',
    file: 'blacklist_content.map',
    title: 'Запрет по содержимому (регулярные выражения)',
    tone: 'deny',
    value: 'address',
    symbol: 'BLACKLIST_CONTENT',
    score: 8,
    editable: false,
    purpose:
      'Здесь лежат регулярные выражения, по которым письмо признаётся нежелательным по ' +
      'самому тексту, а не по отправителю. Первой строкой — стандартный тестовый образец ' +
      'GTUBE: им проверяют, что фильтр вообще работает.',
    example: '/выражение/i',
    hint:
      'Только чтение. Ошибка в выражении ломает разбор карты целиком, а на этом файле держится ' +
      'проверка тестовым образцом GTUBE. Правится в infra/rspamd/maps.d/blacklist_content.map',
  },
];

export function findSpamList(id: string): SpamListSpec | undefined {
  return SPAM_LISTS.find((list) => list.id === id);
}

/* ------------------------------------------------------------------ */
/* Проверка того, что вносят                                            */
/* ------------------------------------------------------------------ */

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/u;
const ADDRESS_RE = /^[^\s@,;<>"]{1,64}@(?=.{1,253}$)[a-z0-9.-]{1,253}$/u;

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  // Без педантичного разбора: адрес отдаётся rspamd, и последнее слово всё
  // равно за ним. Здесь отсекается мусор и опечатки, а не выверяется RFC.
  return /^[0-9a-f:]+$/u.test(value) && value.includes(':');
}

export interface EntryCheck {
  ok: boolean;
  /** Приведённое к каноническому виду значение (нижний регистр, без пробелов). */
  value: string;
  /** Почему не годится — текст показывается человеку. */
  problem: string;
}

/**
 * Проверка и приведение записи к тому виду, в котором её поймёт rspamd.
 *
 * Нижний регистр обязателен: multimap сравнивает строки как есть, и
 * «Ivan@Example.COM» в файле не совпадёт ни с чем. Раньше такая запись
 * молча не работала бы — список есть, адрес в нём виден, а правило не
 * срабатывает.
 */
export function checkEntry(kind: SpamListValue, raw: string): EntryCheck {
  const value = raw.trim().toLowerCase();
  if (value === '') return { ok: false, value, problem: 'Пустая запись' };
  if (value.startsWith('#')) {
    return { ok: false, value, problem: 'Запись не может начинаться с решётки — это комментарий' };
  }
  if (value.length > 253) return { ok: false, value, problem: 'Слишком длинная запись' };

  if (kind === 'address') {
    if (!ADDRESS_RE.test(value)) {
      return {
        ok: false,
        value,
        problem: 'Нужен полный адрес вида имя@домен. Для целого домена есть отдельный список',
      };
    }
    return { ok: true, value, problem: '' };
  }

  if (kind === 'domain') {
    if (value.includes('@')) {
      return {
        ok: false,
        value,
        problem:
          'Это адрес, а не домен. Уберите часть до собаки или воспользуйтесь списком адресов',
      };
    }
    if (!DOMAIN_RE.test(value)) {
      return {
        ok: false,
        value,
        problem: 'Не похоже на доменное имя (нужен хотя бы один разделитель-точка)',
      };
    }
    return { ok: true, value, problem: '' };
  }

  // Адрес сервера: одиночный или подсеть
  const [address = '', maskRaw, ...rest] = value.split('/');
  if (rest.length > 0) return { ok: false, value, problem: 'Лишняя косая черта в записи подсети' };
  const v4 = isIpv4(address);
  const v6 = isIpv6(address);
  if (!v4 && !v6)
    return { ok: false, value, problem: 'Не похоже на адрес сервера (IPv4 или IPv6)' };
  if (maskRaw !== undefined) {
    if (!/^\d{1,3}$/u.test(maskRaw)) {
      return { ok: false, value, problem: 'Длина префикса подсети должна быть числом' };
    }
    const mask = Number(maskRaw);
    const limit = v4 ? 32 : 128;
    if (mask > limit) {
      return { ok: false, value, problem: `Длина префикса не может быть больше ${String(limit)}` };
    }
  }
  return { ok: true, value, problem: '' };
}

/**
 * Найти карту rspamd по имени файла.
 *
 * Сопоставляем ХВОСТОМ пути, а не полным совпадением: путь внутри
 * контейнера (/etc/rspamd/maps.d/...) и путь в репозитории — разные, и
 * привязываться к первому значит ломаться при любой правке монтирования.
 */
export function matchMapId(
  maps: readonly { id: number; uri: string }[],
  file: string,
): number | null {
  const needle = `/maps.d/${file}`;
  const found = maps.find((map) => map.uri.endsWith(needle));
  return found ? found.id : null;
}
