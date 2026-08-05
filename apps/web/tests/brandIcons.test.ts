/**
 * Значок «Важное».
 *
 * У mail.ru это красная закладка-лента: на research/mailru/01-inbox.png она
 * занимает 14×13 в колонке флажка (x 561…574, y 1160…1172) и покрашена
 * в rgb(252,44,56). У нас на её месте был красный кружок с восклицательным
 * знаком — совсем другой знак, из другого набора смыслов.
 *
 * Проверяется сам спрайт: и `icon-important` (контурная лента — в меню
 * «Пометить флажком»), и `icon-important-filled` (сплошная — в строке уже
 * помеченного письма).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = dirname(fileURLToPath(import.meta.url));
const sprite = readFileSync(join(WEB, '../public/brand/icons/sprite.svg'), 'utf8');
const iconsTsx = readFileSync(join(WEB, '../src/mail/icons.tsx'), 'utf8');

/** Тело символа спрайта по идентификатору. */
function symbol(id: string): string {
  const at = sprite.indexOf(`<symbol id="${id}"`);
  expect(at, `в спрайте нет символа ${id}`).toBeGreaterThanOrEqual(0);
  return sprite.slice(at, sprite.indexOf('</symbol>', at));
}

describe('«Важное» — закладка-лента, а не кружок с восклицательным знаком', () => {
  it('в контурном значке нет ни одной окружности', () => {
    const body = symbol('icon-important');
    expect(body, 'остался кружок').not.toContain('<circle');
    // Лента: контур сверху вниз с выемкой посередине нижнего края
    expect(body).toMatch(/<path d="M6\.5 4\.5h11/u);
  });

  it('есть и сплошной вариант — им помечается строка письма', () => {
    const body = symbol('icon-important-filled');
    expect(body).toContain('fill="currentColor"');
    expect(body).not.toContain('<circle');
  });

  it('оба значка живут в общей сетке 24×24', () => {
    for (const id of ['icon-important', 'icon-important-filled']) {
      expect(symbol(id)).toContain('viewBox="0 0 24 24"');
    }
  });

  it('строка списка берёт сплошной значок, меню — контурный', () => {
    expect(iconsTsx).toContain("IconFlagFilled = (p: IconProps = {}) => <BrandIcon name=\"important-filled\"");
    const listTsx = readFileSync(join(WEB, '../src/mail/MessageList.tsx'), 'utf8');
    expect(listTsx).toContain('<IconFlagFilled />');
    // В панели и меню «Пометить флажком» — контурная лента
    const toolbarTsx = readFileSync(join(WEB, '../src/mail/ListToolbar.tsx'), 'utf8');
    expect(toolbarTsx).toContain('<IconFlag />');
  });
});
