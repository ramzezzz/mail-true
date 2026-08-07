/**
 * Страница «Смена домена»: защита от нажатия вслепую и честность экрана.
 *
 * Четыре поведения, ради которых страница вообще устроена в два шага:
 *
 *   1. кнопки выполнения нет, пока не составлен план;
 *   2. она не работает, пока имя нового домена не набрано руками —
 *      «да» набирают не читая, а тут меняется адрес каждого человека;
 *   3. препятствие (идущий перенос почты, нехватка места) запирает
 *      выполнение, а не показывается мелким шрифтом рядом с кнопкой;
 *   4. на экране ЕСТЬ то, что администратор обязан узнать до, а не после:
 *      перенастройка почтовых программ у людей, точка невозврата и шаг
 *      на сервере. Проверка на присутствие текста выглядит формальной
 *      ровно до того дня, когда кто-нибудь решит «убрать лишнее».
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainChangeJob, DomainChangeOverview, DomainChangePlan } from '../src/api/types';

let overviewAnswer: DomainChangeOverview;
const applied: Array<{ id: number; confirm: string }> = [];
const cancelled: number[] = [];

vi.mock('../src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    domainChange: () => Promise.resolve(overviewAnswer),
    domainChangePlan: (newDomain: string) => Promise.resolve({ newDomain }),
    domainChangeApply: (id: number, confirm: string) => {
      applied.push({ id, confirm });
      return Promise.resolve({ ok: true, id, state: 'running' });
    },
    domainChangeCancel: (id: number) => {
      cancelled.push(id);
      return Promise.resolve({ ok: true, targetDomainRemoved: true });
    },
  },
}));

let permissions = ['domainchange.run'];
vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, session: { login: 'osmotr', permissions } }),
}));

const { DomainChangePage } = await import('../src/pages/DomainChangePage');

function plan(over: Partial<DomainChangePlan> = {}): DomainChangePlan {
  return {
    createdAt: '2026-01-01T10:00:00.000Z',
    oldDomain: 'staraya.ru',
    newDomain: 'novaya.ru',
    oldHostname: 'mail.staraya.ru',
    newHostname: 'mail.novaya.ru',
    counts: {
      mailboxes: 12,
      aliases: 3,
      disposableAliases: 0,
      messages: 4210,
      bytes: 3_400_000_000,
      rows: 87,
      tables: [{ table: 'mail_signatures', column: 'account_email', what: 'подписи', rows: 9 }],
      freeTextHits: [{ what: 'подписи', rows: 4 }],
    },
    space: {
      path: '/var/mail/vhosts',
      freeBytes: 40_000_000_000,
      totalBytes: 100_000_000_000,
      requiredBytes: 536_870_912,
      renameOnly: true,
      ok: true,
    },
    dkim: {
      selector: 'mail',
      recordName: 'mail._domainkey.novaya.ru',
      publicKey: 'PUBLIC',
      record: 'v=DKIM1; k=rsa; p=PUBLIC',
    },
    dnsToPublish: [
      {
        name: 'novaya.ru',
        type: 'MX',
        value: '10 mail.novaya.ru.',
        required: true,
        why: 'Куда нести почту',
      },
      {
        name: 'mail._domainkey.novaya.ru',
        type: 'TXT',
        value: 'v=DKIM1; k=rsa; p=PUBLIC',
        required: true,
        why: 'Публичный ключ подписи',
      },
    ],
    dnsReady: false,
    dnsSummary: 'Ещё не видны снаружи: MX.',
    blockers: [],
    breaks: ['Настроенные почтовые программы у всех 12 ящиков перестанут забирать почту.'],
    manual: ['Запустить на сервере: sudo bash infra/scripts/change-domain.sh'],
    keeps: [{ what: 'Адреса внутри писем', why: 'Подпись DKIM развалится.' }],
    downtimeSeconds: { min: 6, max: 34 },
    warnings: [],
    ...over,
  };
}

function job(over: Partial<DomainChangeJob> = {}): DomainChangeJob {
  return {
    id: 7,
    state: 'planned',
    adminLogin: 'rukovodstvo',
    oldDomain: 'staraya.ru',
    newDomain: 'novaya.ru',
    oldHostname: 'mail.staraya.ru',
    newHostname: 'mail.novaya.ru',
    dkimSelector: 'mail',
    dkimPublicKey: 'PUBLIC',
    plan: plan(),
    steps: [
      { id: 'backup', title: 'Резервная копия настроек', state: 'ok', detail: 'снята' },
      { id: 'files', title: 'Перенос писем и индексов', state: 'pending' },
    ],
    pointOfNoReturnAt: null,
    cancellable: true,
    mailboxes: 0,
    aliases: 0,
    messages: 0,
    bytes: 0,
    backupPath: null,
    backupBytes: 0,
    error: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function overview(over: Partial<DomainChangeOverview> = {}): DomainChangeOverview {
  return {
    ready: true,
    reason: null,
    currentDomain: 'staraya.ru',
    currentHostname: 'mail.staraya.ru',
    canStoreKey: true,
    live: null,
    history: [],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  overviewAnswer = overview();
  permissions = ['domainchange.run'];
  applied.length = 0;
  cancelled.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Даёт запросам отработать.
 *
 * Одного `act` мало: состояние раздела приезжает запросом, и до его
 * ответа на экране только форма первого шага. Проверять её вместо плана
 * значит проверять пустую страницу и радоваться.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DomainChangePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Кнопка по видимому тексту — так же, как её ищет человек. */
