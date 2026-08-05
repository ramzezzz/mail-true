/**
 * Движение в интерфейсе и геометрия переключателя.
 *
 * Проверяется исходный CSS, а не отрисовка: jsdom не считает стили модулей,
 * а именно в правилах и живут обе жалобы заказчика — «переключатели кривые»
 * и «не хватает анимации». Каждая проверка здесь падала на прежнем коде.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

const css = (relative: string): string => readFileSync(join(SRC, relative), 'utf8');

/** Тело правила по его селектору — без вложенных фигурных скобок правил не бывает. */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector);
  if (at < 0) throw new Error(`нет правила ${selector}`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

describe('движение уважает prefers-reduced-motion', () => {
  const global = css('styles/global.css');

  it('глобальный выключатель гасит все переходы и анимации разом', () => {
    expect(global).toContain('@media (prefers-reduced-motion: reduce)');
    const block = global.slice(global.indexOf('@media (prefers-reduced-motion: reduce)'));
    // Селектор — общий, иначе за каждой новой анимацией пришлось бы следить руками
    expect(block).toContain('*:not([data-motion=');
    expect(block).toMatch(/animation-duration:\s*\S+\s*!important/);
    expect(block).toMatch(/transition-duration:\s*\S+\s*!important/);
    // Без этого бесконечная анимация крутилась бы вхолостую по кругу за 1мс
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('крутилка загрузки выведена из-под выключателя: остановленная, она врёт', () => {
    expect(css('../src/components/Spinner/Spinner.tsx')).toContain('data-motion="keep"');
  });
});

describe('переключатель', () => {
  const switchCss = css('components/Switch/Switch.module.css');
  const themes = css('styles/themes.css');

  it('размеры сняты с mail.ru, а не взяты из сырых токенов VKUI', () => {
    // Замеры по research/mailru/05-filters.png: дорожка 32×20, бегунок 16,
    // поле 2. Сырые --vkui--size_switch_* дают 34×14 при бегунке 20 —
    // с ними бегунок вылезал за дорожку на 8px вниз и на 2px вправо.
    expect(themes).toMatch(/--mt-switch-width:\s*32px/);
    expect(themes).toMatch(/--mt-switch-height:\s*20px/);
    expect(themes).toMatch(/--mt-switch-pin:\s*16px/);
    expect(themes).toMatch(/--mt-switch-inset:\s*2px/);
    expect(switchCss).not.toContain('--mt-size-switch-');
  });

  it('бегунок стоит по центру дорожки одинаковым полем со всех сторон', () => {
    const thumb = ruleBody(switchCss, '.thumb {');
    expect(thumb).toMatch(/top:\s*var\(--mt-switch-inset/);
    expect(thumb).toMatch(/left:\s*var\(--mt-switch-inset/);
    expect(thumb).toMatch(/width:\s*var\(--mt-switch-pin/);
    expect(thumb).toMatch(/height:\s*var\(--mt-switch-pin/);
  });

  it('ход бегунка считается из размеров, а не вписан числом', () => {
    const moved = switchCss.slice(switchCss.indexOf('.input:checked + .track .thumb'));
    expect(moved).toContain('--mt-switch-width');
    expect(moved).toContain('--mt-switch-pin');
    expect(moved).toContain('--mt-switch-inset');
    // 14px было подобрано под прежние размеры и уводило бегунок за дорожку
    expect(moved.slice(0, moved.indexOf('}'))).not.toContain('14px');
  });

  it('подпись выровнена по строке текста, а не по высоте дорожки', () => {
    const label = ruleBody(switchCss, '.label {');
    expect(label).toMatch(/line-height:\s*var\(--mt-font-paragraph-line-height/);
    expect(label).not.toContain('switch-height');
  });

  it('длинная подпись не растягивает переключатель за колонку', () => {
    expect(ruleBody(switchCss, '.wrapper {')).toMatch(/max-width:\s*100%/);
  });

  it('у бегунка есть ход, у дорожки — наведение и нажатие', () => {
    expect(switchCss).toMatch(/transition:\s*transform var\(--mt-anim-duration-m/);
    expect(switchCss).toContain('.wrapper:hover .input:not(:disabled) + .track');
    expect(switchCss).toContain('.wrapper:active .input:not(:disabled) + .track');
    expect(switchCss).toContain('--mt-switch-track-on-hover');
    expect(switchCss).toContain('--mt-switch-track-off-press');
  });

  it('цвета берутся из переменных темы, а не подобраны на глаз', () => {
    // Ни одного шестнадцатеричного цвета в компоненте
    expect(switchCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(themes).toContain('--mt-switch-track-on: var(--mt-color-background-accent)');
  });
});

describe('нажатие видно на кнопках и флажках', () => {
  it('обычная кнопка проседает', () => {
    const button = css('components/Button/Button.module.css');
    expect(button).toContain('.button:active:not(:disabled)');
    expect(ruleBody(button, '.button:active:not(:disabled) {')).toMatch(/transform:\s*scale\(/);
    expect(ruleBody(button, '.button {')).toContain('transform var(--mt-anim-duration-s');
  });

  it('кнопка-значок проседает', () => {
    const icon = css('components/IconButton/IconButton.module.css');
    expect(ruleBody(icon, '.iconButton:active:not(:disabled) {')).toMatch(/transform:\s*scale\(/);
  });

  it('флажок проседает', () => {
    const checkbox = css('components/Checkbox/Checkbox.module.css');
    expect(checkbox).toContain('.wrapper:active .input:not(:disabled) + .box');
    expect(ruleBody(checkbox, '.wrapper:active .input:not(:disabled) + .box {')).toMatch(
      /transform:\s*scale\(/,
    );
  });
});

describe('окна и меню появляются и уезжают', () => {
  it('модальное окно приезжает и уезжает', () => {
    const modal = css('components/Modal/Modal.module.css');
    expect(modal).toContain('@keyframes cardShow');
    expect(modal).toContain('@keyframes overlayShow');
    expect(ruleBody(modal, '.cardClosing {')).toContain('reverse');
    expect(ruleBody(modal, '.overlayClosing {')).toContain('reverse');
  });

  it('выпадающее меню уезжает, когда от него отказались', () => {
    const dropdown = css('components/Dropdown/Dropdown.module.css');
    expect(dropdown).toContain('.menuClosing');
    expect(ruleBody(dropdown, '.menuClosing {')).toContain('reverse');
    // Пункты уехавшего меню больше не нажимаются
    expect(ruleBody(dropdown, '.menuClosing {')).toContain('pointer-events: none');
  });

  it('окно написания выезжает снизу и так же сворачивается в плашку', () => {
    const compose = css('compose/ComposeWindow.module.css');
    expect(compose).toContain('@keyframes composeShow');
    expect(compose).toContain('@keyframes composeMinimize');
    expect(ruleBody(compose, '.window {')).toContain('animation: composeShow');
    expect(ruleBody(compose, '.minimizedBar {')).toContain('animation: composeMinimize');
  });

  it('плашка отказа выезжает снизу, не теряя центрирования', () => {
    const notice = css('layout/Notice.module.css');
    expect(notice).toContain('@keyframes noticeShow');
    // Сдвиг по X обязан остаться в обоих кадрах, иначе плашка прыгает вбок
    const frames = notice.slice(notice.indexOf('@keyframes noticeShow'));
    expect(frames.match(/translateX\(-50%\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('список писем отвечает на действия', () => {
  const list = css('mail/MessageList.module.css');

  it('строка гаснет, как только письмо отправлено в другую папку', () => {
    const leaving = ruleBody(list, '.row.leaving {');
    expect(leaving).toMatch(/opacity:\s*0/);
    expect(leaving).toMatch(/transform:\s*translateX/);
    expect(ruleBody(list, '.row {')).toContain('opacity var(--mt-anim-duration-m');
  });

  it('смена папки и загрузка списка видны', () => {
    expect(list).toContain('@keyframes listShow');
    expect(ruleBody(list, '.scroll {')).toContain('animation: listShow');
  });
});

describe('выдвижной ящик папок на узком экране', () => {
  it('едет, а не появляется рывком', () => {
    const layout = css('layout/AppLayout.module.css');
    expect(layout).toMatch(/transition:\s*transform var\(--mt-anim-duration-m/);
    expect(layout).toMatch(/transition:\s*opacity var\(--mt-anim-duration-m/);
  });
});

describe('длительности не растягивают работу', () => {
  it('нигде не заведено переходов длиннее 0.4s', () => {
    const files = [
      'components/Switch/Switch.module.css',
      'components/Button/Button.module.css',
      'components/IconButton/IconButton.module.css',
      'components/Checkbox/Checkbox.module.css',
      'components/Modal/Modal.module.css',
      'components/Dropdown/Dropdown.module.css',
      'compose/ComposeWindow.module.css',
      'mail/MessageList.module.css',
      'mail/ContextMenu.module.css',
      'layout/Notice.module.css',
    ];
    for (const file of files) {
      for (const [, seconds] of css(file).matchAll(/(\d+(?:\.\d+)?)s\b/g)) {
        expect(Number(seconds), `${file}: ${seconds}s`).toBeLessThanOrEqual(0.4);
      }
    }
  });
});
