/**
 * Мелочи каркаса, каждая — со своим числом из research/mailru.
 *
 *   header-toolbar.json — кнопка `.button2__wrapper`: поля «0px 10px»,
 *                         цвет rgb(51,51,51), «Выделить все» на x=248
 *                         при колонке списка, начинающейся на 232;
 *   01-inbox.png        — «Написать письмо» занимает строки 62…97, то есть
 *                         начинается ровно под шапкой (её высота 62);
 *   row-anatomy.json    — значки списка нарисованы классом ico_size_s,
 *                         это svg 20×20 при viewBox 0 0 16 16.
 *
 * Плюс два общих недуга: два разных стиля фокуса на одном экране и
 * «мины» в сгенерированном слое токенов — значения из ТЁМНОЙ (обойной)
 * темы, лежащие в :root рядом со светлыми ступенями того же семейства.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renameToken } from '../scripts/build-tokens.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, '../src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const globalCss = read('styles/global.css');
const themesCss = read('styles/themes.css');
const tokensCss = read('styles/tokens.css');
const buttonCss = read('components/Button/Button.module.css');
const toolbarCss = read('mail/ListToolbar.module.css');
const sidebarCss = read('layout/Sidebar.module.css');
const sidebarTsx = read('layout/Sidebar.tsx');

describe('панель над списком повторяет мейловскую .button2', () => {
  it('третичная кнопка: поля 0 10px, а не общие 0 16px', () => {
    const tertiary = buttonCss.slice(
      buttonCss.indexOf('.mode_tertiary {'),
      buttonCss.indexOf('.mode_tertiary:hover'),
    );
    expect(tertiary).toMatch(/padding:\s*0 10px/u);
  });

  it('цвет текста — мейловый #333, а не общий #2C2D2E', () => {
    const tertiary = buttonCss.slice(
      buttonCss.indexOf('.mode_tertiary {'),
      buttonCss.indexOf('.mode_tertiary:hover'),
    );
    expect(tertiary).toContain('--mt-mail-color-button-text');
    expect(tertiary).not.toContain('color: var(--mt-color-text-primary)');
    // Токен есть в выгрузке ровно с этим значением
    expect(tokensCss).toMatch(/--mt-mail-color-button-text:\s*#333333/iu);
    // …и в тёмной теме он возвращается к основному тексту
    expect(themesCss).toMatch(/--mt-mail-color-button-text:\s*var\(--mt-color-text-primary\)/u);
  });

  it('панель отступает от края колонки на 16px, как «Выделить все» на x=248', () => {
    const bar = toolbarCss.slice(toolbarCss.indexOf('.toolbar {'), toolbarCss.indexOf('.spacer'));
    expect(bar).toMatch(/padding:\s*0 12px 0 16px/u);
  });
});

describe('левый столбец', () => {
  it('начинается сразу под шапкой, без верхнего поля', () => {
    const rule = sidebarCss.slice(
      sidebarCss.indexOf('.sidebar {'),
      sidebarCss.indexOf('.composeRow'),
    );
    // Было `padding: var(--mt-mail-size-sidebar-padding-top, 12px) 16px 16px`,
    // и весь столбец стоял на y=74 вместо y=62
    expect(rule).toMatch(/padding:\s*0 16px 16px/u);
    expect(rule).not.toContain('--mt-mail-size-sidebar-padding-top');
  });

  it('значки папок 20×20, а не 16×16', () => {
    expect(sidebarTsx).toMatch(/<IconFolderRole role=\{f\.role\} size=\{20\} \/>/u);
    /*
     * «Новая папка» рисуется своим svg — и он тоже 20.
     *
     * Размеры ищутся по отдельности, а не одной строкой `width="20"
     * height="20"`: Prettier разносит атрибуты по строкам, и проверка,
     * привязанная к их порядку и соседству, падала бы на форматировании —
     * то есть говорила бы «значок не того размера» там, где размер не
     * менялся вовсе.
     */
    const ownSvg = /<svg[^>]*>/gsu;
    const svgTags = [...sidebarTsx.matchAll(ownSvg)].map((m) => m[0]);
    expect(svgTags.length).toBeGreaterThan(0);
    for (const tag of svgTags) {
      expect(tag).toMatch(/width="20"/u);
      expect(tag).toMatch(/height="20"/u);
    }
  });
});

