/**
 * Какие имена спрашивать про логотип одного домена.
 *
 * Почта редко приходит с «голого» домена: письма шлют `mail.sberbank.ru`,
 * `email.aliexpress.com`, `notifications.github.com`. Значка сайта у таких
 * поддоменов обычно нет — он есть у главного домена, и логотип у них общий.
 * Поэтому после самого домена пробуем его родителя.
 *
 * Почему это не открывает подделку. Родитель берётся ОТБРАСЫВАНИЕМ ЛЕВОЙ
 * части, то есть остаётся в пределах той же зоны: у `sberbank.ru.evil.com`
 * родителем будет `ru.evil.com`, а никак не `sberbank.ru`. Вдобавок сюда
 * попадают только домены, ПРОШЕДШИЕ проверку подлинности письма
 * (mail/sender-auth.ts), — то есть подделка отсеяна раньше.
 *
 * Дальше родителя не поднимаемся: `a.b.c.example.com` -> `b.c.example.com`
 * ничего не добавит, а каждый лишний шаг — это лишний поход в сеть.
 */

/**
 * Окончания, ниже которых «родителя» нет: это не домены, а зоны.
 *
 * Полный публичный список суффиксов (PSL) сюда не тянется намеренно: это
 * несколько тысяч строк, которые надо обновлять, а цена ошибки здесь всего
 * лишь один бесполезный запрос. Перечислены самые частые составные зоны —
 * ровно чтобы не ходить за логотипом к `co.uk`.
 */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ac.uk',
  'gov.uk',
  'net.uk',
  'sch.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  'com.tr',
  'com.mx',
  'com.ar',
  'com.sg',
  'com.hk',
  'com.tw',
  'com.ua',
  'co.il',
  'co.za',
  'co.kr',
  'com.pl',
  'com.es',
  'co.id',
  'org.ru',
  'net.ru',
  'com.ru',
  'pp.ru',
  'msk.ru',
  'spb.ru',
  'com.by',
  'org.by',
]);

/** Домен сам по себе является зоной — логотипа у него быть не может. */
export function isPublicSuffix(domain: string): boolean {
  const labels = domain.split('.');
  if (labels.length < 2) return true;
  return PUBLIC_SUFFIXES.has(domain);
}

/**
 * Имена для поиска логотипа: сам домен и, если есть, его родитель.
 * Всегда 1 или 2 значения — предел походов в сеть на один домен.
 */
export function logoDomainCandidates(domain: string): string[] {
  const self = domain.toLowerCase();
  if (isPublicSuffix(self)) return [];

  const labels = self.split('.');
  if (labels.length <= 2) return [self];

  const parent = labels.slice(1).join('.');
  if (isPublicSuffix(parent)) return [self];
  return [self, parent];
}