function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`Кнопка «${text}» не найдена`);
  return found;
}

async function type(label: RegExp, value: string): Promise<void> {
  const input = [...container.querySelectorAll('input')].find((node) => {
    const wrapper = node.closest('label') ?? node.parentElement?.parentElement;
    return label.test(wrapper?.textContent ?? '');
  });
  if (!input) throw new Error(`Поле ${String(label)} не найдено`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('смена домена', () => {
  it('без права раздел не показывает ни плана, ни кнопок', async () => {
    permissions = [];
    await render();
    expect(container.textContent).toContain('только полному доступу');
    expect(() => button('Составить план')).toThrow();
  });

  it('пока плана нет, выполнения на экране не существует', async () => {
    await render();
    expect(button('Составить план')).toBeTruthy();
    expect(() => button('Сменить домен')).toThrow();
  });

  it('план показывает последствия, точку невозврата и шаг на сервере', async () => {
    overviewAnswer = overview({ live: job() });
    await render();
    const text = container.textContent ?? '';
    // Числа плана.
    expect(text).toContain('12');
    expect(text).toContain('4210');
    // Главное, что человек обязан унести с экрана.
    expect(text).toContain('перестанут забирать почту');
    expect(text.toLowerCase()).toContain('точка невозврата');
    expect(text).toContain('change-domain.sh');
    // Обещание, что старый домен продолжит принимать письма.
    expect(text).toContain('остаётся принимающим');
    // Записи DNS с готовыми значениями.
    expect(text).toContain('mail._domainkey.novaya.ru');
  });

  it('кнопка не срабатывает, пока имя домена не набрано целиком', async () => {
    overviewAnswer = overview({ live: job() });
    await render();
    expect(button('Сменить домен').disabled).toBe(true);

    await type(/Наберите novaya\.ru/u, 'novaya');
    expect(button('Сменить домен').disabled).toBe(true);

    await type(/Наберите novaya\.ru/u, 'staraya.ru');
    expect(button('Сменить домен').disabled).toBe(true);

    await type(/Наберите novaya\.ru/u, 'novaya.ru');
    expect(button('Сменить домен').disabled).toBe(false);
    await click(button('Сменить домен'));
    expect(applied).toEqual([{ id: 7, confirm: 'novaya.ru' }]);
  });

  it('препятствие запирает выполнение, даже если имя набрано верно', async () => {
    overviewAnswer = overview({
      live: job({
        plan: plan({
          blockers: [
            {
              id: 'migration-running',
              message: 'Идёт перенос почты с другого сервера.',
              fix: 'Дождитесь окончания.',
            },
          ],
        }),
      }),
    });
    await render();
    expect(container.textContent).toContain('Идёт перенос почты с другого сервера.');
    await type(/Наберите novaya\.ru/u, 'novaya.ru');
    expect(button('Сменить домен').disabled).toBe(true);
    expect(applied).toEqual([]);
  });

  it('до точки невозврата отказ доступен, после — его нет', async () => {
    overviewAnswer = overview({ live: job() });
    await render();
    await click(button('Отказаться'));
    expect(cancelled).toEqual([7]);
  });

  it('идущая смена показывает ход работ и не предлагает отмену', async () => {
    overviewAnswer = overview({
      live: job({
        state: 'running',
        pointOfNoReturnAt: '2026-01-01T10:05:00.000Z',
        steps: [
          { id: 'backup', title: 'Резервная копия настроек', state: 'ok', detail: 'снята' },
          { id: 'files', title: 'Перенос писем и индексов', state: 'running' },
        ],
      }),
    });
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('Перенос писем и индексов');
    expect(text.toLowerCase()).toContain('точка невозврата пройдена');
    expect(() => button('Отказаться')).toThrow();
    expect(() => button('Сменить домен')).toThrow();
  });

  it('без секрета шифрования человека предупреждают про ключ DKIM заранее', async () => {
    overviewAnswer = overview({ canStoreKey: false });
    await render();
    expect(container.textContent).toContain('приватный ключ DKIM');
  });
});
