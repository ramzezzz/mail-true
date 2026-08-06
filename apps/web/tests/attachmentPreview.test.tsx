// @vitest-environment jsdom
/**
 * Предпросмотр вложения и сохранение письма файлом .eml.
 *
 * Дефект (пункт 12 в docs/gaps.md): вложение можно было только скачать.
 * Чтобы понять, тот ли это акт, человек скачивал файл, открывал сторонней
 * программой, закрывал и удалял из «Загрузок».
 *
 * Главное, что здесь закреплено, — не удобство, а безопасность. Вложение
 * приходит от кого угодно, и показ не должен давать чужому файлу ни доступа
 * к странице почты, ни к сессионной куке:
 *
 *   - у картинки и PDF в `src` стоит blob-адрес, а НЕ маршрут выдачи части
 *     письма: маршрут отвечает `attachment` + `frame-ancestors 'none'`, и
 *     предпросмотр этого не ослабляет;
 *   - SVG и HTML не показываются вовсе, и человеку сказано почему;
 *   - текст выводится текстовым узлом: `<script>` остаётся буквами;
 *   - файл, назвавшийся PDF-ом, но им не являющийся, до просмотрщика не
 *     доходит.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttachmentInfo } from '@mail-true/shared';
import { api } from '../src/api';
import type { MessageFull } from '../src/api/types';
import {
  PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  canPreview,
  decidePreview,
  decodeTextPart,
  looksLikePdf,
} from '../src/mail/attachments';
import { MessagePage } from '../src/pages/MessagePage';

/*
 * jsdom не реализует `Blob.arrayBuffer()` — в браузерах он есть везде уже
 * лет семь. Без этой дописки предпросмотр в проверках падал бы не по своей
 * вине («Нет связи с сервером» на месте картинки), и проверять было бы
 * нечего. Дописка живёт здесь, а не в коде приложения: чинить браузерный
 * пробел тестовой среды за счёт продукта незачем.
 */
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function readAll(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('не прочитали blob'));
      reader.readAsArrayBuffer(this);
    });
  };
}

/* ------------------------------------------------------------------ */
/* Правило показа — без разметки и запросов                            */
/* ------------------------------------------------------------------ */

const att = (over: Partial<AttachmentInfo>): AttachmentInfo => ({
  partId: '2',
  filename: 'file.bin',
  mimeType: 'application/octet-stream',
  size: 1000,
  contentId: null,
  inline: false,
  ...over,
});

