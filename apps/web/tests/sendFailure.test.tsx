// @vitest-environment jsdom
/**
 * «Письмо не отправлено» — как человек об этом узнаёт.
 *
 * Пока письмо уходило прямо в запросе, отказ почтового сервера был виден
 * сразу, в окне написания. Отмена отправки поставила между нажатием
 * и настоящей отправкой несколько секунд — и отказывать стало некому:
 * человек уже закрыл вкладку. Письмо ложилось в черновики МОЛЧА, и он
 * узнавал о нём от адресата вопросом «почему вы не ответили».
 *
 * Проверяется поэтому не «плашка нарисовалась», а то, что человек
 * действительно узнаёт: без открытых вкладок в момент отказа, без
 * разрешения на уведомления, не заходя в «Черновики», — и что, узнав,
 * он видит ПРИЧИНУ и КОМУ отказали, а не «что-то пошло не так».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeWindows } from '../src/compose/ComposeWindows';
import { failureSummary, formatAttemptedAt } from '../src/compose/SendFailureBanner';
import { publishMailEvent } from '../src/app/mailEvents';
import { useUiStore } from '../src/app/store';
import { api } from '../src/api';
import type { SendFailureNotice } from '../src/api/types';

let host: HTMLDivElement;
let root: Root;

function notice(patch: Partial<SendFailureNotice> = {}): SendFailureNotice {
  return {
    id: 'извещение-1',
    subject: 'Договор на подпись',
    envelopeTo: ['kolya@несуществующий.домен'],
    reason: 'Почтовый сервер отклонил получателей: kolya@несуществующий.домен',
    rejected: [{ address: 'kolya@несуществующий.домен', message: '550 User unknown' }],
    attempts: 5,
    lastAttemptAt: '2026-08-06T09:20:00.000Z',
    draftUid: 77,
    createdAt: '2026-08-06T09:20:01.000Z',
    ...patch,
  };
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

const click = (element: Element | null | undefined) => {
  if (!element) throw new Error('нечего нажимать');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

/** Даёт запросам react-query отработать до конца. */
async function settle(ms = 120): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
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
  useUiStore.setState({ composeWindows: [], notice: null });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUiStore.setState({ composeWindows: [], notice: null });
  vi.restoreAllMocks();
});

describe('человек узнаёт об отказе, не заходя в черновики', () => {
  it('плашка появляется при открытии почты, даже если в момент отказа вкладка была закрыта', async () => {
    // Список спрашивается у сервера при открытии — именно это и держит
    // обещание «узнает, даже если закрыл вкладку»
    const list = vi.spyOn(api, 'getSendFailures').mockResolvedValue([notice()]);
    render();

    await waitFor(() => host.textContent?.includes('Письмо не отправлено') ?? false, 'плашку');
    expect(list.mock.calls.length).toBeGreaterThan(0);
    // О каком именно письме речь
    expect(host.textContent).toContain('Договор на подпись');
    // …и почему оно не ушло, с адресом
    expect(host.textContent).toContain('kolya@несуществующий.домен');
  });

  it('показывается и когда ни одного окна написания не открыто', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([notice()]);
    render();
    await waitFor(() => host.textContent?.includes('Письмо не отправлено') ?? false, 'плашку');
    // Обратный ход: раньше весь этот узел вовсе не отрисовывался,
    // пока не открыто хоть одно окно написания, — то есть почти всегда
    expect(useUiStore.getState().composeWindows).toHaveLength(0);
  });

  it('без отказов на экране ничего не появляется', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(host.textContent).not.toContain('Письмо не отправлено');
  });
});

