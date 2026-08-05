/**
 * Гамма входа в панель управления: контраст и непохожесть на почту.
 *
 * Числа считаются здесь, а не переписываются из отчёта: цвет в палитре
 * поменяют — проверка сама скажет, если читаемость просела.
 */
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, hexToRgb } from '../src/appearance/contrast';
import {
  DOT_ALPHA,
  LOGIN_PALETTE as P,
  NODE_SURFACE_ALPHA,
  dotRgbChannels,
  paletteVars,
} from '../src/pages/login/loginPalette';

/** Порог WCAG AA для обычного текста. */
const TEXT = 4.5;
/** Порог WCAG AA для крупного текста, значков и прочей графики. */
const LARGE = 3;

describe('контраст текста', () => {
  it('подвал читается поверх тёмного фона в любой его точке', () => {
    expect(contrastRatio(P.footer, P.bgCenter)).toBeGreaterThanOrEqual(TEXT);
    expect(contrastRatio(P.footer, P.bgMiddle)).toBeGreaterThanOrEqual(TEXT);
    expect(contrastRatio(P.footer, P.bgEdge)).toBeGreaterThanOrEqual(TEXT);
  });

  it('белая надпись на кнопке входа читается во всех её состояниях', () => {
    expect(contrastRatio('#ffffff', P.accent)).toBeGreaterThanOrEqual(TEXT);
    expect(contrastRatio('#ffffff', P.accentHover)).toBeGreaterThanOrEqual(TEXT);
    expect(contrastRatio('#ffffff', P.accentPress)).toBeGreaterThanOrEqual(TEXT);
  });

  it('текст карточки читается на белом — и основной, и приглушённый', () => {
    expect(contrastRatio(P.ink, P.card)).toBeGreaterThanOrEqual(TEXT);
    expect(contrastRatio(P.inkMuted, P.card)).toBeGreaterThanOrEqual(TEXT);
  });

  it('сообщение об отказе читается на своей подложке', () => {
    expect(contrastRatio(P.danger, P.dangerSurface)).toBeGreaterThanOrEqual(TEXT);
  });
});

describe('контраст значков и графики', () => {
  it('значок в узле глобуса виден на полупрозрачном кружке', () => {
    // Кружок узла полупрозрачен: считаем по тому цвету, который видит глаз.
    const surface = composite(P.nodeSurface, NODE_SURFACE_ALPHA, P.bgCenter);
    expect(contrastRatio(P.nodeIcon, surface)).toBeGreaterThanOrEqual(LARGE);
  });

  it('точки созвездия видны на фоне даже с их прозрачностью', () => {
    const dot = composite(P.dot, DOT_ALPHA, P.bgMiddle);
    expect(contrastRatio(dot, P.bgMiddle)).toBeGreaterThanOrEqual(LARGE);
  });

  it('обводка фокуса заметна на белой карточке', () => {
    expect(contrastRatio(P.accent, P.card)).toBeGreaterThanOrEqual(LARGE);
  });
});

describe('гамма не почтовая', () => {
  /** Фирменный синий почты. Гамма панели обязана от него уходить. */
  const MAIL_BLUE = '#006ec6';

  it('акцент — не синий почты и не его оттенок', () => {
    const accent = hexToRgb(P.accent);
    const blue = hexToRgb(MAIL_BLUE);
    // У синего почты синий канал заметно выше зелёного; у бирюзы панели
    // зелёный и синий рядом — это и отличает её на глаз.
    expect(blue.b - blue.g).toBeGreaterThan(50);
    expect(Math.abs(accent.b - accent.g)).toBeLessThan(30);
    expect(contrastRatio(P.accent, MAIL_BLUE)).toBeGreaterThan(1.2);
  });

  it('фон страницы не синий: красный канал не ниже синего более чем немного', () => {
    for (const hex of [P.bgCenter, P.bgMiddle, P.bgEdge]) {
      const c = hexToRgb(hex);
      // Синева фона почты держится на большом перевесе синего канала.
      expect(c.b - c.r).toBeLessThan(30);
    }
  });
});

describe('палитра доезжает до разметки', () => {
  it('подменяет фирменный акцент, чтобы кнопка входа была не синей', () => {
    const vars = paletteVars();
    expect(vars['--mt-color-background-accent']).toBe(P.accent);
    expect(vars['--mt-focus-ring-color']).toBe(P.accent);
  });

  it('отдаёт цвет точек каналами — холст рисует не по hex', () => {
    expect(dotRgbChannels()).toBe('143,179,189');
  });
});