describe('что можно показывать', () => {
  it('растровые картинки, PDF и простой текст — можно', () => {
    expect(decidePreview(att({ filename: 'a.png', mimeType: 'image/png' })).kind).toBe('image');
    expect(decidePreview(att({ filename: 'a.jpg', mimeType: 'image/jpeg' })).kind).toBe('image');
    expect(decidePreview(att({ filename: 'a.pdf', mimeType: 'application/pdf' })).kind).toBe('pdf');
    expect(decidePreview(att({ filename: 'a.txt', mimeType: 'text/plain' })).kind).toBe('text');
  });

  it('SVG не показывается — это документ со скриптами, а не картинка', () => {
    const verdict = decidePreview(att({ filename: 'logo.svg', mimeType: 'image/svg+xml' }));
    expect(verdict.kind).toBeNull();
    expect(verdict.kind === null && verdict.reason).toMatch(/SVG/u);
  });

  it('имя файла не отменяет заявленный тип-документ', () => {
    // Классическая попытка: назвать SVG картинкой. Тип проверяется первым.
    const verdict = decidePreview(att({ filename: 'photo.png', mimeType: 'image/svg+xml' }));
    expect(verdict.kind).toBeNull();
  });

  it('HTML и XML тоже только скачиваются', () => {
    for (const mimeType of ['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']) {
      expect(decidePreview(att({ filename: 'x.dat', mimeType })).kind).toBeNull();
    }
  });

  it('у безликого типа решает расширение — но только в сторону разрешённого', () => {
    // Половина отправителей помечает всё application/octet-stream
    expect(decidePreview(att({ filename: 'akt.pdf' })).kind).toBe('pdf');
    expect(decidePreview(att({ filename: 'skan.jpg' })).kind).toBe('image');
    expect(decidePreview(att({ filename: 'zametki.txt' })).kind).toBe('text');
    // …и никогда в сторону запрещённого
    expect(decidePreview(att({ filename: 'logo.svg' })).kind).toBeNull();
    expect(decidePreview(att({ filename: 'page.html' })).kind).toBeNull();
  });

  it('офисные документы и архивы — только скачать, и об этом сказано прямо', () => {
    const verdict = decidePreview(
      att({
        filename: 'Отчёт.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    expect(verdict.kind).toBeNull();
    expect(verdict.kind === null && verdict.reason).toMatch(/скачать/u);
    expect(canPreview(att({ filename: 'arhiv.zip', mimeType: 'application/zip' }))).toBe(false);
  });
});

describe('предел размера', () => {
  it('большая картинка не показывается, и в отказе назван предел', () => {
    const verdict = decidePreview(
      att({ filename: 'foto.jpg', mimeType: 'image/jpeg', size: PREVIEW_MAX_BYTES + 1 }),
    );
    expect(verdict.kind).toBeNull();
    // Число «сколько» и число «сколько можно» — оба, иначе отказ непонятен
    expect(verdict.kind === null && verdict.reason).toMatch(/слишком велик/u);
    expect(verdict.kind === null && verdict.reason).toMatch(/10 МБ/u);
  });

  it('у текста предел строже: одним узлом десять мегабайт не показать', () => {
    expect(TEXT_PREVIEW_MAX_BYTES).toBeLessThan(PREVIEW_MAX_BYTES);
    const verdict = decidePreview(
      att({ filename: 'log.txt', mimeType: 'text/plain', size: TEXT_PREVIEW_MAX_BYTES + 1 }),
    );
    expect(verdict.kind).toBeNull();
  });

  it('ровно на пределе — ещё показывается', () => {
    expect(
      decidePreview(att({ filename: 'foto.jpg', mimeType: 'image/jpeg', size: PREVIEW_MAX_BYTES }))
        .kind,
    ).toBe('image');
  });

  it('у слишком большого снимка «глаз» остаётся: отказ объясняется словами', () => {
    // Иначе снимок на 11 МБ выглядел бы как файл, который посмотреть нельзя
    // в принципе, и человек не узнал бы, что дело в размере.
    const big = att({ filename: 'foto.jpg', mimeType: 'image/jpeg', size: PREVIEW_MAX_BYTES + 1 });
    expect(canPreview(big)).toBe(true);
    expect(decidePreview(big).kind).toBeNull();
  });

  it('пустая часть — это не «нечего показать», а сорванная загрузка', () => {
    const verdict = decidePreview(att({ filename: 'a.png', mimeType: 'image/png', size: 0 }));
    expect(verdict.kind).toBeNull();
    expect(verdict.kind === null && verdict.reason).toMatch(/ни одного байта/u);
  });
});

describe('байты, а не заявления', () => {
  it('PDF узнаётся по заголовку %PDF-', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.4\n1 0 obj'))).toBe(true);
    // Стандарт допускает мусор перед заголовком — ищем в первом килобайте
    expect(looksLikePdf(new TextEncoder().encode(`${' '.repeat(300)}%PDF-1.7`))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBe(false);
    expect(looksLikePdf(new Uint8Array(64))).toBe(false);
  });

  it('текст читается UTF-8, а не в UTF-8 — windows-1251', () => {
    const utf8 = new TextEncoder().encode('Акт сверки');
    expect(decodeTextPart(utf8)).toEqual({ text: 'Акт сверки', charset: 'UTF-8' });
    // «Акт» в windows-1251 — байты, которые UTF-8 не является
    const cp1251 = new Uint8Array([0xc0, 0xea, 0xf2]);
    const decoded = decodeTextPart(cp1251);
    expect(decoded.charset).toBe('windows-1251');
    expect(decoded.text).toBe('Акт');
  });
});

/* ------------------------------------------------------------------ */
/* Окно предпросмотра                                                   */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;
let createdBlobs: Blob[];

function messageWith(attachments: AttachmentInfo[]): MessageFull {
  return {
    id: 'inbox:209',
    folderId: 'inbox',
    uid: 209,
    threadId: 't-209',
    from: { name: 'Анна', address: 'anna@example.com' },
    to: [{ name: null, address: 'test@mail.local' }],
    cc: [],
    subject: 'Акт сверки',
    snippet: 'текст',
    date: new Date('2026-07-31T09:15:00Z').toISOString(),
    flags: {
      seen: true,
      flagged: false,
      answered: false,
      forwarded: false,
      draft: false,
      deleted: false,
    },
    hasAttachments: attachments.length > 0,
    attachmentNames: attachments.map((a) => a.filename),
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
    attachments,
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
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`не дождались: ${what}\n${document.body.textContent ?? ''}`);
}

const click = (element: Element | null | undefined) => {
  if (!element) throw new Error('нечего нажимать');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
};

/** Карточка вложения, на которую нажимают, — по подсказке. */
const tile = (starts: string): HTMLElement | undefined =>
  [...document.querySelectorAll('button, a')].find((el) =>
    (el.getAttribute('title') ?? '').startsWith(starts),
  ) as HTMLElement | undefined;

const stage = (): HTMLElement | null => document.querySelector('[data-testid="attachment-preview"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  createdBlobs = [];
  // jsdom не умеет blob-адреса: подменяем и заодно запоминаем, что именно
  // положили в blob — тип берётся из НАШЕГО списка, а не из письма.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      createdBlobs.push(blob);
      return `blob:mock/${String(createdBlobs.length)}`;
    },
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(api, 'setFlags').mockResolvedValue({ updated: 1 });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('картинка', () => {
  it('открывается в окне, а не скачивается, и показывается из blob-адреса', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      messageWith([att({ partId: '2', filename: 'skan.png', mimeType: 'image/png', size: 8 })]),
    );
    const getPart = vi
      .spyOn(api, 'getMessagePart')
      .mockResolvedValue(new Blob([png], { type: 'application/octet-stream' }));

    render();
    await waitFor(() => Boolean(tile('Посмотреть skan.png')), 'карточку вложения');
    click(tile('Посмотреть skan.png'));
    await waitFor(() => Boolean(stage()?.querySelector('img')), 'картинку в окне');

    const img = stage()!.querySelector('img')!;
    // Ключевое: адрес — blob, а не маршрут выдачи части письма
    expect(img.getAttribute('src')).toMatch(/^blob:/u);
    expect(img.getAttribute('src')).not.toContain('/api/');
    expect(getPart).toHaveBeenCalledWith('inbox:209', '2');
    // Тип blob-а — наш, из разрешительного списка
    expect(createdBlobs[0]?.type).toBe('image/png');
  });
});

describe('PDF', () => {
  it('показывается рамкой со встроенным просмотрщиком по blob-адресу', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n');
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      messageWith([
        att({ partId: '3', filename: 'akt.pdf', mimeType: 'application/pdf', size: pdf.length }),
      ]),
    );
    vi.spyOn(api, 'getMessagePart').mockResolvedValue(new Blob([pdf]));

    render();
    await waitFor(() => Boolean(tile('Посмотреть akt.pdf')), 'карточку вложения');
    click(tile('Посмотреть akt.pdf'));
    await waitFor(() => Boolean(stage()?.querySelector('iframe')), 'рамку просмотрщика');

    const frame = stage()!.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toMatch(/^blob:/u);
    expect(frame.getAttribute('src')).not.toContain('/api/');
    expect(createdBlobs[0]?.type).toBe('application/pdf');
  });

  it('файл, назвавшийся PDF-ом, но им не являющийся, до просмотрщика не доходит', async () => {
    const html = new TextEncoder().encode('<html><script>window.__mtPwned=1</script>');
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      messageWith([
        att({ partId: '3', filename: 'akt.pdf', mimeType: 'application/pdf', size: html.length }),
      ]),
    );
    vi.spyOn(api, 'getMessagePart').mockResolvedValue(new Blob([html]));

    render();
    await waitFor(() => Boolean(tile('Посмотреть akt.pdf')), 'карточку вложения');
    click(tile('Посмотреть akt.pdf'));
    await waitFor(
      () => Boolean(document.querySelector('[data-testid="attachment-preview-refused"]')),
      'отказ показать',
    );

    expect(stage()!.querySelector('iframe')).toBeNull();
    expect(createdBlobs).toHaveLength(0);
    expect(document.querySelector('[data-testid="attachment-preview-refused"]')?.textContent).toMatch(
      /не PDF/u,
    );
  });
});

