// @vitest-environment jsdom
/**
 * Смена оформления живьём: панель в шапке показывает все темы с
 * образцами и применяет выбор мгновенно; страница настроек включает
 * «обойную» тему при выборе фона; выбор запоминается.
 *
 * На старом коде всё это падало: палитра перебирала три темы по кругу,
 * раздела оформления в настройках не было.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { THEMES } from '../src/appearance/themes';
import { WALLPAPER_PRESETS } from '../src/appearance/wallpapers';
import { useUiStore } from '../src/app/store';
import { ThemeMenu } from '../src/layout/ThemeMenu';
import { AppearancePage } from '../src/pages/settings/AppearancePage';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--mt-user-wallpaper');
  useUiStore.setState({ themeSetting: 'system', theme: 'light' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(ui: React.ReactElement) {
  act(() => {
    root.render(<MemoryRouter>{ui}</MemoryRouter>);
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('панель тем в шапке', () => {
  function openMenu() {
    render(<ThemeMenu />);
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Тема оформления"]');
    expect(trigger).not.toBeNull();
    click(trigger!);
  }

  it('показывает все темы сразу, с образцами, плюс «Авто»', () => {
    openMenu();
    const options = [...host.querySelectorAll('[role="menuitemradio"]')];
    expect(options.length).toBe(THEMES.length + 1);
    // у каждого пункта есть цветовой образец, а не только название
    for (const option of options) {
      expect(option.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    }
    const titles = options.map((o) => o.textContent);
    expect(titles).toContain('Авто');
    for (const t of THEMES) expect(titles).toContain(t.title);
  });

  it('выбор применяется сразу, без перезагрузки, и запоминается', () => {
    openMenu();
    const emerald = [...host.querySelectorAll('[role="menuitemradio"]')].find(
      (o) => o.textContent === 'Изумруд',
    );
    expect(emerald).toBeDefined();
    click(emerald!);
    expect(document.documentElement.dataset['theme']).toBe('emerald');
    expect(localStorage.getItem('mt-theme')).toBe('emerald');
    // панель не закрылась — темы можно сравнивать подряд
    const checked = host.querySelector('[role="menuitemradio"][aria-checked="true"]');
    expect(checked?.textContent).toBe('Изумруд');
  });

  it('«Авто» возвращает системную тему', () => {
    useUiStore.getState().setTheme('dark');
    openMenu();
    const auto = [...host.querySelectorAll('[role="menuitemradio"]')].find(
      (o) => o.textContent === 'Авто',
    );
    click(auto!);
    // jsdom без matchMedia — системная считается светлой
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(localStorage.getItem('mt-theme')).toBe('system');
  });
});

describe('настройки оформления', () => {
  it('выбор готового фона включает «обойную» тему и ставит картинку', () => {
    render(<AppearancePage />);
    const preset = WALLPAPER_PRESETS[2]!;
    const tile = host.querySelector<HTMLButtonElement>(
      `button[aria-label='Фон «${preset.title}»']`,
    );
    expect(tile).not.toBeNull();
    click(tile!);
    expect(document.documentElement.dataset['theme']).toBe('wallpaper');
    expect(localStorage.getItem('mt-wallpaper')).toBe(`preset:${preset.id}`);
    expect(document.documentElement.style.getPropertyValue('--mt-user-wallpaper')).toBe(preset.css);
  });

  it('темы показаны карточками-предпросмотрами, активная помечена', () => {
    useUiStore.getState().setTheme('violet');
    render(<AppearancePage />);
    const radios = [
      ...host.querySelectorAll('[role="radiogroup"][aria-label="Тема оформления"] [role="radio"]'),
    ];
    expect(radios.length).toBe(THEMES.length + 1);
    const active = radios.find((r) => r.getAttribute('aria-checked') === 'true');
    expect(active?.textContent).toBe('Фиалка');
  });

  it('слишком большой файл отклоняется с внятным объяснением', async () => {
    render(<AppearancePage />);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const big = new File([new ArrayBuffer(1)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    Object.defineProperty(input!, 'files', { value: [big], configurable: true });
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('МБ');
    // тема при этом не тронута
    expect(document.documentElement.dataset['theme']).not.toBe('wallpaper');
  });
});
