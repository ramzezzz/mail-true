// @vitest-environment jsdom
/**
 * Свои метки в интерфейсе.
 *
 * Три вещи проверяются здесь особенно и каждая обратным ходом:
 *
 *   1. служебные слова продукта (`$Snoozed`, `finance`, `reliable`) не
 *      попадают ни в список меток письма, ни в фасеты поиска;
 *   2. метка показывается НАЗВАНИЕМ, а не одним цветом, — иначе для той
 *      части людей, которая цвета не различает, возможности просто нет;
 *   3. удаление метки спрашивает, что делать с помеченными письмами, и
 *      передаёт на сервер именно ответ человека, а не своё умолчание.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import { useUiStore } from '../src/app/store';
import { isServiceLabel, userLabelKeys } from '../src/lib/categories';
import { applyFacets, computeAggregates, EMPTY_SELECTION } from '../src/lib/searchFacets';
import {
  labelPresence,
  labelsApi,
  labelsOfMessage,
  nextLabelAction,
  type MailLabel,
} from '../src/mail/labelsApi';
import { rowLabelKeys } from '../src/mail/threadList';
import { LabelMenu } from '../src/mail/LabelMenu';
import { ListToolbar } from '../src/mail/ListToolbar';
import { LabelPills } from '../src/mail/LabelPill';
import { MessageList, ROW_HEIGHT } from '../src/mail/MessageList';
import { FolderPage } from '../src/pages/FolderPage';
import { LabelsPage } from '../src/pages/settings/LabelsPage';
import { buildSearchParams, parseSearchParams, toggleLabelFacet } from '../src/search/searchParams';

const OPLATIT: MailLabel = { key: 'mt-oplatit', name: 'Оплатить', color: 'red', position: 0 };
const YURIST: MailLabel = {
  key: 'mt-yurist',
  name: 'Спросить у юриста',
  color: 'blue',
  position: 1,
};

function summary(id: string, labels: string[]): MessageSummary {
  return {
    id,
    folderId: 'inbox',
    uid: Number(id),
    threadId: `t-${id}`,
    from: { name: 'Кто-то', address: 'kto@mail.local' },
    to: [],
    cc: [],
    subject: `Письмо ${id}`,
    snippet: '',
    date: new Date(2026, 7, 5).toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
      mdnSent: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels,
    pinned: false,
    returnedFromSnooze: false,
    sizeBytes: 100,
    senderLogoDomain: null,
  } as MessageSummary;
}

/* ------------------------------------------------------------------ */
/* Служебное против своего                                             */
/* ------------------------------------------------------------------ */

describe('пользовательские метки отделены от служебных', () => {
  it('служебные слова продукта не считаются метками', () => {
    for (const word of ['$Snoozed', '$Pinned', '$MDNSent', 'finance', 'reliable', '\\Seen']) {
      expect(isServiceLabel(word)).toBe(true);
    }
    // Обратный ход: своя метка служебной не считается
    expect(isServiceLabel('mt-oplatit')).toBe(false);
  });

  it('регистр не выдаёт служебное слово за метку', () => {
    // Ключевые слова у Dovecot нечувствительны к регистру: без этого
    // `$snoozed` прошло бы как обычная метка и его можно было бы снять.
    expect(isServiceLabel('$snoozed')).toBe(true);
    expect(isServiceLabel('RELIABLE')).toBe(true);
  });

  it('из ключевых слов письма берутся только свои метки', () => {
    const keys = userLabelKeys(['$Snoozed', 'finance', 'reliable', 'mt-oplatit', 'chuzhoe']);
    expect(keys).toEqual(['mt-oplatit']);
  });

  it('метки письма выстраиваются в порядке справочника, а не письма', () => {
    // IMAP отдаёт ключевые слова как попало; без порядка справочника
    // одна и та же пара меток на двух письмах выглядела бы по-разному.
    const found = labelsOfMessage(['mt-yurist', 'mt-oplatit'], [OPLATIT, YURIST]);
    expect(found.map((l) => l.key)).toEqual(['mt-oplatit', 'mt-yurist']);
  });
});

