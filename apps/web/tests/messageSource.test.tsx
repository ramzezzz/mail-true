// @vitest-environment jsdom
/**
 * «Исходный текст письма» — письмо целиком со всеми заголовками.
 *
 * Дефект: маршрут `GET /api/messages/:id/source` на сервере был, а в
 * интерфейсе его не вызывал никто — пункта в меню письма не существовало.
 * Посмотреть заголовки (путь письма, подпись DKIM, настоящего отправителя)
 * было нельзя ничем.
 *
 * Отдельно проверяется главное свойство этого окна: исходник — ТЕКСТ. Его
 * открывают как раз тогда, когда письму не доверяют, и выполниться в
 * интерфейсе он не должен ни при каких условиях.
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
import { foldMessageSource } from '../src/lib/messageSource';
import { MessagePage } from '../src/pages/MessagePage';

let host: HTMLDivElement;
let root: Root;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

const HEADERS =
  'Return-Path: <news@example.com>\r\n' +
  'Received: from mx.example.com by mail.local; Mon, 6 Jul 2026 12:00:00 +0300\r\n' +
  'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=mail;\r\n' +
  'From: "Рассылка" <news@example.com>\r\n' +
  'Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=\r\n';

function messageFull(): MessageFull {
  return {
    id: 'inbox:209',
    folderId: 'inbox',
    uid: 209,
    threadId: 't-209',
    from: { name: 'Рассылка', address: 'news@example.com' },
    to: [{ name: null, address: 'test@mail.local' }],
    cc: [],
    subject: 'Привет',
    snippet: 'текст',
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
    sizeBytes: 2048,
    messageId: '<x@example.com>',
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: '<p>тело</p>',
    bodyText: 'тело',
    attachments: [],
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    blockedRemote: 0,
  };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox/inbox%3A209']}>
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
  throw new Error(`не дождались: ${what}\n${document.body.textContent}`);
}

const click = (element: Element | null | undefined) => {
  if (!element) throw new Error('нечего нажимать');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};

/** Кнопка или пункт меню по подписи — окно рисуется в теле документа. */
const byText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll('button, [role="menuitem"]')].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLElement | undefined;

/** Открывает меню «три точки» и жмёт пункт исходника. */
async function openSource() {
  render();
  await waitFor(() => Boolean(document.querySelector('[aria-label="Ещё действия"]')), 'страницу письма');
  click(document.querySelector('[aria-label="Ещё действия"]'));
  await waitFor(() => Boolean(byText('Исходный текст письма')), 'пункт меню');
  click(byText('Исходный текст письма'));
  await waitFor(
    () => Boolean(document.querySelector('[data-testid="message-source"]')),
    'окно исходника',
  );
}

const sourceEl = (): HTMLElement | null =>
  document.querySelector('[data-testid="message-source"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'getMessage').mockResolvedValue(messageFull());
  vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('пункт меню и содержимое окна', () => {
  it('пункт есть в меню «три точки» и открывает заголовки письма', async () => {
    vi.spyOn(api, 'getMessageSource').mockResolvedValue(`${HEADERS}\r\nтело письма\r\n`);
    await openSource();

    const text = sourceEl()?.textContent ?? '';
    // Ради этих трёх строк исходник и открывают
    expect(text).toContain('Received: from mx.example.com');
    expect(text).toContain('DKIM-Signature');
    expect(text).toContain('Return-Path: <news@example.com>');
  });

  it('текст моноширинный и с сохранением переносов', () => {
    // Стили читаем из файла: CSS-модули в проверках не применяются, а
    // склеенный в одну строку заголовок перестаёт быть заголовком —
    // выравнивание и границы строк здесь несут смысл
    const css = readFileSync(join(SRC, 'mail/MessageSource.module.css'), 'utf8');
    const at = css.indexOf('\n.source {');
    expect(at, 'в CSS нет правила .source').toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).toMatch(/white-space:\s*pre-wrap/u);
    expect(body).toMatch(/font-family:[^;]*mono/u);
    // Своя прокрутка: письмо в тысячи строк не должно растить окно так,
    // что до кнопок уже не добраться
    expect(body).toMatch(/overflow:\s*auto/u);
  });

  it('рядом есть «Скачать .eml» — ссылкой на тот же маршрут', async () => {
    vi.spyOn(api, 'getMessageSource').mockResolvedValue(HEADERS);
    await openSource();

    const link = [...document.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Скачать .eml'),
    );
    expect(link, 'кнопки скачивания нет').toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/api/messages/inbox%3A209/source');
    expect(link!.hasAttribute('download')).toBe(true);
  });

  it('текст можно скопировать целиком, и копируется ПОЛНЫЙ исходник', async () => {
    const raw = `${HEADERS}\r\n${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg=='.repeat(1)}\r\n`;
    vi.spyOn(api, 'getMessageSource').mockResolvedValue(raw);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await openSource();
    click(byText('Скопировать'));
    await waitFor(() => writeText.mock.calls.length > 0, 'копирование');
    expect(writeText.mock.calls[0]?.[0]).toBe(raw);
  });
});

