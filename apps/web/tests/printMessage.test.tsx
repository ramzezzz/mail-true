// @vitest-environment jsdom
/**
 * Печать письма.
 *
 * «Распечатать» отправляла на принтер страницу почты как есть: колонку
 * папок, панель действий, кнопки, строку поиска — и письмо где-то посреди
 * всего этого. В тёмной теме лист вдобавок уходил залитым чёрным.
 *
 * Проверяется то, что попадёт на бумагу: шапка письма с отправителем,
 * адресатами, датой и перечнем вложений; правила `@media print`, которые
 * снимают интерфейс и делают лист белым; адреса ссылок, без которых
 * ссылка на бумаге — просто подчёркнутое слово.
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
import { api } from '../src/api';
import type { MessageFull } from '../src/api/types';
import {
  annotatePrintLinks,
  printAddresses,
  printDate,
  printableHref,
  PRINT_HREF_ATTR,
} from '../src/lib/printMessage';
import { MessagePage } from '../src/pages/MessagePage';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const printCss = readFileSync(join(SRC, 'pages/MessagePage.module.css'), 'utf8');

/** Кусок стилей внутри `@media print` — только он и относится к бумаге. */
function printBlock(css: string): string {
  const at = css.indexOf('@media print');
  return at < 0 ? '' : css.slice(at);
}

const printRules = printBlock(printCss);

let host: HTMLDivElement;
let root: Root;

function serverMessage(patch: Partial<MessageFull> = {}): MessageFull {
  return {
    id: 'inbox:501',
    folderId: 'inbox',
    uid: 501,
    threadId: 't-501',
    from: { name: 'Ирина Петрова', address: 'irina@mail.local' },
    to: [{ name: 'Дмитрий', address: 'dmitry@mail.local' }],
    cc: [{ name: null, address: 'boss@mail.local' }],
    subject: 'Протокол разногласий по договору № 452/26',
    snippet: 'Протокол',
    date: '2026-08-04T09:15:00.000Z',
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: true,
    attachmentNames: ['Протокол.pdf'],
    labels: [],
    pinned: false,
    sizeBytes: 4096,
    messageId: '<p-501@mail.local>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml:
      '<p>Добрый день! Подробности <a href="https://example.com/very/long/path?id=42">здесь</a>.</p>',
    bodyText: 'Добрый день!',
    attachments: [
      {
        partId: '2',
        filename: 'Протокол.pdf',
        mimeType: 'application/pdf',
        size: 120_000,
        contentId: null,
        inline: false,
      },
    ],
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 0,
    ...patch,
  };
}

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/inbox%3A501']}>
          <Routes>
            <Route path=":folderId/:messageId" element={<MessagePage />} />
          </Routes>
        </MemoryRouter>
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

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.body.dataset.mtPrint;
  vi.restoreAllMocks();
});

describe('шапка листа', () => {
  it('несёт тему, отправителя, адресатов, дату и перечень вложений', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    render();
    await waitFor(() => Boolean(host.querySelector('header')), 'шапку листа');

    const head = host.querySelector('header') as HTMLElement;
    const text = head.textContent ?? '';
    expect(text).toContain('Протокол разногласий по договору № 452/26');
    // Именно имя И адрес: по адресу и отличают настоящего отправителя
    expect(text).toContain('Ирина Петрова <irina@mail.local>');
    expect(text).toContain('dmitry@mail.local');
    expect(text).toContain('boss@mail.local');
    expect(text).toContain('2026');
    // Самих файлов на бумаге не будет — но их имена нужны
    expect(text).toContain('Протокол.pdf');
  });

  it('копии нет — строки «Копия» на листе тоже нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage({ cc: [] }));
    render();
    await waitFor(() => Boolean(host.querySelector('header')), 'шапку листа');
    expect(host.querySelector('header')?.textContent).not.toContain('Копия');
  });

  /**
   * Колонтитула с темой на каждом листе нет намеренно: повторять строку
   * умеют только краевые блоки страницы (`@page { @top-center }`), а Chrome
   * их не поддерживает. Приём с `position: fixed` проверен на настоящем PDF
   * двухстраничного письма: строка появилась один раз и ВНИЗУ первого листа,
   * а на втором её не было — хуже, чем ничего. Тест сторожит, чтобы приём
   * не вернулся «на всякий случай».
   */
  it('колонтитула на position: fixed нет — в Chrome он не повторяется', () => {
    expect(printRules).not.toMatch(/\.printRunningHead\s*\{[^}]*position:\s*fixed/);
  });

  it('на экране шапки листа не видно — она только для бумаги', () => {
    // Правило вне `@media print`: на экране блок выключен
    const beforePrint = printCss.slice(0, printCss.indexOf('@media print'));
    expect(beforePrint).toMatch(/\.printHead[\s\S]{0,60}\{\s*display:\s*none/);
  });
});

describe('страница письма помечает себя для печати', () => {
  it('пока письмо открыто, на body стоит метка, после — нет', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    render();
    await waitFor(() => document.body.dataset.mtPrint === 'message', 'метку печати');

    act(() => root.unmount());
    // Без снятия метки печать списка писем давала бы пустой лист
    expect(document.body.dataset.mtPrint).toBeUndefined();
    root = createRoot(host);
  });
});

