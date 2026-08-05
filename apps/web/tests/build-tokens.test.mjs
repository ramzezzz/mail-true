/**
 * Тесты генератора токенов: правила переименования, фильтрация мусора,
 * переписывание var()-ссылок и валидность сгенерированного tokens.css.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCss, renameToken, rewriteValue, selectTokens } from '../scripts/build-tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('renameToken', () => {
  it('переводит семантические цвета VKUI в --mt-color-*', () => {
    expect(renameToken('--vkui--color_text_primary')).toEqual({
      name: '--mt-color-text-primary',
      group: 'color',
    });
  });

  it('различает состояния: --active (нажатие) → -press, а _active остаётся -active', () => {
    expect(renameToken('--vkui--octavius_color_sidebar_item_text--active')?.name).toBe(
      '--mt-mail-color-sidebar-item-text-press',
    );
    expect(renameToken('--vkui--octavius_color_sidebar_item_text_active')?.name).toBe(
      '--mt-mail-color-sidebar-item-text-active',
    );
  });

  it('разворачивает составные шрифтовые токены и отбрасывает compact-режим', () => {
    expect(renameToken('--vkui--font_caption1--font_size--regular')?.name).toBe(
      '--mt-font-caption1-size',
    );
    expect(renameToken('--vkui--font_headline--font_size--compact')).toBeNull();
  });

  it('срезает суффикс --regular у размеров', () => {
    expect(renameToken('--vkui--size_border_radius--regular')?.name).toBe(
      '--mt-size-border-radius',
    );
  });

  it('отбрасывает мусор: палитры, теги, соцсети, рекламу, внутренности VKUI', () => {
    for (const junk of [
      '--vkui--color_palette_orange1',
      '--vkui--color_tag_background_main_sky--hover',
      '--vkui--color_social_vk',
      '--vkui--octavius_color_list_letter_adv_background',
      '--vkui_internal--z_index_modal',
      '--ph-custom-color-social-vk',
      '--logo-url',
    ]) {
      expect(renameToken(junk), junk).toBeNull();
    }
  });

  it('портальную шапку --ph-* префиксует как --mt-ph-*', () => {
    expect(renameToken('--ph-color-text-primary')?.name).toBe('--mt-ph-color-text-primary');
  });
});

describe('rewriteValue', () => {
  it('переписывает известные var()-ссылки и не трогает неизвестные', () => {
    const mapping = new Map([['--vkui--color_text_primary', '--mt-color-text-primary']]);
    expect(rewriteValue('var(--vkui--color_text_primary, #000)', mapping)).toBe(
      'var(--mt-color-text-primary, #000)',
    );
    expect(rewriteValue('var(--unknown-var)', mapping)).toBe('var(--unknown-var)');
  });
});

describe('selectTokens + generateCss', () => {
  it('собирает валидный CSS без коллизий', () => {
    const { tokens, collisions } = selectTokens({
      '--vkui--color_text_primary': '#2C2D2E',
      '--vkui--color_palette_orange1': '#ff8b2e',
      '--vkui--octavius_color_icon_unread': 'var(--vkui--color_text_primary)',
    });
    expect(collisions).toEqual([]);
    expect(tokens.size).toBe(2);
    const css = generateCss(tokens);
    expect(css).toContain(':root {');
    expect(css).toContain('--mt-color-text-primary: #2C2D2E;');
    // ссылка внутри значения переписана на новое имя
    expect(css).toContain('--mt-mail-color-icon-unread: var(--mt-color-text-primary);');
  });
});

describe('сгенерированный src/styles/tokens.css', () => {
  const css = readFileSync(join(HERE, '../src/styles/tokens.css'), 'utf8');
  const map = JSON.parse(readFileSync(join(HERE, '../src/styles/tokens.map.json'), 'utf8'));

  it('содержит ключевые переменные дизайн-системы', () => {
    for (const expected of [
      '--mt-color-text-primary: #2C2D2E;',
      '--mt-color-background-accent: #0077FF;',
      '--mt-mail-color-icon-unread: #0077FF;',
      '--mt-mail-color-list-letter-background-hover: #f5f5f7;',
      '--mt-size-border-radius: 8px;',
      '--mt-font-paragraph-size: 15px;',
      '--mt-layout-header-height: 62px;',
    ]) {
      expect(css, expected).toContain(expected);
    }
  });

  it('не содержит мусора и исходных имён', () => {
    expect(css).not.toMatch(/--vkui--color_palette/);
    expect(css).not.toMatch(/color-tag-/);
    expect(css).not.toMatch(/-adv-/);
    // все объявления — в нашем пространстве имён
    for (const line of css.split('\n')) {
      const m = line.match(/^\s{2}(--[\w-]+):/);
      if (m) expect(m[1].startsWith('--mt-'), m[1]).toBe(true);
    }
  });

  it('синтаксически корректен: скобки сбалансированы, у каждого объявления есть значение', () => {
    expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
    for (const line of css.split('\n')) {
      const m = line.match(/^\s{2}--[\w-]+:\s*(.+);$/);
      if (m) expect(m[1].trim().length, line).toBeGreaterThan(0);
    }
  });

  it('карта соответствия покрывает все объявленные токены', () => {
    const declared = [...css.matchAll(/^\s{2}(--mt-[\w-]+):/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(1000);
    for (const name of declared) {
      expect(map[name], name).toBeTruthy();
    }
  });
});
