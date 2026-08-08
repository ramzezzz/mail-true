// @vitest-environment jsdom
/**
 * Четыре дефекта, найденные кругом проверки на настоящей почте, и одна
 * недоделка. Все пять проверялись руками на стенде и здесь закреплены:
 *
 *   1. дата письма прошлого года не влезала в колонку в 44px
 *      (clientWidth 44 при scrollWidth 65) и заводила всему списку
 *      горизонтальную прокрутку;
 *   2. длинная тема без пробелов ломала страницу письма по горизонтали
 *      (scrollWidth строки темы 7264px в контейнере 1134px);
 *   3. разделители «Сегодня / Август 2025» повторялись, а письмо из 2099
 *      попадало под заголовок «Сегодня»;
 *   4. пустое письмо и потерянное выглядели одинаково — пустым местом;
 *   5. кнопка «Из Почты» в окне написания только писала в консоль.
 *
 * Медиазапросы и раскладку jsdom не считает, поэтому там, где дефект живёт
 * в правилах, правила читаются из исходников стилей — так же, как в
 * tests/responsiveLayout.test.tsx и tests/motion.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttachmentInfo, Folder, MessageSummary } from '@mail-true/shared';
import { api } from '../src/api';
import type { MessageFull } from '../src/api/types';
import { useUiStore } from '../src/app/store';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { pickableAttachments } from '../src/compose/MailAttachmentPicker';
import { flattenRows } from '../src/mail/MessageList';
import { groupMessagesByPeriod, periodLabel } from '../src/lib/listDates';
import { MessagePage } from '../src/pages/MessagePage';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const css = (relative: string): string => readFileSync(join(SRC, relative), 'utf8');

/** Тело правила по его селектору — вложенных правил в CSS-модулях нет. */
function ruleBody(source: string, selector: string): string {
  const at = source.search(new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')}\\s*[,{]`, 'm'));
  if (at < 0) throw new Error(`нет правила ${selector}`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

/** Часть исходника внутри @media (max-width: N) — правила узкого экрана. */
function narrowRules(source: string, upTo: number): string {
  const at = source.indexOf(`@media (max-width: ${upTo}px)`);
  if (at < 0) throw new Error(`нет медиазапроса до ${upTo}px`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('медиазапрос не закрыт');
}

/* ------------------------------------------------------------------ */
/* 1. Колонка даты                                                      */
/* ------------------------------------------------------------------ */

describe('колонка даты в списке писем', () => {
  const list = css('mail/MessageList.module.css');

  it('не режется жёсткой шириной — растёт по содержимому, как в привычных почтовых интерфейсах', () => {
    // в привычных почтовых интерфейсах `.llc__item_date` в нынешней вёрстке — только nowrap и
    // выравнивание вправо, ширины нет вовсе (эталонные снимки интерфейса).
    // 44px остались у старой колонки цепочек `.llc-t__item_date`, и именно
    // оттуда была взята жёсткая ширина: «5 авг 2025» в неё не помещалось.
    const date = ruleBody(list, '.date');
    expect(date, 'у колонки даты снова фиксированная ширина').not.toMatch(/[^-]width:\s*44px/);
    expect(date, 'нижний предел в 44px должен остаться').toMatch(/min-width:\s*44px/);
    // Без запрета на сжатие flex ужал бы колонку обратно до min-width,
    // и текст снова вылез бы за её край
    expect(date).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('на узком экране — то же самое: 38px это предел, а не ширина', () => {
    const narrow = narrowRules(list, 600);
    const date = ruleBody(narrow, '.date');
    expect(date, 'на телефоне колонка даты всё ещё зажата шириной').not.toMatch(
      /[^-]width:\s*38px/,
    );
    expect(date).toMatch(/min-width:\s*38px/);
  });

  it('ужиматься должна тема — у неё для этого есть min-width: 0', () => {
    expect(ruleBody(list, '.title')).toMatch(/min-width:\s*0/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Длинная тема на странице письма                                   */
/* ------------------------------------------------------------------ */

describe('длинная тема на странице письма', () => {
  const page = css('pages/MessagePage.module.css');

  it('строка темы не растягивается под самое длинное слово', () => {
    // Без min-width: 0 flex-строка раздувалась до 7264px внутри
    // контейнера в 1134px, и горизонтальную прокрутку получала вся страница
    expect(ruleBody(page, '.subjectRow')).toMatch(/min-width:\s*0/);
  });

  it('тема рвётся в любом месте — ссылка отслеживания заказа пробелов не имеет', () => {
    const subject = ruleBody(page, '.subject');
    expect(subject).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  });

  it('и ограничена по высоте — иначе она выдавливала письмо за нижний край', () => {
    const subject = ruleBody(page, '.subject');
    expect(subject).toMatch(/line-clamp:\s*\d/);
    expect(subject).toMatch(/overflow:\s*hidden/);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Разделители периодов                                              */
/* ------------------------------------------------------------------ */

describe('разделители периодов', () => {
  // Среда, 5 августа 2026
  const NOW = new Date(2026, 7, 5, 14, 0, 0);
  const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  it('будущая дата не называется «сегодня»', () => {
    // Письмо с датой 1 января 2099 стояло под заголовком «Сегодня», хотя
    // в самой строке было написано «1 янв 2099»
    expect(periodLabel(iso(2099, 0, 1), NOW)).toBe('Январь 2099');
    expect(periodLabel(iso(2026, 7, 20), NOW)).toBe('Август 2026');
    // «Сегодня» остаётся только за сегодняшним днём — в том числе за
    // временем, которое сегодня ещё не наступило
    expect(periodLabel(iso(2026, 7, 5, 23), NOW)).toBe('Сегодня');
  });

  it('очень старая дата попадает в свой месяц', () => {
    expect(periodLabel(iso(1899, 0, 1), NOW)).toBe('Январь 1899');
  });

  it('заголовок не повторяется на списке в порядке прихода писем', () => {
    // Ровно то, что наблюдалось на стенде: список отсортирован по приходу,
    // а не по дате в письме, и заголовки шли «Июль 2025», «Сегодня»,
    // «Январь 1899», «Сегодня» — четыре штуки, два из них одинаковые.
    const items = [
      { id: 'long', date: iso(2026, 7, 5, 14) }, // Сегодня
      { id: 'y2099', date: iso(2099, 0, 1) }, // Январь 2099
      { id: 'today-b', date: iso(2026, 7, 5, 13) }, // Сегодня
      { id: 'y1899', date: iso(1899, 0, 1) }, // Январь 1899
      { id: 'today-a', date: iso(2026, 7, 5, 12) }, // Сегодня
      { id: 'last-year', date: iso(2025, 6, 5) }, // Июль 2025
    ];
    const groups = groupMessagesByPeriod(items, NOW);
    const labels = groups.map((g) => g.label);
    expect(new Set(labels).size, `заголовки повторяются: ${labels.join(', ')}`).toBe(labels.length);
    expect(labels).toEqual(['Сегодня', 'Январь 2099', 'Январь 1899', 'Июль 2025']);

    // И ни одно письмо не оказалось под чужим заголовком
    for (const group of groups) {
      for (const item of group.items) {
        expect(periodLabel(item.date, NOW)).toBe(group.label);
      }
    }
    // Внутри периода порядок прихода сохранён
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['long', 'today-b', 'today-a']);
  });

  it('в плоском списке строк заголовки тоже уникальны', () => {
    const message = (id: string, date: string) =>
      ({ id, date, folderId: 'inbox' }) as unknown as MessageSummary;
    const rows = flattenRows(
      [
        message('a', iso(2026, 7, 5)),
        message('b', iso(2025, 6, 5)),
        message('c', iso(2026, 7, 5, 9)),
      ],
      NOW,
    );
    const headers = rows.filter((r) => r.type === 'header').map((r) => r.label);
    expect(headers).toEqual(['Сегодня', 'Июль 2025']);
  });
});

/* ------------------------------------------------------------------ */
/* Общая обвязка отрисовки                                              */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [] });
  vi.restoreAllMocks();
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`не дождались: ${what}\n${host.textContent}`);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

/* ------------------------------------------------------------------ */
/* 4. Письмо без текста                                                 */
/* ------------------------------------------------------------------ */

function fullMessage(patch: Partial<MessageFull> = {}): MessageFull {
  return {
    id: 'inbox:900',
    folderId: 'inbox',
    uid: 900,
    threadId: 't-900',
    from: { name: 'Проба', address: 'probe@example.com' },
    to: [{ name: null, address: 'demo@mail.local' }],
    cc: [],
    subject: 'Пустое тело',
    snippet: '',
    date: new Date().toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: false,
    attachmentNames: [],
    labels: [],
    pinned: false,
    sizeBytes: 512,
    messageId: '<mt-empty@example.com>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: null,
    bodyText: '',
    attachments: [],
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 0,
    ...patch,
  };
}

function renderMessage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/inbox%3A900']}>
          <Routes>
            <Route path=":folderId/:messageId" element={<MessagePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe('письмо без текста', () => {
  it('говорит об этом словами, а не пустым местом', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(fullMessage());
    vi.spyOn(api, 'getMessages').mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 });

    renderMessage();
    await waitFor(() => host.textContent!.includes('Пустое тело'), 'письмо');

    expect(host.textContent, 'подписи про отсутствие текста нет').toContain(
      'В этом письме нет текста',
    );
    // Пустого <pre> на месте тела быть не должно: именно он и делал
    // «письмо без текста» неотличимым от «письмо не удалось разобрать»
    expect(host.querySelector('pre')).toBeNull();
  });

  it('пробелы и переводы строк текстом не считаются', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(fullMessage({ bodyText: '\n \r\n\t' }));
    vi.spyOn(api, 'getMessages').mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 });

    renderMessage();
    await waitFor(() => host.textContent!.includes('Пустое тело'), 'письмо');
    expect(host.textContent).toContain('В этом письме нет текста');
  });

  it('когда есть вложения, подпись это объясняет', async () => {
    const attachment: AttachmentInfo = {
      partId: '2',
      filename: 'otchet.txt',
      mimeType: 'text/plain',
      size: 30,
      contentId: null,
      inline: false,
    };
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      fullMessage({ attachments: [attachment], hasAttachments: true }),
    );
    vi.spyOn(api, 'getMessages').mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 });

    renderMessage();
    await waitFor(() => host.textContent!.includes('нет текста'), 'подпись про пустое тело');
    expect(host.textContent).toContain('только вложения');
  });

  it('настоящий текст письма по-прежнему показывается', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(fullMessage({ bodyText: 'тут текст' }));
    vi.spyOn(api, 'getMessages').mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 });

    renderMessage();
    await waitFor(() => host.textContent!.includes('тут текст'), 'текст письма');
    expect(host.querySelector('pre')?.textContent).toBe('тут текст');
    expect(host.textContent).not.toContain('нет текста');
  });

  it('тема письма целиком доступна в подсказке', async () => {
    const long = `https://track.example.com/order/${'x'.repeat(11_000)}`;
    vi.spyOn(api, 'getMessage').mockResolvedValue(fullMessage({ subject: long }));
    vi.spyOn(api, 'getMessages').mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 });

    renderMessage();
    await waitFor(() => host.querySelector('h2') !== null, 'заголовок темы');
    // Обрезка тремя строками прячет хвост темы — он должен остаться
    // достижимым, иначе тема просто исчезнет
    expect(host.querySelector('h2')?.getAttribute('title')).toBe(long);
  });
});