describe('текст', () => {
  it('показывается текстовым узлом — <script> внутри остаётся буквами', async () => {
    const text = new TextEncoder().encode('строка\n<script>window.__mtPwned = true;</script>\n');
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      messageWith([
        att({ partId: '2', filename: 'zametki.txt', mimeType: 'text/plain', size: text.length }),
      ]),
    );
    vi.spyOn(api, 'getMessagePart').mockResolvedValue(new Blob([text]));

    render();
    await waitFor(() => Boolean(tile('Посмотреть zametki.txt')), 'карточку вложения');
    click(tile('Посмотреть zametki.txt'));
    await waitFor(
      () => Boolean(document.querySelector('[data-testid="attachment-preview-text"]')),
      'текст вложения',
    );

    const pre = document.querySelector('[data-testid="attachment-preview-text"]')!;
    expect(pre.querySelector('script')).toBeNull();
    expect(pre.children.length).toBe(0);
    expect(pre.textContent).toContain('<script>window.__mtPwned = true;</script>');
    expect((window as { __mtPwned?: boolean }).__mtPwned).toBeUndefined();
  });
});

describe('чего показать нельзя', () => {
  it('у таблицы нет кнопки просмотра — карточка по-прежнему скачивает', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      messageWith([
        att({
          partId: '2',
          filename: 'Отчёт.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 4096,
        }),
      ]),
    );
    render();
    await waitFor(() => Boolean(tile('Скачать Отчёт.xlsx')), 'карточку вложения');

    // Кнопки «посмотреть» нет вовсе: кнопка появляется вместе с поведением
    expect(tile('Посмотреть Отчёт.xlsx')).toBeUndefined();
    const card = tile('Скачать Отчёт.xlsx')!;
    expect(card.tagName).toBe('A');
    expect(card.getAttribute('href')).toBe('/api/messages/inbox%3A209/parts/2');
    expect(card.hasAttribute('download')).toBe(true);
  });

  it('у SVG предпросмотра нет — и это осознанный отказ, а не пробел', () => {
    expect(canPreview(att({ filename: 'logo.svg', mimeType: 'image/svg+xml' }))).toBe(false);
  });
});

