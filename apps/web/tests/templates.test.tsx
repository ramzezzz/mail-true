// @vitest-environment jsdom
/**
 * Шаблоны писем в интерфейсе.
 *
 * Три вещи проверяются здесь особенно, и каждая — обратным ходом:
 *
 *   1. вставка НЕ ЗАТИРАЕТ написанное. Это названо главным риском всей
 *      возможности (docs/gaps.md, «испортить можно — затереть написанное
 *      вставкой»), и проверяется тем, что после вставки в письме остаётся
 *      И набранный текст, И текст шаблона;
 *   2. кнопки «Шаблоны» нет вовсе, пока сервер не сказал, что возможность
 *      у него есть, — общее правило продукта;
 *   3. подстановка `{{имя}}` заполняется, только когда имя адресата
 *      известно; неизвестное не выдумывается из адреса и не стирается.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Account } from '@mail-true/shared';
import { api, settingsApi } from '../src/api';
import type { GeneralSettings } from '../src/api/settingsTypes';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { templatePreview, fileSizeText } from '../src/compose/TemplateMenu';
import { useUiStore } from '../src/app/store';
import {
  firstName,
  firstRecipient,
  moveTemplate,
  prepareTemplateBody,
  prepareTemplateSubject,
  substitutionFor,
  templatesApi,
  unresolvedPlaceholders,
  type MailTemplate,
  type SubstitutionContext,
} from '../src/mail/templatesApi';
import { TemplatesPage } from '../src/pages/settings/TemplatesPage';

/* ------------------------------------------------------------------ */
/* Подстановки — чистые функции                                        */
/* ------------------------------------------------------------------ */

const KNOWN: SubstitutionContext = {
  recipientName: 'Пётр Волков',
  recipientAddress: 'petr@mail.local',
  ownName: 'Тест Тестович',
};

const ANONYMOUS: SubstitutionContext = {
  recipientName: null,
  recipientAddress: 'info@mail.local',
  ownName: 'Тест Тестович',
};

const NOBODY: SubstitutionContext = {
  recipientName: null,
  recipientAddress: null,
  ownName: null,
};

describe('подстановка имени адресата', () => {
  it('обращается по имени, а не по имени и фамилии', () => {
    // «Здравствуйте, Пётр Волков!» звучит как письмо из банка
    expect(firstName('Пётр Волков')).toBe('Пётр');
    expect(substitutionFor('имя', KNOWN)).toBe('Пётр');
    expect(substitutionFor('адрес', KNOWN)).toBe('petr@mail.local');
    expect(substitutionFor('моё имя', KNOWN)).toBe('Тест Тестович');
  });

  it('неизвестное имя НЕ выдумывается из адреса', () => {
    /*
     * Обратный ход к главной ошибке этой возможности: из `info@mail.local`
     * получилось бы «Здравствуйте, info!», а из пустой строки —
     * «Здравствуйте, !». Обе хуже, чем оставленная подстановка.
     */
    expect(substitutionFor('имя', ANONYMOUS)).toBeNull();
    expect(prepareTemplateBody('<p>Здравствуйте, {{имя}}!</p>', ANONYMOUS)).toBe(
      '<p>Здравствуйте, {{имя}}!</p>',
    );
    // Зато «адресат» знает запасной ответ — адрес
    expect(substitutionFor('адресат', ANONYMOUS)).toBe('info@mail.local');
  });

  it('незнакомая подстановка остаётся в тексте как напоминание', () => {
    // `{{номер договора}}` человек написал себе сам — стирать нельзя
    const html = prepareTemplateBody('<p>Договор {{номер договора}}</p>', KNOWN);
    expect(html).toContain('{{номер договора}}');
  });

  it('имя адресата экранируется — оно попадает в разметку письма', () => {
    const evil: SubstitutionContext = {
      recipientName: '<b onmouseover="alert(1)">Пётр',
      recipientAddress: 'p@mail.local',
      ownName: null,
    };
    const html = prepareTemplateBody('<p>Привет, {{адресат}}!</p>', evil);
    expect(html).not.toContain('<b ');
    expect(html).toContain('&lt;b');
  });

  it('в теме подстановки работают так же', () => {
    expect(prepareTemplateSubject('Ответ для {{имя}}', KNOWN)).toBe('Ответ для Пётр');
    expect(prepareTemplateSubject('Ответ для {{имя}}', NOBODY)).toBe('Ответ для {{имя}}');
  });

  it('незаполненные подстановки перечисляются поимённо', () => {
    const left = unresolvedPlaceholders('<p>Здравствуйте, {{имя}}! Договор {{номер}}.</p>');
    expect(left).toEqual(['{{имя}}', '{{номер}}']);
    expect(unresolvedPlaceholders('<p>Здравствуйте, Пётр!</p>')).toEqual([]);
  });
});