describe('открытая вкладка узнаёт сразу', () => {
  it('событие сокета показывает плашку, не дожидаясь перезагрузки страницы', async () => {
    const list = vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    render();
    // Ждём именно ответа первого запроса, а не самого запроса: подмена
    // ответа посреди незавершённого запроса проверяла бы не то
    await settle();
    expect(list.mock.calls.length).toBe(1);
    expect(host.textContent).not.toContain('Письмо не отправлено');

    // Сервер сдался прямо сейчас, вкладка открыта
    list.mockResolvedValue([notice()]);
    act(() =>
      publishMailEvent({
        type: 'send-failed',
        id: 'извещение-1',
        subject: 'Договор на подпись',
        reason: 'Почтовый сервер отклонил получателей',
        draftUid: 77,
      }),
    );

    await waitFor(
      () => host.textContent?.includes('Письмо не отправлено') ?? false,
      'плашку по событию сокета',
    );
  });

  it('чужие события сокета плашку не показывают', async () => {
    const list = vi.spyOn(api, 'getSendFailures').mockResolvedValue([]);
    render();
    await settle();
    const before = list.mock.calls.length;

    act(() =>
      publishMailEvent({
        type: 'new-message',
        folderId: 'inbox',
        id: 'inbox:1',
        uid: 1,
        from: null,
        subject: 'Обычное письмо',
        date: new Date().toISOString(),
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(list.mock.calls.length).toBe(before);
  });
});

describe('что с плашкой можно сделать', () => {
  it('«Открыть письмо» открывает тот самый черновик', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([notice({ draftUid: 77 })]);
    const getDraft = vi.spyOn(api, 'getDraft').mockResolvedValue({
      draftUid: 77,
      to: [{ name: null, address: 'kolya@несуществующий.домен' }],
      cc: [],
      bcc: [],
      subject: 'Договор на подпись',
      bodyHtml: '<p>текст</p>',
      attachments: [],
      inReplyTo: null,
      references: [],
      requestReadReceipt: false,
      sendFailure: {
        reason: 'Почтовый сервер отклонил получателей',
        rejected: [{ address: 'kolya@несуществующий.домен', message: '550 User unknown' }],
        attempts: 5,
        lastAttemptAt: '2026-08-06T09:20:00.000Z',
        envelopeTo: ['kolya@несуществующий.домен'],
      },
    });
    render();
    await waitFor(() => Boolean(buttonByText('Открыть письмо')), 'плашку');

    click(buttonByText('Открыть письмо'));
    await waitFor(() => getDraft.mock.calls.length > 0, 'запрос черновика');
    expect(getDraft.mock.calls[0]?.[0]).toBe(77);

    // Окно открылось, и в нём видна причина — человек этот черновик
    // не создавал и должен понять, откуда он взялся
    await waitFor(
      () => host.textContent?.includes('Письмо не отправлено.') ?? false,
      'полосу с причиной в окне написания',
    );
    // Слова самого почтового сервера видны: они говорят, что чинить —
    // опечатку в адресе или переполненный ящик получателя
    expect(host.textContent).toContain('550 User unknown');
  });

  it('«Понятно» убирает извещение на сервере, а не только с экрана', async () => {
    const list = vi.spyOn(api, 'getSendFailures').mockResolvedValue([notice()]);
    const ack = vi.spyOn(api, 'ackSendFailure').mockResolvedValue(undefined);
    render();
    await waitFor(() => Boolean(buttonByText('Понятно')), 'плашку');

    list.mockResolvedValue([]);
    click(buttonByText('Понятно'));
    await waitFor(() => ack.mock.calls.length > 0, 'запрос «прочитано»');
    // Убрать только с экрана было бы неправдой: при следующем открытии
    // почты извещение вернулось бы, и человек решил бы, что письмо
    // не отправилось второй раз
    expect(ack.mock.calls[0]?.[0]).toBe('извещение-1');
    await waitFor(
      () => !(host.textContent ?? '').includes('Письмо не отправлено'),
      'исчезновение плашки',
    );
  });

  it('о неотправленных письмах сверх первого тоже сказано', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([
      notice({ id: '1' }),
      notice({ id: '2', subject: 'Второе' }),
      notice({ id: '3', subject: 'Третье' }),
    ]);
    render();
    await waitFor(() => host.textContent?.includes('Письмо не отправлено') ?? false, 'плашку');
    // Молча показать одно из трёх — тот же дефект в меньшем масштабе
    expect(host.textContent).toContain('и ещё 2');
  });

  it('без черновика кнопки «Открыть письмо» нет, но извещение остаётся', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([notice({ draftUid: null })]);
    render();
    await waitFor(() => host.textContent?.includes('Письмо не отправлено') ?? false, 'плашку');
    // Черновик сохранить не удалось — открывать нечего, но сказать об
    // отказе тем более обязательно
    expect(buttonByText('Открыть письмо')).toBeUndefined();
    expect(buttonByText('Понятно')).toBeTruthy();
  });
});

