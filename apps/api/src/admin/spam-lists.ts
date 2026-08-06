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
        problem: 'Это адрес, а не домен. Уберите часть до собаки или воспользуйтесь списком адресов',
      };
    }
    if (!DOMAIN_RE.test(value)) {
      return { ok: false, value, problem: 'Не похоже на доменное имя (нужен хотя бы один разделитель-точка)' };
    }
    return { ok: true, value, problem: '' };
  }

  // Адрес сервера: одиночный или подсеть
  const [address = '', maskRaw, ...rest] = value.split('/');
  if (rest.length > 0) return { ok: false, value, problem: 'Лишняя косая черта в записи подсети' };
  const v4 = isIpv4(address);
  const v6 = isIpv6(address);
  if (!v4 && !v6) return { ok: false, value, problem: 'Не похоже на адрес сервера (IPv4 или IPv6)' };
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