describe('скачивание есть всегда', () => {
  it('рядом с просмотром стоит отдельная кнопка скачивания', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(
      messageWith([att({ partId: '2', filename: 'skan.png', mimeType: 'image/png', size: 8 })]),
    );
    render();
    await waitFor(() => Boolean(tile('Посмотреть skan.png')), 'карточку вложения');

    const download = [...document.querySelectorAll('a')].find(
      (a) => a.getAttribute('aria-label') === 'Скачать skan.png',
    );
    expect(download, 'кнопки скачивания рядом с просмотром нет').toBeTruthy();
    expect(download!.getAttribute('href')).toBe('/api/messages/inbox%3A209/parts/2');
    expect(download!.hasAttribute('download')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Письмо файлом .eml                                                   */
/* ------------------------------------------------------------------ */

describe('сохранить письмо как .eml', () => {
  it('пункт есть в меню «три точки» и скачивает исходник письма', async () => {
    vi.spyOn(api, 'getMessage').mockResolvedValue(messageWith([]));
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });

    render();
    await waitFor(
      () => Boolean(document.querySelector('[aria-label="Ещё действия"]')),
      'страницу письма',
    );
    click(document.querySelector('[aria-label="Ещё действия"]'));

    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (b) => b.textContent?.trim() === 'Сохранить письмо (.eml)',
    );
    expect(item, 'пункта «Сохранить письмо (.eml)» нет в меню').toBeTruthy();
    click(item);

    // Скачивается ИСХОДНИК с сервера, а не собранное в браузере: файл .eml
    // должен быть побайтно тем, что прислали, иначе по нему не проверить DKIM
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.href).toBe('/api/messages/inbox%3A209/source');
    // Имя даёт сервер заголовком Content-Disposition (тема и дата письма)
    expect(clicked[0]?.download).toBe('');
  });
});
