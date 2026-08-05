/**
 * Блокировка внешних картинок — против НАСТОЯЩЕГО ответа API.
 *
 * Эталон снят с живого сервера (`GET /api/messages/inbox:209`):
 *
 *   blockedRemote: 3
 *   <img src="data:image/gif;base64,R0lGODlh…" data-mt-src="http://tracker.example.com/pixel.gif?u=1">
 *
 * Прежняя реализация искала в теле `src="http…"`, которого в этом ответе нет
 * вовсе: счётчик всегда выходил нулевым, плашка «Показать картинки» не
 * появлялась никогда. Тесты ниже написаны так, чтобы падать именно на этом.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCKED_PIXEL,
  blockRemoteImages,
  blockedImageCount,
  countBlockedImages,
  shouldOfferImages,
} from '../src/lib/externalImages';

/** Кусок настоящего ответа сервера. */
const SERVER_BODY =
  '<p>Test message with external images:</p>\n' +
  `<img src="${BLOCKED_PIXEL}" data-mt-src="http://tracker.example.com/pixel.gif?u=1">\n` +
  `<img src="${BLOCKED_PIXEL}" data-mt-src="https://cdn.example.com/banner.png">\n` +
  '<p style="background:none">background</p>';

describe('countBlockedImages', () => {
  it('считает картинки, заблокированные сервером (data-mt-src)', () => {
    expect(countBlockedImages(SERVER_BODY)).toBe(2);
  });

  it('в теле без заблокированных картинок — ноль', () => {
    expect(countBlockedImages('<p>просто текст</p><img src="cid:abc">')).toBe(0);
    expect(countBlockedImages(null)).toBe(0);
  });
});

describe('blockedImageCount', () => {
  it('верит счётчику сервера: он считает и картинки, и фоны в CSS', () => {
    // В живом письме blockedRemote = 3, а тегов <img> только два:
    // третья блокировка — url(...) в атрибуте style.
    expect(blockedImageCount({ bodyHtml: SERVER_BODY, blockedRemote: 3 })).toBe(3);
  });

  it('без счётчика считает по разметке', () => {
    expect(blockedImageCount({ bodyHtml: SERVER_BODY })).toBe(2);
  });

  it('письма нет — нечего и блокировать', () => {
    expect(blockedImageCount(null)).toBe(0);
  });
});

describe('shouldOfferImages', () => {
  it('плашка появляется на настоящем ответе сервера', () => {
    expect(shouldOfferImages({ bodyHtml: SERVER_BODY, blockedRemote: 3 }, false)).toBe(true);
  });

  it('после запроса с ?images=1 плашки нет: сервер вернул blockedRemote: 0', () => {
    const withImages = {
      bodyHtml: '<img src="http://tracker.example.com/pixel.gif?u=1">',
      blockedRemote: 0,
    };
    expect(shouldOfferImages(withImages, true)).toBe(false);
    // и даже если бы флаг не переключили — блокировать нечего
    expect(shouldOfferImages(withImages, false)).toBe(false);
  });

  it('в письме без внешних картинок плашки нет', () => {
    expect(shouldOfferImages({ bodyHtml: '<p>текст</p>', blockedRemote: 0 }, false)).toBe(false);
  });
});

describe('blockRemoteImages (повторяет сервер — для заглушек)', () => {
  it('переносит адрес в data-mt-src и ставит прозрачный пиксель', () => {
    const { html, blockedRemote } = blockRemoteImages(
      '<p><img src="https://evil.example/pixel.png" alt="x"></p>',
    );
    expect(blockedRemote).toBe(1);
    expect(html).toContain(`src="${BLOCKED_PIXEL}"`);
    expect(html).toContain('data-mt-src="https://evil.example/pixel.png"');
    // именно атрибута src с сетевым адресом остаться не должно
    expect(html).not.toMatch(/\ssrc="https?:/i);
  });

  it('блокирует http, протокол-относительные ссылки и фоны в CSS', () => {
    const { blockedRemote } = blockRemoteImages(
      '<img src="http://a.example/1.png"><img src="//b.example/2.png">' +
        '<p style="background:url(\'http://tracker/bg.png\')">фон</p>',
    );
    expect(blockedRemote).toBe(3);
  });

  it('не трогает встроенные и относительные картинки', () => {
    const source =
      '<img src="cid:abc123"><img src="data:image/png;base64,AAAA"><img src="/api/attachments/1">';
    const { html, blockedRemote } = blockRemoteImages(source);
    expect(blockedRemote).toBe(0);
    expect(html).toBe(source);
  });

  it('сохраняет остальные атрибуты тега', () => {
    const { html } = blockRemoteImages(
      '<img width="560" height="180" src="https://x.example/b.jpg" alt="Баннер">',
    );
    expect(html).toContain('width="560"');
    expect(html).toContain('alt="Баннер"');
  });

  it('результат читается тем же счётчиком, что и ответ сервера', () => {
    const blocked = blockRemoteImages('<img src="https://x.example/1.png">');
    expect(countBlockedImages(blocked.html)).toBe(blocked.blockedRemote);
  });
});