describe('первый получатель из поля «Кому»', () => {
  it('берёт имя из «Имя <адрес>»', () => {
    expect(firstRecipient('Пётр Волков <petr@mail.local>')).toEqual({
      name: 'Пётр Волков',
      address: 'petr@mail.local',
    });
  });

  it('берёт ПЕРВОГО из нескольких — остальным письмо тоже уйдёт', () => {
    const first = firstRecipient('Пётр Волков <petr@mail.local>, anna@mail.local');
    expect(first.name).toBe('Пётр Волков');
  });

  it('у голого адреса имени нет', () => {
    expect(firstRecipient('petr@mail.local')).toEqual({ name: null, address: 'petr@mail.local' });
    expect(firstRecipient('')).toEqual({ name: null, address: null });
  });
});

describe('порядок шаблонов', () => {
  const list = (names: string[]): MailTemplate[] =>
    names.map((name, index) => ({
      id: index + 1,
      name,
      subject: '',
      bodyHtml: '',
      position: index,
      attachments: [],
    }));

  it('стрелка меняет местами соседей, а на краю ничего не делает', () => {
    const items = list(['А', 'Б', 'В']);
    // Идентификаторы у списка — 1, 2, 3 по порядку: поднимаем «В»
    expect(moveTemplate(items, 3, 'up').map((t) => t.name)).toEqual(['А', 'В', 'Б']);
    expect(moveTemplate(items, 1, 'up').map((t) => t.name)).toEqual(['А', 'Б', 'В']);
    expect(moveTemplate(items, 3, 'down').map((t) => t.name)).toEqual(['А', 'Б', 'В']);
  });
});

describe('выжимка шаблона для меню', () => {
  it('снимает разметку и режет по длине', () => {
    expect(templatePreview('<div>Здравствуйте!<br>Ваш заказ готов.</div>')).toBe(
      'Здравствуйте! Ваш заказ готов.',
    );
    expect(templatePreview('<p>' + 'а'.repeat(200) + '</p>', 20)).toHaveLength(21);
  });

  it('размер вложения пишется по-человечески', () => {
    expect(fileSizeText(240 * 1024)).toBe('240 КБ');
    expect(fileSizeText(2 * 1024 * 1024)).toBe('2,0 МБ');
  });
});

/* ------------------------------------------------------------------ */
/* Показ                                                               */
/* ------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;

const serverAccount: Account = {
  id: 'test@mail.local',
  email: 'test@mail.local',
  displayName: 'Тест Тестович',
  avatarUrl: null,
  quotaUsedBytes: 0,
  quotaLimitBytes: 1_073_741_824,
  signature: '',
  createdAt: '2026-08-05T01:56:56.454Z',
};

const serverSettings: GeneralSettings = {
  senderName: 'Тест Тестович',
  signatures: [],
  defaultSignatureId: null,
  autoReply: { enabled: false, text: '', from: null, to: null },
  notifications: { browser: false, tabCounter: true },
  quoteOriginalOnReply: true,
  afterDelete: 'list',
  autoCollectContacts: true,
};

const GREETING: MailTemplate = {
  id: 7,
  name: 'Ответ о сроках',
  subject: 'О сроках поставки',
  bodyHtml: '<div>Здравствуйте, {{имя}}! Срок — две недели.</div>',
  position: 0,
  attachments: [],
};

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
  throw new Error(`не дождались: ${what}\n${host.innerHTML}`);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

/**
 * Кнопка ВНУТРИ модального окна.
 *
 * Нужна отдельно: «Сохранить» есть и в нижней панели письма (черновик), и
 * в окне «Сохранить как шаблон». Поиск по всей странице находил первую и
 * сохранял черновик вместо шаблона — то же самое сделал бы и человек,
 * если бы кнопки стояли рядом, но они не стоят.
 */
const dialogButton = (label: string) => {
  const dialog = host.querySelector('[role="dialog"]');
  return [...(dialog?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent?.includes(label),
  );
};

const click = (el: Element) =>
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

const editor = () => host.querySelector('[aria-label="Текст письма"]') as HTMLElement | null;
const draft = () => useUiStore.getState().composeWindows[0]?.draft;

/**
 * `document.execCommand` в jsdom нет вовсе, а именно им окно написания
 * вставляет шаблон в позицию курсора. Подменяем НАСТОЯЩЕЙ вставкой в
 * выделение (Range/Selection в jsdom есть) — заглушка, которая просто
 * пишет в журнал вызовов, не доказала бы главного: что написанное
 * осталось на месте.
 */
function installInsertHtml(): void {
  (document as unknown as { execCommand: unknown }).execCommand = (
    command: string,
    _ui?: boolean,
    value?: string,
  ): boolean => {
    if (command !== 'insertHTML' || typeof value !== 'string') return true;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return true;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(range.createContextualFragment(value));
    return true;
  };
}

/** Ставит курсор в конец набранного текста — как после набора с клавиатуры. */
function caretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUiStore.setState({ composeWindows: [] });
  installInsertHtml();
  vi.spyOn(api, 'getAccount').mockResolvedValue(serverAccount);
  vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue(serverSettings);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [] });
  vi.restoreAllMocks();
});

