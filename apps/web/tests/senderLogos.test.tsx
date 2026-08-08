// @vitest-environment jsdom
/**
 * Логотипы доменов в кружках списка писем.
 *
 * Проверяется три свойства, каждое из которых легко потерять правкой:
 *   1. Буква остаётся нормой: без подтверждённого домена, до ответа сервера
 *      и при сбое картинки кружок выглядит ровно как раньше.
 *   2. Браузер не ходит к чужим сайтам НИКОГДА — в разметке только наши
 *      адреса. Иначе список писем превращается в маячок для отправителя.
 *   3. Домены в списке повторяются, а запрос уходит один.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';

const apiFetchMock = vi.fn();
vi.mock('../src/api/http', () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init) as unknown,
}));

import { SenderAvatar } from '../src/mail/SenderAvatar';
import { resetSenderLogos } from '../src/mail/senderLogos';

/*
 * Заглушки здесь выключены явно: проверка подделывает fetch и смотрит,
 * что уходит на сервер. На заглушечных данных этот путь не работает
 * вовсе — и правильно, ходить там некуда, — но проверять надо именно его.
 */
vi.mock('../src/api/mockFlag', () => ({ useMocks: false }));

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const avatarCss = readFileSync(join(SRC, 'mail/SenderAvatar.module.css'), 'utf8');

let container: HTMLDivElement;
let root: Root;

/** Ждёт, пока отработают отложенные задачи реестра и придёт ответ. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  resetSenderLogos();
  apiFetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('кружок отправителя', () => {
  it('без подтверждённого домена показывает букву и не спрашивает сервер', async () => {
    act(() => {
      root.render(<SenderAvatar name="Иван Петров" address="ivan@mail.local" logoDomain={null} />);
    });
    await settle();

    expect(container.textContent).toBe('И');
    expect(container.querySelector('img')).toBeNull();
    // Главное: за логотипом непроверенного отправителя никуда не ходим.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('до ответа сервера показывает букву, а не пустой кружок', async () => {
    // Список писем логотипов не ждёт: он рисуется сразу, буквами.
    apiFetchMock.mockImplementation(() => new Promise(() => undefined));
    act(() => {
      root.render(
        <SenderAvatar name="GitHub" address="noreply@github.com" logoDomain="github.com" />,
      );
    });
    await settle();
    expect(container.textContent).toBe('G');
  });

  it('логотип приходит с НАШЕГО адреса, а не со стороннего сайта', async () => {
    apiFetchMock.mockResolvedValue({
      enabled: true,
      logos: { 'github.com': { status: 'ready', url: '/api/sender-logos/github.com/image?v=abc' } },
    });
    act(() => {
      root.render(
        <SenderAvatar name="GitHub" address="noreply@github.com" logoDomain="github.com" />,
      );
    });
    await settle();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    const src = img?.getAttribute('src') ?? '';
    expect(src).toBe('/api/sender-logos/github.com/image?v=abc');
    // Ни одной ссылки наружу: отправитель не должен узнавать, что письмо
    // сейчас открыли, и с какого адреса.
    expect(src.startsWith('/api/')).toBe(true);
    expect(container.innerHTML).not.toMatch(/https?:\/\//u);
  });

  it('битая картинка возвращает букву, а не значок поломки', async () => {
    apiFetchMock.mockResolvedValue({
      enabled: true,
      logos: { 'github.com': { status: 'ready', url: '/api/sender-logos/github.com/image?v=abc' } },
    });
    act(() => {
      root.render(
        <SenderAvatar name="GitHub" address="noreply@github.com" logoDomain="github.com" />,
      );
    });
    await settle();

    const img = container.querySelector('img');
    act(() => {
      img?.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('G');
  });

  it('серый кружок цепочки не перекрашивается, а логотип в нём всё равно работает', async () => {
    // В переписке кружки одноцветные из темы. Общий компонент не должен
    // молча переделывать это оформление под себя.
    apiFetchMock.mockResolvedValue({ enabled: true, logos: {} });
    act(() => {
      root.render(
        <SenderAvatar name="Иван" address="ivan@mail.local" logoDomain={null} tint={false} />,
      );
    });
    await settle();
    const circle = container.firstElementChild;
    expect(circle?.getAttribute('style')).toBeNull();
    expect(container.textContent).toBe('И');
  });

  it('домены не повторяются в запросе: пятьдесят строк — один запрос', async () => {
    apiFetchMock.mockResolvedValue({ enabled: true, logos: {} });
    const rows = Array.from({ length: 50 }, (_, i) => (
      <SenderAvatar
        key={i}
        name="Отправитель"
        address={`user${String(i)}@${i % 2 === 0 ? 'github.com' : 'gitlab.com'}`}
        logoDomain={i % 2 === 0 ? 'github.com' : 'gitlab.com'}
      />
    ));
    act(() => {
      root.render(<>{rows}</>);
    });
    await settle();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((apiFetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      domains: string[];
    };
    expect(body.domains.sort()).toEqual(['github.com', 'gitlab.com']);
  });

  it('ответ «выключено» прекращает вопросы до конца сеанса', async () => {
    apiFetchMock.mockResolvedValue({ enabled: false, logos: {} });
    act(() => {
      root.render(<SenderAvatar name="GitHub" address="a@github.com" logoDomain="github.com" />);
    });
    await settle();

    act(() => {
      root.render(<SenderAvatar name="GitLab" address="a@gitlab.com" logoDomain="gitlab.com" />);
    });
    await settle();

    // Один запрос, чтобы это выяснить, — и больше ни одного.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('G');
  });
});

describe('кружок отправителя рисуется ОДНИМ компонентом везде', () => {
  /*
   * Заказчик поймал ровно это: в списке логотип есть, в открытом письме —
   * буква. Причина была не в логике, а в том, что кружок был написан
   * трижды. Пять похожих реализаций разъезжаются при первой правке, и в
   * четвёртом месте логотип снова оказывается буквой, — поэтому проверяем
   * не поведение каждого места, а то, что мест-реализаций больше нет.
   */
  const places = ['mail/MessageList.tsx', 'mail/MessageThread.tsx', 'pages/MessagePage.tsx'];

  for (const place of places) {
    it(`${place} использует SenderAvatar и не рисует букву сам`, () => {
      const code = readFileSync(join(SRC, place), 'utf8');
      expect(code).toMatch(/<SenderAvatar\b/u);
      // Собственный расчёт цвета кружка — признак копии компонента.
      expect(code).not.toMatch(/function avatarHue/u);
    });
  }
});

