/**
 * Набор фоновых картинок: файлы на месте, вес в рамках, лицензии записаны.
 *
 * Заказчик попросил «реальные картинки, а не просто градиент» и отдельно
 * оговорил условия, которые нельзя проверить глазами и легко нарушить
 * следующей правкой:
 *
 *   * каждая картинка обязана иметь запись в перечне источников — файлы
 *     уезжают в поставку, и картинка без указанного происхождения
 *     означает, что отвечать за неё будет некому;
 *   * набор не должен раздувать поставку (ориентир — 6–8 МБ);
 *   * страница оформления не должна тянуть полноразмерные файлы ради
 *     двух десятков плиток.
 *
 * Всё это проверяется по РЕАЛЬНЫМ файлам на диске, а не по списку в коде:
 * иначе разойтись они смогут молча — реестр обещает картинку, которой нет,
 * и человек выбирает пустой фон.
 *
 * На старом коде падает всё: фотографий не было вовсе.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WALLPAPER_GROUPS,
  WALLPAPER_PRESETS,
  type WallpaperPreset,
} from '../src/appearance/wallpapers';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(WEB, 'public/wallpapers');
const SOURCES = readFileSync(join(WEB, '../../docs/wallpapers-sources.md'), 'utf8');

/** Фоны-фотографии: у них css ссылается на файл, а не на градиент. */
const photos: WallpaperPreset[] = WALLPAPER_PRESETS.filter((p) => p.css.includes('url('));
const drawn = WALLPAPER_PRESETS.filter((p) => !p.css.includes('url('));

const size = (name: string): number => statSync(join(PUBLIC, name)).size;

describe('состав набора', () => {
  it('фотографий два десятка, разложены по настроениям', () => {
    expect(photos.length).toBeGreaterThanOrEqual(20);
    const groups = new Set(photos.map((p) => p.group));
    // пять групп, названных заказчиком: цветы, абстракция, города, море, техника
    expect(groups.size).toBeGreaterThanOrEqual(5);
    for (const group of groups) {
      const inGroup = photos.filter((p) => p.group === group);
      expect(inGroup.length, `в группе ${group} меньше трёх картинок`).toBeGreaterThanOrEqual(3);
    }
  });

  it('у каждой группы есть название, у каждого фона — существующая группа', () => {
    const known = new Set(WALLPAPER_GROUPS.map((g) => g.id));
    for (const g of WALLPAPER_GROUPS) expect(g.title).toBeTruthy();
    for (const p of WALLPAPER_PRESETS) expect(known.has(p.group)).toBe(true);
  });

  it('названия по-русски и по-человечески, а не wallpaper-07', () => {
    for (const p of WALLPAPER_PRESETS) {
      expect(p.title, `${p.id}: имя не по-русски`).toMatch(/^[А-ЯЁ][А-Яа-яЁё\s-]+$/u);
      expect(p.title).not.toMatch(/\d/u);
    }
  });

  it('простые фоны кодом никуда не делись — они ничего не весят', () => {
    expect(drawn.length).toBeGreaterThanOrEqual(6);
  });
});

describe('файлы на диске', () => {
  it('каждой фотографии соответствуют файл и отдельная миниатюра', () => {
    for (const p of photos) {
      expect(() => size(`${p.id}.webp`), `нет файла ${p.id}.webp`).not.toThrow();
      expect(() => size(`${p.id}-thumb.webp`), `нет миниатюры ${p.id}`).not.toThrow();
      // плитка обязана брать МИНИАТЮРУ: иначе открытие раздела «Оформление»
      // тянет два десятка полноразмерных картинок
      expect(p.thumb).toContain(`${p.id}-thumb.webp`);
      expect(p.thumb).not.toMatch(new RegExp(`/${p.id}\\.webp`, 'u'));
    }
  });

  it('миниатюра во много раз легче полного файла', () => {
    for (const p of photos) {
      expect(size(`${p.id}-thumb.webp`)).toBeLessThan(size(`${p.id}.webp`));
    }
    const thumbs = photos.reduce((sum, p) => sum + size(`${p.id}-thumb.webp`), 0);
    const full = photos.reduce((sum, p) => sum + size(`${p.id}.webp`), 0);
    // весь набор плиток должен быть дешевле одной полноразмерной картинки
    // в среднем — иначе смысла в миниатюрах нет
    expect(thumbs).toBeLessThan(full / 5);
  });

  it('весь набор укладывается в 8 МБ поставки', () => {
    const total = photos.reduce(
      (sum, p) => sum + size(`${p.id}.webp`) + size(`${p.id}-thumb.webp`),
      0,
    );
    expect(total).toBeLessThan(8 * 1024 * 1024);
  });

  it('файлы — webp, а не спрятанный jpeg', () => {
    for (const p of photos) {
      const head = readFileSync(join(PUBLIC, `${p.id}.webp`)).subarray(0, 12);
      expect(head.subarray(0, 4).toString('latin1'), `${p.id}: не RIFF`).toBe('RIFF');
      expect(head.subarray(8, 12).toString('latin1'), `${p.id}: не WEBP`).toBe('WEBP');
    }
  });
});

describe('перечень источников', () => {
  /*
   * Без перечня работа не принимается: через полгода никто не вспомнит,
   * откуда взялась картинка, а отвечать за неё будет владелец установки.
   */
  it('каждая картинка названа в docs/wallpapers-sources.md', () => {
    for (const p of photos) {
      expect(SOURCES, `${p.id} нет в перечне источников`).toContain(`${p.id}.webp`);
      expect(SOURCES, `${p.id}: нет русского названия в перечне`).toContain(p.title);
    }
  });

  it('у каждой записи названы автор, источник и лицензия', () => {
    for (const p of photos) {
      const at = SOURCES.indexOf(`\`${p.id}.webp\``);
      expect(at, `${p.id}: нет записи в перечне`).toBeGreaterThanOrEqual(0);
      // Запись — это абзац от заголовка картинки до следующего пустого
      // блока; берём с запасом и проверяем обязательные строки.
      const block = SOURCES.slice(at, at + 700);
      expect(block, `${p.id}: не назван автор`).toContain('Автор:');
      expect(block, `${p.id}: нет ссылки на источник`).toContain('https://commons.wikimedia.org/');
      expect(block, `${p.id}: не названа лицензия`).toMatch(/Лицензия: (CC0|Public domain)/u);
      expect(block, `${p.id}: не указана дата загрузки`).toMatch(/Загружено: \d{4}-\d{2}-\d{2}/u);
    }
  });

  it('в наборе нет лицензий, требующих оплаты или запрещающих продукт', () => {
    // Всё, что не CC0 и не public domain, в поставку не идёт
    expect(SOURCES).not.toMatch(/Лицензия: CC BY-NC/u);
    expect(SOURCES).not.toMatch(/Лицензия: CC BY-ND/u);
    expect(SOURCES).not.toMatch(/Лицензия: (?!CC0|Public domain)/u);
  });
});