describe('рамка фокуса — одна на весь интерфейс', () => {
  it('в global.css есть общее правило на всё фокусируемое', () => {
    expect(globalCss).toMatch(/:where\([^)]*button[^)]*\):focus-visible/u);
    expect(globalCss).toContain('--mt-focus-ring-color');
  });

  it('цвет и толщина заданы переменными и объявлены один раз', () => {
    expect(themesCss).toMatch(/--mt-focus-ring-width:\s*2px/u);
    expect(themesCss).toMatch(/--mt-focus-ring-color:\s*var\(--mt-color-stroke-accent\)/u);
  });

  it('ни один компонент не рисует свою рамку мимо переменных', () => {
    const modules = [
      'mail/MessageList.module.css',
      'components/Checkbox/Checkbox.module.css',
      'components/Switch/Switch.module.css',
      'pages/MessagePage.module.css',
      'pages/LoginPage.module.css',
    ];
    for (const path of modules) {
      const css = read(path);
      // Сброс (`outline: 0` / `none`) рамкой не является — смотрим только
      // на те объявления, что рисуют видимую обводку
      for (const [line] of css.matchAll(/^\s*outline:.*solid.*$/gmu)) {
        expect(line, `${path}: рамка мимо --mt-focus-ring-*`).toContain('--mt-focus-ring-width');
        expect(line, `${path}: цвет рамки мимо --mt-focus-ring-*`).toContain(
          '--mt-focus-ring-color',
        );
      }
    }
  });
});

describe('мины в сгенерированном слое токенов', () => {
  /*
   * Выгрузка снята при «обойной» теме. У этих двух семейств базовое значение
   * оттуда белое, а ступени --hover/--active — из обычной светлой темы:
   * внутри одного семейства значения из разных тем. В приложении их никто не
   * использовал, но первый же, кто взял бы базовое, получил бы белый текст
   * на белом. Теперь генератор их не берёт вовсе.
   */
  it('в tokens.css нет обойных значений левого меню', () => {
    expect(tokensCss).not.toContain('--mt-mail-color-sidebar-item-text-secondary');
    expect(tokensCss).not.toContain('--mt-mail-color-sidebar-icon-unread');
  });

  it('генератор отбрасывает оба семейства вместе со ступенями', () => {
    for (const source of [
      '--vkui--octavius_color_sidebar_item_text_secondary',
      '--vkui--octavius_color_sidebar_item_text_secondary--hover',
      '--vkui--octavius_color_sidebar_icon_unread',
      '--vkui--octavius_color_sidebar_icon_unread--active',
    ]) {
      expect(renameToken(source), source).toBeNull();
    }
  });

  it('но соседнее семейство, которым пользуется «обойная» тема, на месте', () => {
    // --mt-mail-color-sidebar-item-text нужен: на нём держится белый текст
    // меню поверх фоновой картинки
    expect(renameToken('--vkui--octavius_color_sidebar_item_text')?.name).toBe(
      '--mt-mail-color-sidebar-item-text',
    );
    expect(tokensCss).toContain('--mt-mail-color-sidebar-item-text:');
  });
});

describe('значки не заливаются сплошным цветом', () => {
  /*
   * `.icon svg { fill: currentColor }` в обёртках значков перебивало
   * их собственный `fill="none"` — CSS сильнее презентационного атрибута.
   * Штриховые значки превращались в чёрные кляксы: «Выделить все» на панели
   * над списком был залитым квадратом вместо рамки с галочкой.
   */
  it('ни одна обёртка не задаёт svg общий fill', () => {
    const wrappers = [
      'components/Button/Button.module.css',
      'components/Dropdown/Dropdown.module.css',
      'components/IconButton/IconButton.module.css',
      'layout/AccountMenu.module.css',
      'layout/Sidebar.module.css',
      'mail/MessageThread.module.css',
      'pages/SearchPage.module.css',
      'pages/settings/FoldersPage.module.css',
      'search/SearchFacets.module.css',
      'search/SearchResults.module.css',
    ];
    for (const path of wrappers) {
      const css = read(path);
      expect(css, `${path}: общий fill на svg`).not.toMatch(/^\s*fill:\s*currentColor;/mu);
    }
  });

  it('встроенные значки по-прежнему объявляют fill="none" сами', () => {
    const icons = read('mail/icons.tsx');
    expect(icons).toMatch(/fill="none"[\s\S]*stroke="currentColor"/u);
  });
});
