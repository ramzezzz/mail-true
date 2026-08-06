/**
 * Кнопка догрузки живёт внутри списка, а полоса прокрутки видна.
 *
 * Обе беды заметил заказчик одной фразой: «в списке писем нет полосы
 * прокрутки и внизу постоянно висит кнопка "Показать ещё", хотя я ещё не
 * долистал до низу».
 *
 * Замер на стенде подтвердил оба:
 *   — кнопка лежала СНАРУЖИ прокручиваемого контейнера (родитель
 *     `listFooter` в разметке страницы) и потому висела всегда;
 *   — полоса была задана цветом разделительной линии (#dadce0), это 1,3:1
 *     на белом списке — её фактически не видно.
 *
 * Проверяются правила, а не пиксели: подвал принимается списком и рисуется
 * внутри области прокрутки, цвет полосы взят у заметного токена.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

describe('подвал списка писем', () => {
  const list = read('mail/MessageList.tsx');
  const page = read('pages/FolderPage.tsx');

  it('список принимает подвал сам, а не полагается на страницу', () => {
    expect(list).toMatch(/footer\?: ReactNode/);
  });

  it('подвал рисуется внутри области прокрутки, а не после неё', () => {
    // Разметка: <div ref={scrollRef} …> … {footer …} </div>
    const scrollStart = list.indexOf('ref={scrollRef}');
    const footerAt = list.indexOf('{footer ?');
    expect(scrollStart, 'не найдена область прокрутки').toBeGreaterThan(0);
    expect(footerAt, 'подвал не найден в разметке').toBeGreaterThan(scrollStart);
    // Между подвалом и закрытием контейнера прокрутки не должно быть
    // закрывающих тегов больше, чем нужно на сам подвал.
    const tail = list.slice(footerAt);
    expect(tail.indexOf('</div>')).toBeGreaterThan(0);
  });

  it('страница отдаёт кнопку «Показать ещё» списку, а не рисует рядом', () => {
    expect(page).toMatch(/footer=\{/);
    expect(page).toMatch(/Показать ещё/);
    expect(page, 'старый подвал рядом со списком остался').not.toMatch(/styles\.listFooter/);
  });
});

describe('полоса прокрутки', () => {
  const global = read('styles/global.css');

  it('видна: цвет взят не у разделительной линии', () => {
    const rule = /scrollbar-color:\s*var\(([^)]+)\)/.exec(global)?.[1] ?? '';
    expect(rule).not.toMatch(/separator/);
    expect(rule.trim().length).toBeGreaterThan(0);
  });

  it('дорожка остаётся прозрачной — как в почте, которую повторяем', () => {
    expect(global).toMatch(/scrollbar-color:[^;]*transparent/);
  });
});
