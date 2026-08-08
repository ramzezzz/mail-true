/**
 * Хлебные крошки: где я сейчас и куда вернуться.
 *
 * Раньше со страницы импорта («Импорт ящиков из CSV») путь назад был виден
 * только по кнопке в углу панели, а из глубины раздела — вообще никак.
 * Крошки строятся по адресу страницы, поэтому работают и при переходе по
 * прямой ссылке, и после перезагрузки.
 */

/** Звено цепочки. Без `to` — текущая страница, ссылкой не делается. */
export interface Crumb {
  title: string;
  to?: string;
}

/** Название раздела по его адресу. Совпадает с пунктами меню. */
const TITLES: Readonly<Record<string, string>> = {
  '/': 'Дашборд',
  '/users': 'Пользователи',
  '/users/import': 'Импорт ящиков из CSV',
  '/aliases': 'Алиасы',
  '/domains': 'Домены и DNS',
  '/ai': 'Помощник ИИ',
  '/mailbox': 'Ящик пользователя',
  '/audit': 'Журнал аудита',
  '/flow': 'Почтовый поток',
  '/logs': 'Журналы почты',
  '/branding': 'Оформление входа',
  '/sender-logos': 'Логотипы доменов',
  '/spam': 'Антиспам',
  '/monitoring': 'Наблюдение',
  '/backups': 'Резервные копии',
  '/migrate': 'Перенос почты',
  '/domain-change': 'Смена домена',
  '/server-settings': 'Настройки сервера',
  '/tls': 'Сертификат',
};

/**
 * Родитель раздела. Для вложенных страниц он не выводится из адреса:
 * «Ящик пользователя» лежит на /mailbox, но приходят в него из списка
 * ящиков — туда же и возвращаемся.
 */
const PARENTS: Readonly<Record<string, string>> = {
  '/users/import': '/users',
  '/mailbox': '/users',
};

/** Нормализует адрес: убирает хвостовой «/» и всё после «?» и «#». */
function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/u)[0] ?? '/';
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path === '' ? '/' : path;
}

/**
 * Цепочка от корня до текущей страницы. Для самого корня — пустая:
 * на «Дашборде» возвращаться некуда, и крошки там только мешали бы.
 */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const path = normalize(pathname);
  if (path === '/') return [];

  const title = TITLES[path];
  if (title === undefined) return [];

  const chain: string[] = [];
  for (let step: string | undefined = path; step !== undefined; step = PARENTS[step]) {
    chain.unshift(step);
  }

  const crumbs: Crumb[] = [{ title: TITLES['/'] ?? 'Дашборд', to: '/' }];
  for (const step of chain) {
    const stepTitle = TITLES[step];
    if (stepTitle === undefined) continue;
    crumbs.push(step === path ? { title: stepTitle } : { title: stepTitle, to: step });
  }
  return crumbs;
}