/** Открывает окно написания и дожидается редактора. */
async function openCompose(init: { to?: string; subject?: string } = {}) {
  render(<ComposeWindows />);
  act(() => useUiStore.getState().openCompose(init));
  await waitFor(() => editor() !== null, 'редактор письма');
  // Курсор в письме — как у человека, который только что щёлкнул в тело.
  // Без него вставка «в позицию курсора» проверялась бы в пустоте.
  caretAtEnd(editor()!);
}

describe('кнопка появляется вместе с поведением', () => {
  it('сервер не отдал шаблоны — кнопки «Шаблоны» в окне нет вовсе', async () => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: false,
      reason: 'Таблиц шаблонов писем нет',
      items: [],
    });
    await openCompose();
    // Даём запросу разрешиться, чтобы проверка не поймала «ещё не приехало»
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(button('Шаблоны')).toBeUndefined();
  });

  it('сервер отдал возможность — кнопка есть, даже когда шаблонов ноль', async () => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: true,
      reason: null,
      items: [],
    });
    await openCompose();
    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');
    click(button('Шаблоны')!);
    // Пустое меню объясняет, как завести первый шаблон, а не молчит
    expect(host.textContent).toContain('Сохранить как шаблон');
  });
});

describe('вставка шаблона', () => {
  beforeEach(() => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: true,
      reason: null,
      items: [GREETING],
    });
  });

  it('не затирает написанное и подставляет имя адресата', async () => {
    await openCompose({ to: 'Пётр Волков <petr@mail.local>' });
    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');

    // Человек уже что-то написал — вот это и не должно пропасть
    const area = editor()!;
    act(() => {
      area.innerHTML = '<div>Мой текст</div>';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(draft()?.bodyHtml).toContain('Мой текст');
    caretAtEnd(area);

    click(button('Шаблоны')!);
    await waitFor(() => Boolean(button('Ответ о сроках')), 'шаблон в меню');
    click(button('Ответ о сроках')!);
    await waitFor(() => (draft()?.bodyHtml ?? '').includes('две недели'), 'текст шаблона в письме');

    // ГЛАВНОЕ: набранное на месте, шаблон рядом, а не вместо него
    expect(draft()?.bodyHtml).toContain('Мой текст');
    // И имя адресата подставлено, а не осталось «{{имя}}»
    expect(draft()?.bodyHtml).toContain('Пётр');
    expect(draft()?.bodyHtml).not.toContain('{{имя}}');
  });

  it('пустую тему заполняет, а набранную не трогает', async () => {
    await openCompose({ to: 'petr@mail.local', subject: 'Своя тема' });
    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');
    click(button('Шаблоны')!);
    await waitFor(() => Boolean(button('Ответ о сроках')), 'шаблон в меню');
    click(button('Ответ о сроках')!);
    await waitFor(() => (draft()?.bodyHtml ?? '').includes('две недели'), 'текст шаблона');

    // Молча заменить набранную тему значило бы отправить письмо под чужим
    // заголовком — и заметить это можно было бы только в «Отправленных»
    expect(draft()?.subject).toBe('Своя тема');
  });

  it('вложения шаблона докладываются в письмо отдельным запросом', async () => {
    const withFile: MailTemplate = {
      ...GREETING,
      attachments: [{ id: 1, filename: 'прайс.pdf', mimeType: 'application/pdf', size: 2048 }],
    };
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: true,
      reason: null,
      items: [withFile],
    });
    const materialize = vi
      .spyOn(templatesApi, 'materializeAttachments')
      .mockResolvedValue({ attachments: [{ id: 'up-1', filename: 'прайс.pdf', size: 2048 }] });

    await openCompose({ to: 'petr@mail.local' });
    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');
    click(button('Шаблоны')!);
    await waitFor(() => Boolean(button('Ответ о сроках')), 'шаблон в меню');
    click(button('Ответ о сроках')!);

    await waitFor(() => (draft()?.attachments.length ?? 0) === 1, 'вложение шаблона в письме');
    expect(materialize).toHaveBeenCalledWith(withFile.id);
    expect(draft()?.attachments[0]?.filename).toBe('прайс.pdf');
  });

  it('шаблон без вложений лишнего запроса не делает', async () => {
    const materialize = vi.spyOn(templatesApi, 'materializeAttachments');
    await openCompose({ to: 'petr@mail.local' });
    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');
    click(button('Шаблоны')!);
    await waitFor(() => Boolean(button('Ответ о сроках')), 'шаблон в меню');
    click(button('Ответ о сроках')!);
    await waitFor(() => (draft()?.bodyHtml ?? '').includes('две недели'), 'текст шаблона');
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe('«Сохранить как шаблон»', () => {
  it('не берёт в шаблон подпись — иначе вставка положила бы её второй раз', async () => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: true,
      reason: null,
      items: [],
    });
    // Подпись есть и подставляется в письмо сама — как у всех
    vi.spyOn(settingsApi, 'getGeneral').mockResolvedValue({
      ...serverSettings,
      signatures: [{ id: '31', name: 'Рабочая', text: '—\nС уважением, Тест' }],
      defaultSignatureId: '31',
    });
    const create = vi.spyOn(templatesApi, 'createTemplate').mockResolvedValue({
      id: 1,
      name: 'Ответ',
      subject: '',
      bodyHtml: '',
      position: 0,
      attachments: [],
    });

    await openCompose({ subject: 'Про сроки' });
    await waitFor(
      () => (editor()?.textContent ?? '').includes('С уважением, Тест'),
      'подпись в письме',
    );
    const area = editor()!;
    act(() => {
      // Пишем поверх, не трогая блок подписи, — как человек с клавиатуры
      area.insertAdjacentHTML('afterbegin', '<div>Срок — две недели.</div>');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');
    click(button('Шаблоны')!);
    click(button('Сохранить как шаблон')!);
    await waitFor(() => Boolean(dialogButton('Сохранить')), 'окно сохранения');
    click(dialogButton('Сохранить')!);
    await waitFor(() => create.mock.calls.length === 1, 'запрос сохранения');

    const sent = create.mock.calls[0]?.[0];
    expect(sent?.bodyHtml).toContain('две недели');
    // ГЛАВНОЕ: подписи в шаблоне нет — её подставит само окно написания
    expect(sent?.bodyHtml).not.toContain('С уважением');
    // Название по умолчанию взято из темы письма
    expect(sent?.name).toBe('Про сроки');
    // Получатели в шаблон не уходят вовсе — такого поля в запросе нет
    expect(Object.keys(sent ?? {})).not.toContain('to');
  });
});

describe('незаполненная подстановка не уезжает молча', () => {
  it('первое нажатие «Отправить» останавливает и называет, что осталось', async () => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: true,
      reason: null,
      items: [GREETING],
    });
    const send = vi.spyOn(api, 'sendMessage');

    // Получатель есть, но имени его мы не знаем — подставлять нечего
    await openCompose({ to: 'info@mail.local' });
    await waitFor(() => Boolean(button('Шаблоны')), 'кнопка «Шаблоны»');
    click(button('Шаблоны')!);
    await waitFor(() => Boolean(button('Ответ о сроках')), 'шаблон в меню');
    click(button('Ответ о сроках')!);
    await waitFor(() => (draft()?.bodyHtml ?? '').includes('две недели'), 'текст шаблона');
    expect(draft()?.bodyHtml).toContain('{{имя}}');

    click(button('Отправить')!);
    await waitFor(() => host.textContent!.includes('{{имя}}'), 'предупреждение о подстановке');
    // Письмо НЕ ушло: «Здравствуйте, {{имя}}!» у получателя — это стыд
    expect(send).not.toHaveBeenCalled();
  });
});

describe('раздел настроек', () => {
  it('без возможности показывает причину, а не пустой список', async () => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: false,
      reason: 'Таблиц шаблонов писем нет. Примените миграцию.',
      items: [],
    });
    render(<TemplatesPage />);
    await waitFor(() => host.textContent!.includes('Примените миграцию'), 'причина отказа');
    // Кнопки заведения при этом нет: она бы всё равно отказала
    expect(button('Создать шаблон')).toBeUndefined();
  });

  it('показывает шаблон с темой, выжимкой и вложением', async () => {
    vi.spyOn(templatesApi, 'getTemplates').mockResolvedValue({
      available: true,
      reason: null,
      items: [
        {
          ...GREETING,
          attachments: [{ id: 1, filename: 'прайс.pdf', mimeType: 'application/pdf', size: 2048 }],
        },
      ],
    });
    render(<TemplatesPage />);
    await waitFor(() => host.textContent!.includes('Ответ о сроках'), 'строка шаблона');
    expect(host.textContent).toContain('О сроках поставки');
    expect(host.textContent).toContain('прайс.pdf');
    expect(button('Создать шаблон')).toBeDefined();
  });
});