/* ------------------------------------------------------------------ */
/* 5. «Из Почты»                                                        */
/* ------------------------------------------------------------------ */

const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 12,
    system: true,
    uidValidity: 1,
  },
];

const withAttachment: MessageSummary = {
  id: 'inbox:368',
  folderId: 'inbox',
  uid: 368,
  threadId: 't-368',
  from: { name: 'Проба', address: 'probe@example.com' },
  to: [{ name: null, address: 'demo@mail.local' }],
  cc: [],
  subject: 'Со вложением',
  snippet: 'тут вложение',
  date: new Date().toISOString(),
  flags: {
    seen: true,
    flagged: false,
    answered: false,
    forwarded: false,
    draft: false,
    deleted: false,
  },
  hasAttachments: true,
  attachmentNames: ['otchet.txt'],
  labels: [],
  pinned: false,
  sizeBytes: 900,
  messageId: '<mt-attach@example.com>',
} as unknown as MessageSummary;

const otchet: AttachmentInfo = {
  partId: '2',
  filename: 'otchet.txt',
  mimeType: 'text/plain',
  size: 30,
  contentId: null,
  inline: false,
};

function renderCompose() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ComposeWindows />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe('«Из Почты» в окне написания', () => {
  it('открывает выбор и действительно прикрепляет вложение чужого письма', async () => {
    const getMessages = vi.spyOn(api, 'getMessages').mockResolvedValue({
      items: [withAttachment],
      total: 1,
      offset: 0,
      limit: 50,
    });
    vi.spyOn(api, 'getFolders').mockResolvedValue(folders);
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      fullMessage({ id: withAttachment.id, attachments: [otchet], hasAttachments: true }),
    );
    const getPart = vi
      .spyOn(api, 'getMessagePart')
      .mockResolvedValue(new Blob(['строка отчёта'], { type: 'text/plain' }));
    const upload = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      id: 'upload-1',
      filename: 'otchet.txt',
      size: 30,
      mimeType: 'text/plain',
    });

    renderCompose();
    act(() => useUiStore.getState().openCompose());

    // Раньше кнопка только писала в консоль — окна не появлялось
    act(() => button('Из Почты')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => host.textContent!.includes('Со вложением'), 'список писем с вложениями');

    // Спрашиваются именно письма с вложениями
    expect(getMessages.mock.calls.some((c) => c[0]?.filter === 'with-attachments')).toBe(true);

    // Раскрываем письмо — состав вложений подгружается только теперь
    const row = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Со вложением'),
    );
    act(() => row!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(
      () => host.querySelector('input[type="checkbox"]') !== null,
      'список вложений письма',
    );

    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => box.click());

    act(() => button('Прикрепить (1)')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // Байты скачаны тем же маршрутом, что и при обычном скачивании вложения,
    // и загружены обратно обычным POST /api/uploads
    await waitFor(() => upload.mock.calls.length > 0, 'загрузку вложения');
    expect(getPart).toHaveBeenCalledWith('inbox:368', '2');
    expect(upload.mock.calls[0]![0].name).toBe('otchet.txt');

    // И вложение попало в черновик — уйдёт в attachmentIds письма
    await waitFor(
      () => useUiStore.getState().composeWindows[0]!.draft.attachments.length === 1,
      'вложение в черновике',
    );
    expect(useUiStore.getState().composeWindows[0]!.draft.attachments[0]!.id).toBe('upload-1');
  });

  it('встроенные картинки не предлагаются, если в письме есть настоящие вложения', () => {
    const logo: AttachmentInfo = {
      partId: '1.2',
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 900,
      contentId: '<logo@example.com>',
      inline: true,
    };
    expect(pickableAttachments([logo, otchet])).toEqual([otchet]);
    // …но если, кроме них, ничего нет, пустой список был бы хуже
    expect(pickableAttachments([logo])).toEqual([logo]);
  });
});