describe('правила печати', () => {
  it('действуют только на странице письма', () => {
    // Правила глобальные: без привязки к метке они снесли бы с бумаги
    // и список писем, и настройки
    expect(printRules).toContain("body[data-mt-print='message']");
  });

  it('снимают с бумаги интерфейс почты', () => {
    expect(printRules).toMatch(
      /:global\(body\[data-mt-print='message'\]\) \*\s*\{\s*visibility:\s*hidden/,
    );
    for (const chrome of ['.toolbar', '.bottomBar', '.senderBlock', '.imagesBar']) {
      expect(printRules, `${chrome} должен быть снят с печати`).toContain(chrome);
    }
    expect(printRules).toMatch(/display:\s*none\s*!important/);
  });

  it('оставляют на бумаге сам лист письма', () => {
    expect(printRules).toMatch(/\.page \*\s*\{\s*visibility:\s*visible/);
  });

  it('делают лист белым независимо от темы', () => {
    // Тёмная тема, отправленная на принтер как есть, — залитый чёрным лист
    expect(printRules).toMatch(/color-scheme:\s*light/);
    expect(printRules).toMatch(/background:\s*#fff\s*!important/);
    expect(printRules).toMatch(/--mt-color-text-primary:\s*#000/);
    // Ни одного тёмного фона в правилах печати быть не должно
    const darkFills = printRules.match(/background(-color)?:\s*(#[0-3][0-9a-f]{2,5}\b|black)/gi);
    expect(darkFills).toBeNull();
  });

  it('не режут картинки и не обрезают широкие таблицы', () => {
    expect(printRules).toMatch(/img\)\s*\{[^}]*max-width:\s*100%/);
    expect(printRules).toMatch(/table\)\s*\{[^}]*max-width:\s*100%/);
    expect(printRules).toMatch(/table-layout:\s*fixed/);
    // Строку таблицы делить между листами нельзя
    expect(printRules).toMatch(/tr\)\s*\{[^}]*break-inside:\s*avoid/);
    /*
     * Перенос в ячейках — по словам. С `anywhere` браузер считает разрыв
     * внутри слова допустимым уже при расчёте минимальной ширины колонки,
     * и на распечатанной накладной «Позиция 1» встало как «Позици/я 1».
     */
    expect(printRules).not.toMatch(/th\)\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('не рвут строку и не отрывают шапку от текста', () => {
    expect(printRules).toMatch(/orphans:\s*\d/);
    expect(printRules).toMatch(/widows:\s*\d/);
    expect(printRules).toMatch(/\.printHead\s*\{[^}]*break-after:\s*avoid/);
  });

  it('раскрывают адреса ссылок', () => {
    expect(printRules).toContain(`a[${PRINT_HREF_ATTR}])::after`);
    expect(printRules).toMatch(new RegExp(`content:[^;]*attr\\(${PRINT_HREF_ATTR}\\)`));
  });
});

describe('адреса ссылок на бумаге', () => {
  it('раскрываются, когда текст ссылки адреса не показывает', () => {
    expect(printableHref('здесь', 'https://example.com/a/b?id=42')).toBe(
      'https://example.com/a/b?id=42',
    );
    expect(printableHref('', 'https://example.com/banner')).toBe('https://example.com/banner');
  });

  it('не дублируются, когда адрес и так виден в тексте', () => {
    expect(printableHref('example.com', 'https://example.com')).toBeNull();
    expect(printableHref('https://example.com/', 'https://example.com')).toBeNull();
    expect(printableHref('www.example.com', 'https://example.com')).toBeNull();
    expect(printableHref('Сайт: example.com/цены', 'https://example.com/цены')).toBeNull();
  });

  it('не появляются там, где на бумаге бессмысленны', () => {
    expect(printableHref('Иван Петров', 'mailto:ivan@mail.local')).toBeNull();
    expect(printableHref('Позвонить', 'tel:+79990000000')).toBeNull();
    expect(printableHref('Наверх', '#top')).toBeNull();
    expect(printableHref('Картинка', 'cid:logo@x')).toBeNull();
    expect(printableHref('Действие', 'javascript:void(0)')).toBeNull();
    expect(printableHref('Пусто', '')).toBeNull();
  });

  it('размечаются прямо в теле письма', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(serverMessage());
    render();
    await waitFor(() => Boolean(host.querySelector(`a[${PRINT_HREF_ATTR}]`)), 'размеченную ссылку');
    expect(host.querySelector(`a[${PRINT_HREF_ATTR}]`)?.getAttribute(PRINT_HREF_ATTR)).toBe(
      'https://example.com/very/long/path?id=42',
    );
  });

  it('разметка снимается со ссылок, которым адрес не нужен', () => {
    const root_ = document.createElement('div');
    root_.innerHTML = '<a href="mailto:a@b.ru">a@b.ru</a><a href="https://example.com/x">тут</a>';
    expect(annotatePrintLinks(root_)).toBe(1);
    expect(root_.querySelector('a[href^="mailto"]')?.hasAttribute(PRINT_HREF_ATTR)).toBe(false);
  });
});

describe('подписи на листе', () => {
  it('адресаты перечисляются полностью, а пустой список — прочерком', () => {
    expect(printAddresses([{ name: 'Ирина', address: 'i@m.ru' }])).toBe('Ирина <i@m.ru>');
    expect(printAddresses([])).toBe('—');
  });

  it('дата печатается полностью, без «вчера» и голого времени', () => {
    const shown = printDate('2026-08-04T09:15:00.000Z');
    expect(shown).toMatch(/2026/);
    expect(shown).not.toMatch(/вчера|сегодня/i);
  });
});