describe('исходник не выполняется', () => {
  it('<script> и onerror из письма остаются буквами на экране', async () => {
    const nasty =
      `${HEADERS}\r\n` +
      '<script>window.__mtPwned = true;</script>\r\n' +
      '<img src=x onerror="window.__mtPwned = true">\r\n';
    vi.spyOn(api, 'getMessageSource').mockResolvedValue(nasty);
    await openSource();

    // Ни одного узла из письма в разметке нет — только текст
    expect(sourceEl()!.querySelector('script')).toBeNull();
    expect(sourceEl()!.querySelector('img')).toBeNull();
    expect(sourceEl()!.children.length).toBe(0);
    expect(sourceEl()!.textContent).toContain('<script>window.__mtPwned = true;</script>');
    expect(sourceEl()!.textContent).toContain('onerror=');
    expect((window as { __mtPwned?: boolean }).__mtPwned).toBeUndefined();
  });
});

describe('длинные письма не вешают браузер', () => {
  it('полоса base64 сворачивается, а заголовки остаются целиком', () => {
    const attachment = Array.from({ length: 4000 }, () => 'A'.repeat(76)).join('\n');
    const folded = foldMessageSource(`${HEADERS.replace(/\r\n/gu, '\n')}\n${attachment}\n`);

    expect(folded.text).toContain('DKIM-Signature');
    expect(folded.text).toContain('Return-Path');
    expect(folded.foldedLines).toBeGreaterThan(3000);
    expect(folded.text).toMatch(/свёрнуто \d+ строк содержимого вложения/u);
    // Именно ради этого всё и делается: строк на экране остаются десятки,
    // а не тысячи — иначе браузер на письме с фотографией задумывается
    expect(folded.text.split('\n').length).toBeLessThan(20);
  });

  it('короткая полоса base64 (подпись DKIM) не сворачивается', () => {
    const dkim = Array.from({ length: 4 }, () => 'B'.repeat(70)).join('\n');
    const folded = foldMessageSource(`${HEADERS.replace(/\r\n/gu, '\n')}\n${dkim}\n`);

    expect(folded.foldedLines).toBe(0);
    expect(folded.text).toContain('B'.repeat(70));
  });

  it('исходник в мегабайты обрезается с честной пометкой', () => {
    // Строки не похожи на base64 (есть пробелы) — свернуть их нечем,
    // остаётся только обрезать
    const huge = Array.from({ length: 20_000 }, (_, i) => `X-Trace-${i}: значение значение`).join('\n');
    const folded = foldMessageSource(huge);

    expect(folded.truncated).toBe(true);
    expect(folded.text).toContain('исходник обрезан');
    expect(folded.text).toContain('Скачать .eml');
    expect(folded.text.length).toBeLessThan(huge.length);
  });
});