describe('логотип вписан в круг, как в привычных почтовых интерфейсах', () => {
  /** Тело правила по селектору. */
  function rule(selector: string): string {
    const at = avatarCss.indexOf(`\n${selector} {`);
    expect(at, `в CSS нет правила ${selector}`).toBeGreaterThanOrEqual(0);
    const open = avatarCss.indexOf('{', at);
    return avatarCss.slice(open + 1, avatarCss.indexOf('}', open));
  }

  it('логотип вписывается целиком, а не обрезается', () => {
    // `cover` растянул бы широкий логотип и срезал у него края — то самое,
    // по чему знак и узнают.
    expect(rule('.logo')).toMatch(/object-fit:\s*contain/u);
    expect(rule('.logo')).not.toMatch(/object-fit:\s*cover/u);
  });

  it('поле не даёт кругу срезать углы квадратного значка', () => {
    // Сторона квадрата, вписанного в круг, — 0.707 поперечника, поэтому
    // без поля примерно в 14% круг режет все четыре угла.
    const padding = /padding:\s*(\d+(?:\.\d+)?)%/u.exec(rule('.logo'));
    expect(padding).not.toBeNull();
    expect(Number(padding?.[1])).toBeGreaterThanOrEqual(13);
  });

  it('под прозрачным логотипом есть светлая подложка', () => {
    // Без неё тёмный знак пропадает на тёмной теме, а цветной кружок
    // просвечивает сквозь прозрачные места и красит чужой знак.
    expect(rule('.withLogo')).toMatch(/background:\s*#ffffff/iu);
    expect(rule('.withLogo')).toMatch(/overflow:\s*hidden/u);
  });
});