/* ------------------------------------------------------------------ */
/* Состояние метки на выделении                                        */
/* ------------------------------------------------------------------ */

describe('метка на нескольких письмах', () => {
  const messages = [summary('1', ['mt-oplatit']), summary('2', [])];

  it('различает «у всех», «у части» и «ни у кого»', () => {
    expect(labelPresence(messages, 'mt-oplatit')).toBe('some');
    expect(labelPresence([messages[0]!], 'mt-oplatit')).toBe('all');
    expect(labelPresence(messages, 'mt-yurist')).toBe('none');
  });

  it('нажатие на наполовину помеченном выделении ставит метку, а не снимает', () => {
    // Иначе человек, выделивший десять писем и нажавший метку, снял бы её
    // с той половины, где она уже была.
    expect(nextLabelAction('some')).toBe('add');
    expect(nextLabelAction('none')).toBe('add');
    expect(nextLabelAction('all')).toBe('remove');
  });
});

/* ------------------------------------------------------------------ */
/* Отбор по метке в поиске                                             */
/* ------------------------------------------------------------------ */

describe('отбор по метке', () => {
  const messages = [
    summary('1', ['mt-oplatit', '$Snoozed']),
    summary('2', ['mt-yurist']),
    summary('3', ['finance', 'reliable']),
  ];

  it('в счётчики фасетов попадают только свои метки', () => {
    const agg = computeAggregates(messages, [], new Date(2026, 7, 5));
    expect(agg.labels.map((l) => l.id).sort()).toEqual(['mt-oplatit', 'mt-yurist']);
    // Обратный ход: ни служебной пометки возврата, ни чипа категории,
    // ни признака надёжного отправителя в колонке фильтров нет
    expect(agg.labels.some((l) => ['$Snoozed', 'finance', 'reliable'].includes(l.id))).toBe(false);
  });

  it('выбранная метка сужает выборку, а её снятие возвращает всё', () => {
    const only = applyFacets(messages, { ...EMPTY_SELECTION, label: 'mt-oplatit' });
    expect(only.map((m) => m.id)).toEqual(['1']);
    expect(applyFacets(messages, EMPTY_SELECTION)).toHaveLength(3);
  });

  it('метка живёт в адресной строке и переживает оборот', () => {
    const state = parseSearchParams(new URLSearchParams('q_query=акт&label=mt-oplatit'));
    expect(state.facets.label).toBe('mt-oplatit');
    expect(buildSearchParams(state).get('label')).toBe('mt-oplatit');

    // Повторное нажатие снимает отбор — и метка уходит из адреса
    const off = toggleLabelFacet(state, 'mt-oplatit');
    expect(off.facets.label).toBeNull();
    expect(buildSearchParams(off).get('label')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Показ                                                               */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

/** Кнопка со значком: подпись у неё не текстом, а aria-label. */
const iconButton = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;

const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('метка видна названием, а не одним цветом', () => {
  it('пилюля печатает имя метки', () => {
    render(<LabelPills keywords={['mt-oplatit', '$Snoozed']} dictionary={[OPLATIT, YURIST]} />);
    // Название рядом с цветом обязательно: цвет различают не все
    expect(host.textContent).toContain('Оплатить');
    // Обратный ход: служебное слово и метка, которой нет в письме, не рисуются
    expect(host.textContent).not.toContain('Snoozed');
    expect(host.textContent).not.toContain('юриста');
  });

  it('метка, которой нет в справочнике, не показывается голым ключом', () => {
    // Слово в письме есть, а имени и цвета для него нет — рисовать нечего.
    render(<LabelPills keywords={['mt-udalennaya']} dictionary={[]} />);
    expect(host.textContent).toBe('');
  });
});

describe('меню меток', () => {
  it('ставит метку, а вторым нажатием снимает', async () => {
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: true,
      reason: null,
      items: [OPLATIT],
    });
    const apply = vi
      .spyOn(labelsApi, 'applyLabels')
      .mockResolvedValue({ updated: 1, added: [], removed: [] });

    // Письмо БЕЗ метки: первое нажатие обязано её поставить
    const empty = summary('1', []);
    render(<LabelMenu messages={[{ id: empty.id, labels: empty.labels }]} />);
    await waitFor(() => Boolean(button('Оплатить')), 'метка в меню');
    click(button('Оплатить')!);
    await waitFor(() => apply.mock.calls.length === 1, 'запрос простановки');
    expect(apply.mock.calls[0]?.[0]).toEqual({ ids: ['1'], add: ['mt-oplatit'] });

    // Обратный ход: то же письмо, но уже с меткой — нажатие снимает
    act(() => root.unmount());
    root = createRoot(host);
    const marked = summary('1', ['mt-oplatit']);
    render(<LabelMenu messages={[{ id: marked.id, labels: marked.labels }]} />);
    await waitFor(() => Boolean(button('Оплатить')), 'метка в меню');
    click(button('Оплатить')!);
    await waitFor(() => apply.mock.calls.length === 2, 'запрос снятия');
    expect(apply.mock.calls[1]?.[0]).toEqual({ ids: ['1'], remove: ['mt-oplatit'] });
  });
});

/* ------------------------------------------------------------------ */
/* Строка списка: переписка                                            */
/* ------------------------------------------------------------------ */

describe('метка на строке-переписке', () => {
  /** Строка-переписка: показано письмо `shown`, а сводка знает про весь разговор. */
  function row(shownLabels: string[], threadLabels: string[]): MessageSummary {
    return {
      ...summary('3', shownLabels),
      thread: {
        messageIds: ['inbox:1', 'inbox:2', 'inbox:3'],
        count: 3,
        unreadCount: 0,
        flagged: false,
        hasAttachments: false,
        labels: threadLabels,
        participants: [],
      },
    };
  }

  it('строка показывает метки разговора, а не последнего письма', () => {
    // Разговор из трёх писем. Метку поставили на весь разговор, потом
    // пришёл ответ — у него ключевого слова нет. По последнему письму
    // пометка исчезла бы из списка ровно тогда, когда разговор ожил.
    expect(rowLabelKeys(row([], ['mt-oplatit', 'mt-yurist']))).toEqual(['mt-oplatit', 'mt-yurist']);
  });

  it('служебные слова продукта в метки строки не попадают', () => {
    // Чипы категорий и признак надёжного отправителя приезжают в том же
    // поле, что и метки, — пилюлей они не рисуются ни у письма, ни у строки.
    expect(rowLabelKeys(row([], ['finance', 'reliable', '$Snoozed', 'mt-oplatit']))).toEqual([
      'mt-oplatit',
    ]);
  });

  it('строка-письмо (без группировки) остаётся при своих метках', () => {
    // Сводки переписки нет — берутся ключевые слова самого письма,
    // и поведение остаётся ровно прежним.
    expect(rowLabelKeys(summary('1', ['mt-oplatit', '$Snoozed']))).toEqual(['mt-oplatit']);
  });
});

/**
 * jsdom не считает размеров: offsetWidth/offsetHeight у него всегда нули,
 * а виртуализация меряет контейнер прокрутки именно ими — при нулевой
 * высоте она не отрисовывает ни одной строки. Выдаём ей окно 1200×800,
 * ровно как в tests/listAnatomy.test.tsx.
 */
function stubLayout() {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1200,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 800,
  });
}

describe('пилюля в строке не растит строку', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const listCss = readFileSync(join(SRC, 'mail/MessageList.module.css'), 'utf8');
  const pillCss = readFileSync(join(SRC, 'mail/LabelPill.module.css'), 'utf8');

  /** Тело правила по селектору (первое вхождение). */
  function rule(css: string, selector: string): string {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `в CSS нет правила ${selector}`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', at);
    return css.slice(open + 1, css.indexOf('}', open));
  }

  it('пилюля ниже самой низкой строки списка', () => {
    // Высоту строки виртуализация кладёт в transform числом (ROW_HEIGHT),
    // и разойтись с CSS ей нельзя: список поедет тем сильнее, чем дальше
    // пролистали. Самый жёсткий случай — компактный режим, 40px.
    const height = Number(/height:\s*(\d+)px/u.exec(rule(pillCss, '.pill'))?.[1]);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(ROW_HEIGHT.desktop.compact);
    // И не выше счётчика переписки, который в строке уже живёт
    const badge = Number(/height:\s*(\d+)px/u.exec(rule(listCss, '.threadCount'))?.[1]);
    expect(height).toBeLessThanOrEqual(badge);
  });

  it('название метки — цветом темы, а цвет метки — только в кружке', () => {
    /*
     * Тем оформления девять. Замерено на стенде: если печатать название
     * цветом самой метки, контраст к её подложке падает до 2.13 (жёлтая)
     * при требуемых 4.5 для мелкого текста — то есть половина палитры
     * не читается. Обычный цвет текста берёт контраст у темы (11.5 на
     * светлых, 9.5 на тёмной) и не требует девяти оттенков на каждую тему.
     */
    const pill = rule(pillCss, '.pill');
    expect(pill).toContain('color: var(--mt-color-text-primary)');
    expect(pill, 'название печаталось бы цветом метки').not.toMatch(
      /\n\s*color:\s*var\(--mt-label-color\)/u,
    );
    // А цвет метки при этом никуда не делся — он в кружке и в подложке
    expect(rule(pillCss, '.dot')).toContain('var(--mt-label-color)');
    expect(pill).toContain('--mt-label-color');
  });

  it('ряд меток не переносится на вторую строку', () => {
    // Перенос — единственный способ, которым ряд пилюль мог бы вырасти
    // выше своей высоты и растянуть строку.
    expect(rule(listCss, '.rowLabels')).toMatch(/flex-wrap:\s*nowrap/u);
    expect(rule(listCss, '.rowLabels')).toMatch(/overflow:\s*hidden/u);
  });

  it('строка списка рисует метку названием, а не только цветом', () => {
    stubLayout();
    useUiStore.setState({ selectedIds: new Set<string>() });
    const message = summary('1', ['mt-oplatit']);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={[message]} labels={[OPLATIT, YURIST]} />
        </MemoryRouter>,
      );
    });
    const pill = host.querySelector('[class*="rowLabels"]');
    expect(pill, 'пилюля метки не отрисовалась в строке').not.toBeNull();
    expect(pill!.textContent).toContain('Оплатить');
    // Обратный ход: чужого и служебного в строке нет
    expect(host.textContent).not.toContain('юриста');
  });

  it('без справочника строка выглядит как прежде', () => {
    stubLayout();
    // Список рисуется и в проверках, где запроса к серверу нет вовсе:
    // требовать провайдер запросов ради украшения строки нельзя.
    useUiStore.setState({ selectedIds: new Set<string>() });
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList messages={[summary('1', ['mt-oplatit'])]} />
        </MemoryRouter>,
      );
    });
    expect(host.querySelector('[class*="rowLabels"]')).toBeNull();
  });
});