describe('текст причины', () => {
  it('называет и причину, и адреса, и когда пробовали', () => {
    const text = failureSummary({
      reason: 'Почтовый сервер получателя недоступен',
      rejected: [{ address: 'kolya@mail.local', message: '450 try later' }],
      envelopeTo: ['kolya@mail.local', 'olya@mail.local'],
      attempts: 5,
      lastAttemptAt: new Date(2026, 7, 6, 12, 20).toISOString(),
    });
    expect(text).toContain('Почтовый сервер получателя недоступен');
    // Именно тот адрес, который отверг сервер, а не все подряд: чинить
    // обычно надо один опечатанный адрес из пяти
    expect(text).toContain('Не доставлено: kolya@mail.local');
    expect(text).not.toContain('olya@mail.local, ');
    expect(text).toContain('Попыток: 5');
    expect(text).toContain('6 августа в 12:20');
  });

  it('если сервер адресов не назвал — перечисляет получателей письма', () => {
    const text = failureSummary({
      reason: 'Почтовый сервер отклонил письмо (код 554)',
      rejected: [],
      envelopeTo: ['kolya@mail.local'],
      attempts: 1,
      lastAttemptAt: new Date(2026, 7, 6, 12, 20).toISOString(),
    });
    expect(text).toContain('Не доставлено: kolya@mail.local');
    // Одна попытка не выдаёт себя за несколько
    expect(text).toContain('Пробовали 6 августа в 12:20');
    expect(text).not.toContain('Попыток');
  });

  it('битое время не превращается в «Invalid Date» на экране', () => {
    expect(formatAttemptedAt('когда-нибудь')).toBe('');
    const text = failureSummary({
      reason: 'Отказано',
      rejected: [],
      envelopeTo: [],
      attempts: 1,
      lastAttemptAt: 'мусор',
    });
    expect(text).toBe('Отказано.');
  });
});

/*
 * Частичная доставка — не отказ. Письмо ушло большинству получателей, и
 * заголовок «Письмо не отправлено» над ним прямо толкал отправить его
 * заново: у получивших оказывался дубль. Причина под заголовком при этом
 * говорила обратное — интерфейс спорил сам с собой.
 */
describe('письмо дошло не всем', () => {
  it('заголовок говорит о частичной доставке, а не об отказе', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([
      notice({
        partial: true,
        reason: 'Письмо доставлено не всем получателям',
        draftUid: null,
      }),
    ]);
    render();

    await waitFor(() => host.textContent?.includes('Письмо дошло не всем') ?? false, 'плашку');
    expect(host.textContent).not.toContain('Письмо не отправлено');
    // Кнопки «Открыть письмо» здесь нет намеренно: письмо ушло, править
    // и отправлять заново нечего — правится список получателей.
    expect(buttonByText('Открыть письмо')).toBeUndefined();
  });

  it('полный отказ по-прежнему называется отказом', async () => {
    vi.spyOn(api, 'getSendFailures').mockResolvedValue([notice()]);
    render();
    await waitFor(() => host.textContent?.includes('Письмо не отправлено') ?? false, 'плашку');
    expect(host.textContent).not.toContain('Письмо дошло не всем');
  });
});
