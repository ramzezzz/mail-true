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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { MessageSummary } from '@mail-true/shared';
import { isServiceLabel, userLabelKeys } from '../src/lib/categories';
import { applyFacets, computeAggregates, EMPTY_SELECTION } from '../src/lib/searchFacets';
import { labelPresence, labelsApi, labelsOfMessage, nextLabelAction, type MailLabel } from '../src/mail/labelsApi';
import { LabelMenu } from '../src/mail/LabelMenu';
import { LabelPills } from '../src/mail/LabelPill';
import { LabelsPage } from '../src/pages/settings/LabelsPage';
import {
  buildSearchParams,
  parseSearchParams,
  toggleLabelFacet,
} from '../src/search/searchParams';

const OPLATIT: MailLabel = { key: 'mt-oplatit', name: 'Оплатить', color: 'red', position: 0 };
const YURIST: MailLabel = { key: 'mt-yurist', name: 'Спросить у юриста', color: 'blue', position: 1 };

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