describe('отбор списка по метке', () => {
  /** Обязательные свойства панели, до которых этой проверке дела нет. */
  const toolbarStub = {
    selectedCount: 0,
    filter: 'all' as const,
    folders: [],
    onFilterChange: () => {},
    onSelectAll: () => {},
    onClearSelection: () => {},
    onMarkAllRead: () => {},
    onDelete: () => {},
    onArchive: () => {},
    onMoveTo: () => {},
    onUnsubscribe: () => {},
    onMarkUnread: () => {},
    onToggleFlag: () => {},
    onSpam: () => {},
    onPrint: () => {},
    onCreateFilter: () => {},
    onForwardAsAttachment: () => {},
  };

  it('метка стоит в меню «Фильтр» и переключается нажатием', () => {
    const calls: Array<string | null> = [];
    act(() => {
      root.render(
        <MemoryRouter>
          <ListToolbar
            {...toolbarStub}
            labels={[OPLATIT]}
            labelFilter={null}
            onLabelFilterChange={(key) => calls.push(key)}
          />
        </MemoryRouter>,
      );
    });
    click(button('Фильтр')!);
    // Метка названа, а не показана одним кружком: цвет различают не все
    expect(button('Оплатить')).toBeDefined();
    click(button('Оплатить')!);
    expect(calls).toEqual(['mt-oplatit']);
  });

  it('повторное нажатие снимает отбор', () => {
    const calls: Array<string | null> = [];
    act(() => {
      root.render(
        <MemoryRouter>
          <ListToolbar
            {...toolbarStub}
            labels={[OPLATIT]}
            labelFilter="mt-oplatit"
            onLabelFilterChange={(key) => calls.push(key)}
          />
        </MemoryRouter>,
      );
    });
    click(button('Фильтр')!);
    click(button('Оплатить')!);
    expect(calls).toEqual([null]);
  });

  it('без меток группы в меню нет вовсе', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <ListToolbar {...toolbarStub} labels={[]} onLabelFilterChange={() => {}} />
        </MemoryRouter>,
      );
    });
    click(button('Фильтр')!);
    // Заголовок над пустотой ничего не сообщает
    expect(button('Оплатить')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Отбор по метке: его делает сервер                                    */
/* ------------------------------------------------------------------ */

describe('отбор списка по метке', () => {
  /** Ящик заглушки: помечено одно письмо из двух. */
  function mailbox() {
    vi.spyOn(api, 'getFolders').mockResolvedValue([]);
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: true,
      reason: null,
      items: [OPLATIT],
    });
    /*
     * Заглушка отбирает САМА, по условию запроса, — как настоящий сервер.
     * Отбери она всё и понадейся на сито в браузере, проверка перестала бы
     * отличать «отбор уехал на сервер» от «отбор остался у нас».
     */
    return vi.spyOn(api, 'getMessages').mockImplementation(async (query) => {
      const all = [summary('1', ['mt-oplatit']), summary('2', [])];
      const items = query.label ? all.filter((m) => m.labels.includes(query.label as string)) : all;
      return { items, total: items.length, offset: query.offset, limit: query.limit };
    });
  }

  it('выбранная метка уходит в запрос списка, а не отсеивает загруженное', async () => {
    const getMessages = mailbox();
    useUiStore.setState({ selectedIds: new Set<string>() });
    render(<FolderPage />);

    await waitFor(() => getMessages.mock.calls.length > 0, 'первый запрос списка');
    // Прямой ход: до выбора метки условия отбора в запросе нет
    expect(getMessages.mock.calls[0]?.[0]?.label).toBeUndefined();

    await waitFor(() => Boolean(button('Фильтр')), 'меню отбора');
    click(button('Фильтр')!);
    await waitFor(() => Boolean(button('Оплатить')), 'метку в меню отбора');
    click(button('Оплатить')!);

    // Ушёл НОВЫЙ запрос — с меткой. Это и есть доказательство: список
    // с меткой сервер собирает заново по всей папке, а не браузер по
    // загруженным строкам.
    await waitFor(
      () => getMessages.mock.calls.some(([q]) => q.label === 'mt-oplatit'),
      'запрос с отбором по метке',
    );
  });

  it('подписи «из загруженных» над списком больше нет', async () => {
    /*
     * Обратный ход к прежнему временному решению. Пока отбор шёл по
     * загруженным строкам, над списком стояла честная оговорка «1 из
     * загруженных 480». Теперь отбирает сервер по всей папке, и оговорка
     * стала бы неправдой: список с меткой полон по построению.
     */
    const getMessages = mailbox();
    useUiStore.setState({ selectedIds: new Set<string>() });
    render(<FolderPage />);
    await waitFor(() => getMessages.mock.calls.length > 0, 'первый запрос списка');

    await waitFor(() => Boolean(button('Фильтр')), 'меню отбора');
    click(button('Фильтр')!);
    await waitFor(() => Boolean(button('Оплатить')), 'метку в меню отбора');
    click(button('Оплатить')!);
    await waitFor(
      () => getMessages.mock.calls.some(([q]) => q.label === 'mt-oplatit'),
      'запрос с отбором по метке',
    );
    expect(host.textContent).not.toContain('загруженных');
  });
});

