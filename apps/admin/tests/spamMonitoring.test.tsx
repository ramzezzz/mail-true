/**
 * Разделы «Антиспам» и «Наблюдение».
 *
 * Проверки закрывают ровно те обещания, которыми раздел может соврать, и
 * падают на прежнем коде, где вместо разделов стояли заглушки:
 *
 *   1. Пометки «скоро» с обоих пунктов сняты, а маршруты ведут на живые
 *      страницы, а не на StubPage.
 *   2. Раздел называется «Антиспам»: он показывает работу фильтра и
 *      позволяет ею управлять, а прежнее «Спам» читалось как папка со
 *      спамом — заказчик так его и понял.
 *   3. У порогов НЕТ кнопки сохранения: контроллер rspamd их менять не
 *      даёт, и ложная кнопка была бы хуже её отсутствия. Вместо неё —
 *      объяснение причины, путь к файлу и команда применения.
 *   4. Раздел «Наблюдение» поднимает плохое наверх и честно перечисляет
 *      то, чего он проверить не может.
 *   5. Удаление записи из списка уходит строкой запроса, а не частью
 *      пути: в записях бывают косые черты (подсети).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, visibleNav } from '../src/lib/access';
import { breadcrumbsFor } from '../src/lib/breadcrumbs';
import { byGroup, problemsFirst } from '../src/pages/MonitoringPage';
import { entryPlaceholder, filterEntries, formatUptime, scoreText } from '../src/pages/SpamPage';
import type { HealthCheck, Permission } from '../src/api/types';

const file = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

const READONLY: Permission[] = ['overview.read', 'users.read', 'audit.read'];

describe('оба раздела перестали быть заглушками', () => {
  it('маршруты ведут на настоящие страницы', () => {
    const router = file('src/app/router.tsx');
    expect(router).toContain("{ path: 'spam', element: <SpamPage /> }");
    expect(router).toContain("{ path: 'monitoring', element: <MonitoringPage /> }");
    // Заглушка удалена целиком: неиспользуемая страница «здесь скоро
    // будет» — это приглашение вернуть её обратно.
    expect(router).not.toContain('StubPage');
  });

  it('пункты меню видны дежурному и не помечены «скоро»', () => {
    const titles = visibleNav(READONLY).map((i) => i.title);
    // Именно «Антиспам»: раздел управляет фильтром, а не показывает спам.
    expect(titles).toContain('Антиспам');
    expect(titles).not.toContain('Спам');
    expect(titles).toContain('Наблюдение');
    expect(NAV_ITEMS.find((i) => i.to === '/spam')?.stub).toBeFalsy();
    expect(NAV_ITEMS.find((i) => i.to === '/monitoring')?.stub).toBeFalsy();
  });

  it('в крошках оба раздела названы по-русски', () => {
    // Крошка обязана совпадать с пунктом меню: разные имена одного раздела
    // читаются как два разных места.
    expect(breadcrumbsFor('/spam').at(-1)?.title).toBe('Антиспам');
    expect(breadcrumbsFor('/monitoring').at(-1)?.title).toBe('Наблюдение');
  });
});

describe('антиспам: честность вместо ложных кнопок', () => {
  const source = file('src/pages/SpamPage.tsx');
  const client = file('src/api/client.ts');

  it('кнопки сохранения порогов нет, а объяснение есть', () => {
    // Ни одного вызова, который бы делал вид, что пороги можно записать.
    expect(client).not.toMatch(/spam(Save|Set)Thresholds/u);
    expect(client).not.toMatch(/saveactions/iu);
    // Зато причина и способ изменить показываются, а не выбрасываются.
    // Прежде на экране были голые числа и одна строка примечания — раздел
    // из-за этого выглядел настройкой, в которой ничего не настраивается.
    expect(source).toContain('whyReadonly');
    expect(source).toContain('howTo.file');
    expect(source).toContain('howTo.command');
  });

  it('каждый порог объясняет, что произойдёт с письмом и куда его двигать', () => {
    // Число без последствий настройкой не является: «6» не отвечает ни на
    // один вопрос, с которым к порогам приходят.
    expect(source).toContain('item.effect');
    expect(source).toContain('item.higher');
    expect(source).toContain('item.lower');
    // Выключенный порог обязан сказать, чем это оборачивается.
    expect(source).toContain('item.off');
  });

  it('пороги показаны для обоих видов отправителей', () => {
    // У писем своих аутентифицированных отправителей пороги другие, и без
    // второго набора экран не объясняет, почему письмо сотрудника с той же
    // оценкой в спам не ушло.
    expect(source).toContain('data.profiles.map');
    expect(source).toContain('profile.warnings');
  });

  it('раздел показывает, что счётчики обнуляются при перезапуске', () => {
    // Без этой оговорки провал в числах читался бы как «спама не было».
    expect(source).toContain('periodNote');
    expect(source).toContain('restarts');
  });

  it('раздел признаётся, что сам подмешивает письма в счётчики', () => {
    // Панель проверяет подпись DKIM пробным письмом на каждом открытии
    // дашборда, и на тихом сервере это заметная доля «проверенных».
    expect(source).toContain('selfProbeNote');
  });

  it('удаление записи уходит строкой запроса: в записях бывают косые черты', () => {
    expect(client).toContain('/entries${query({ value })}');
  });

  it('обучение и правка списков спрятаны за разными правами', () => {
    // Список меняет приём почты для всего сервера — это право владельца.
    expect(source).toContain("can(session?.permissions, 'domains.write')");
    // Обучение — ежедневная работа разбора обращений.
    expect(source).toContain("can(session?.permissions, 'users.write')");
    // Темы писем — то же, что журналы почты.
    expect(source).toContain("can(session?.permissions, 'mailbox.impersonate')");
  });
});

describe('антиспам: списки таблицами на вкладках', () => {
  const source = file('src/pages/SpamPage.tsx');

  it('списки показаны таблицей, а не столбиком строк', () => {
    // Раньше восемь списков шли подряд панелями со списком <li>: найти в
    // сотне разрешённых адресов нужный можно было только поиском браузера.
    expect(source).toContain('function ListTable');
    expect(source).not.toContain('styles.entries');
  });

  it('у списка есть поиск и вкладка на каждый список', () => {
    expect(source).toContain('filterEntries');
    expect(source).toContain('Поиск по списку');
    expect(source).toContain('label="Списки антиспама"');
  });

  it('пустой список объясняет, зачем он нужен, а не пишет «пусто»', () => {
    expect(source).toContain('list.purpose');
    expect(source).toContain('list.example');
    expect(source).not.toContain('Список пуст');
  });

  it('поиск идёт подстрокой и без учёта регистра', () => {
    // Ищут обычно по домену внутри адреса — «кто разрешён из partner».
    const entries = ['ivan@Partner.example', 'boss@other.example', '203.0.113.0/24'];
    expect(filterEntries(entries, 'partner')).toEqual(['ivan@Partner.example']);
    expect(filterEntries(entries, ' 0/24 ')).toEqual(['203.0.113.0/24']);
    // Пустой запрос ничего не прячет.
    expect(filterEntries(entries, '   ')).toHaveLength(3);
  });
});

describe('антиспам: мелочи интерфейса', () => {
  it('подсказка ввода своя у каждого вида записи', () => {
    expect(entryPlaceholder('address')).toContain('@');
    expect(entryPlaceholder('domain')).not.toContain('@');
    expect(entryPlaceholder('ip')).toContain('/');
  });

  it('вес правила всегда со знаком: без плюса минус читается как опечатка', () => {
    expect(scoreText(12)).toBe('+12');
    expect(scoreText(-6)).toBe('-6');
  });

  it('время работы читается словами, а не в секундах', () => {
    expect(formatUptime(90)).toBe('1 мин');
    expect(formatUptime(3 * 3600 + 25 * 60)).toBe('3 ч 25 мин');
    expect(formatUptime(2 * 86_400 + 5 * 3600)).toBe('2 суток 5 ч');
    expect(formatUptime(86_400)).toBe('1 сутки 0 ч');
  });
});

describe('наблюдение: плохое наверху', () => {
  const checks: HealthCheck[] = [
    { id: 'a', group: 'Службы', title: 'IMAP', state: 'ok', detail: '' },
    { id: 'b', group: 'Службы', title: 'SMTP', state: 'warn', detail: '' },
    { id: 'c', group: 'Место', title: 'Том', state: 'fail', detail: '' },
    { id: 'd', group: 'Очередь', title: 'Очередь', state: 'unknown', detail: '' },
    { id: 'e', group: 'Службы', title: 'Redis', state: 'ok', detail: '' },
  ];

  it('в блок «требует внимания» попадает только неисправное, отказы первыми', () => {
    // Экран, на котором единственная красная строка стоит четырнадцатой,
    // читается как исправный: до неё не долистывают.
    expect(problemsFirst(checks).map((c) => c.id)).toEqual(['c', 'b', 'd']);
  });

  it('исправный сервер даёт пустой список проблем, а не «нет данных»', () => {
    expect(problemsFirst([checks[0]!, checks[4]!])).toEqual([]);
  });

  it('группы идут в том порядке, в котором пришли с сервера', () => {
    expect(byGroup(checks).map(([group]) => group)).toEqual(['Службы', 'Место', 'Очередь']);
    expect(byGroup(checks)[0]?.[1].map((c) => c.id)).toEqual(['a', 'b', 'e']);
  });

  it('раздел перечисляет то, чего он не проверяет', () => {
    // Иначе зелёный экран прочитается как «проверено всё», хотя внешних
    // адресов и прав на .env панель не видит принципиально.
    const source = file('src/pages/MonitoringPage.tsx');
    expect(source).toContain('shellOnly');
    expect(source).toContain('Чего этот раздел не проверяет');
  });

  it('состояние подписано словом, а не только цветом', () => {
    const source = file('src/pages/MonitoringPage.tsx');
    expect(source).toContain("ok: 'в порядке'");
    expect(source).toContain("fail: 'не работает'");
    // «Неизвестно» — отдельная ступень: непроверенное не значит исправное.
    expect(source).toContain("unknown: 'неизвестно'");
  });
});