describe('меню меток над перепиской', () => {
  it('галочка считается по строке, а метка ставится на весь разговор', async () => {
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: true,
      reason: null,
      items: [OPLATIT],
    });
    const apply = vi
      .spyOn(labelsApi, 'applyLabels')
      .mockResolvedValue({ updated: 3, added: [], removed: [] });

    // Строка — переписка из трёх писем; метка стоит (объединение),
    // поэтому нажатие обязано СНЯТЬ её со всех трёх.
    render(
      <LabelMenu
        messages={[{ id: 'inbox:3', labels: ['mt-oplatit'] }]}
        targetIds={['inbox:1', 'inbox:2', 'inbox:3']}
      />,
    );
    await waitFor(() => Boolean(button('Оплатить')), 'метка в меню');
    click(button('Оплатить')!);
    await waitFor(() => apply.mock.calls.length === 1, 'запрос снятия');
    expect(apply.mock.calls[0]?.[0]).toEqual({
      ids: ['inbox:1', 'inbox:2', 'inbox:3'],
      remove: ['mt-oplatit'],
    });
  });
});

describe('справочник в настройках', () => {
  it('удаление спрашивает, что будет с письмами, и передаёт ответ человека', async () => {
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: true,
      reason: null,
      items: [OPLATIT],
    });
    const remove = vi.spyOn(labelsApi, 'deleteLabel').mockResolvedValue({
      ok: true,
      key: OPLATIT.key,
      purged: false,
      removedFromMessages: 0,
    });

    render(<LabelsPage />);
    await waitFor(() => Boolean(iconButton('Удалить метку')), 'кнопка удаления');
    click(iconButton('Удалить метку')!);
    await waitFor(
      () => host.textContent?.includes('Снять метку с помеченных писем') === true,
      'вопрос о помеченных письмах',
    );

    // Ключевое: по умолчанию письма НЕ трогаются, и это сказано словами
    expect(host.textContent).toContain('останется в письмах');
    click(button('Удалить')!);
    await waitFor(() => remove.mock.calls.length === 1, 'запрос удаления');
    expect(remove.mock.calls[0]).toEqual(['mt-oplatit', false]);
  });

  it('согласие снять метку с писем доезжает до сервера', async () => {
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: true,
      reason: null,
      items: [OPLATIT],
    });
    const remove = vi.spyOn(labelsApi, 'deleteLabel').mockResolvedValue({
      ok: true,
      key: OPLATIT.key,
      purged: true,
      removedFromMessages: 43,
    });

    render(<LabelsPage />);
    await waitFor(() => Boolean(iconButton('Удалить метку')), 'кнопка удаления');
    click(iconButton('Удалить метку')!);
    await waitFor(
      () => host.querySelector('input[type="checkbox"]') !== null,
      'переключатель снятия',
    );
    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    // Именно click(), а не подмена checked: React слушает у флажков
    // клик, и присвоенное поле само по себе onChange не вызывает.
    act(() => checkbox.click());
    // Предупреждение о необратимости появляется вместе с согласием
    await waitFor(
      () => host.textContent?.includes('Отменить это нельзя') === true,
      'предупреждение о необратимости',
    );

    click(button('Удалить')!);
    await waitFor(() => remove.mock.calls.length === 1, 'запрос удаления');
    expect(remove.mock.calls[0]).toEqual(['mt-oplatit', true]);
  });

  it('без справочника раздел честно говорит, что метки недоступны', async () => {
    vi.spyOn(labelsApi, 'getLabels').mockResolvedValue({
      available: false,
      reason: 'Таблицы меток нет',
      items: [],
    });
    render(<LabelsPage />);
    await waitFor(
      () => host.textContent?.includes('Таблицы меток нет') === true,
      'причина недоступности',
    );
    // Обратный ход: кнопки, за которой ничего не стоит, на странице нет
    expect(button('Создать метку')).toBeUndefined();
  });
});
