/**
 * Тесты порядка источников и того, что попадает в кэш.
 *
 * Сеть и DNS подменены: настоящий интернет в проверках сделал бы их
 * зависимыми от того, кто сегодня отвечает и какой у него значок, — то есть
 * они перестали бы что-либо доказывать и начали бы падать по вторникам.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { loadLogoConfig } from './config.js';
import { findLogo, type FindLogoDeps } from './sources.js';
import type { FetchOutcome } from './net.js';
import type { TxtLookup } from './dns.js';

const config = loadLogoConfig({});
const logger = {
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as unknown as Logger;

/** Годная картинка: PNG 128×128. */
function png(): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(16);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(128, 8);
  ihdr.writeUInt32BE(128, 12);
  return Buffer.concat([head, ihdr, Buffer.alloc(16)]);
}

function page(html: string, url: string): FetchOutcome {
  return { url, status: 200, contentType: 'text/html', body: Buffer.from(html, 'utf8') };
}

function image(url: string): FetchOutcome {
  return { url, status: 200, contentType: 'image/png', body: png() };
}

interface Scenario {
  txt?: Record<string, TxtLookup>;
  http?: Record<string, FetchOutcome>;
  /** Ответ по умолчанию на всё, чего нет в http. */
  fallback?: FetchOutcome;
  ai?: string | null;
}

function deps(scenario: Scenario): FindLogoDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    config,
    logger,
    calls,
    dns: async (name) => {
      calls.push(`dns:${name}`);
      return scenario.txt?.[name] ?? { records: [], answered: true };
    },
    fetch: async (url) => {
      calls.push(`http:${url}`);
      if (scenario.http && url in scenario.http) return scenario.http[url] ?? null;
      // Проверка через `in`, а не `??`: null здесь ЗНАЧАЩЕЕ значение
      // («не дозвонились»), и оператор `??` подменял бы его на 'absent'.
      return 'fallback' in scenario ? (scenario.fallback as FetchOutcome) : 'absent';
    },
    ...(scenario.ai === undefined ? {} : { ai: { hint: async () => scenario.ai ?? null } }),
  };
}

test('BIMI отвечает первым — на сайт не идём вовсе', async () => {
  const d = deps({
    txt: {
      'default._bimi.example.com': {
        records: ['v=BIMI1; l=https://example.com/logo.png'],
        answered: true,
      },
    },
    http: { 'https://example.com/logo.png': image('https://example.com/logo.png') },
  });
  const outcome = await findLogo('example.com', d);

  assert.equal(outcome.kind, 'found');
  assert.equal(outcome.kind === 'found' && outcome.logo.source, 'bimi');
  // Два обращения на весь домен: запись DNS и сама картинка.
  assert.equal(outcome.requests, 2);
  assert.equal(d.calls.includes('http:https://example.com/'), false, 'страницу сайта не открывали');
});

test('без BIMI берётся значок сайта', async () => {
  const d = deps({
    http: {
      'https://example.com/': page(
        '<link rel="apple-touch-icon" href="/touch.png">',
        'https://example.com/',
      ),
      'https://example.com/touch.png': image('https://example.com/touch.png'),
    },
  });
  const outcome = await findLogo('example.com', d);
  assert.equal(outcome.kind, 'found');
  assert.equal(outcome.kind === 'found' && outcome.logo.source, 'favicon');
});

test('явный отказ владельца (l= пустое) закрывает и путь через значок сайта', async () => {
  // Владелец сказал «логотипа нет». Лазить после этого по его сайту
  // невежливо и бессмысленно.
  const d = deps({
    txt: { 'default._bimi.example.com': { records: ['v=BIMI1; l='], answered: true } },
    http: {
      'https://example.com/': page('<link rel="icon" href="/i.png">', 'https://example.com/'),
      'https://example.com/i.png': image('https://example.com/i.png'),
    },
  });
  const outcome = await findLogo('example.com', d);
  assert.equal(outcome.kind, 'none');
  assert.equal(
    d.calls.some((c) => c.startsWith('http:')),
    false,
  );
});

test('ИИ спрашивается ПОСЛЕДНИМ и только когда первые два молчат', async () => {
  const d = deps({
    http: { 'https://example.com/logo.svg': image('https://example.com/logo.svg') },
    ai: 'https://example.com/logo.svg',
  });
  const outcome = await findLogo('example.com', d);
  assert.equal(outcome.kind, 'found');
  assert.equal(outcome.kind === 'found' && outcome.logo.source, 'ai');
  // Порядок обращений: сначала DNS, потом сайт, и только потом подсказка.
  assert.equal(d.calls[0], 'dns:default._bimi.example.com');
});

test('ИИ не спрашивается, если логотип уже нашёлся', async () => {
  let asked = false;
  const d = deps({
    txt: {
      'default._bimi.example.com': {
        records: ['v=BIMI1; l=https://example.com/logo.png'],
        answered: true,
      },
    },
    http: { 'https://example.com/logo.png': image('https://example.com/logo.png') },
  });
  d.ai = {
    hint: async () => {
      asked = true;
      return null;
    },
  };
  await findLogo('example.com', d);
  assert.equal(asked, false);
});

test('«ничего нет» и «не дозвонились» — РАЗНЫЕ исходы', async () => {
  // От этого зависит срок в кэше: несуществующий домен помним неделю,
  // лежащий сервер — шесть часов.
  const absent = await findLogo('example.com', deps({ fallback: 'absent' }));
  assert.equal(absent.kind, 'none');

  const failed = await findLogo('example.com', deps({ fallback: null }));
  assert.equal(failed.kind, 'error');
});

test('отказ DNS не превращается в «логотипа нет»', async () => {
  const d = deps({
    txt: { 'default._bimi.example.com': { records: [], answered: false } },
    fallback: 'absent',
  });
  const outcome = await findLogo('example.com', d);
  assert.equal(outcome.kind, 'error');
});

test('у поддомена спрашиваются оба имени, но не больше', async () => {
  const d = deps({ fallback: 'absent' });
  const outcome = await findLogo('news.example.com', d);
  assert.equal(outcome.kind, 'none');
  assert.deepEqual(
    d.calls.filter((c) => c.startsWith('dns:')),
    ['dns:default._bimi.news.example.com', 'dns:default._bimi.example.com'],
  );
  // Предел походов наружу на один домен: сюда входят два запроса DNS,
  // две страницы и по одному запасному /favicon.ico на каждую.
  assert.ok(outcome.requests <= 7, `запросов ${String(outcome.requests)}`);
});

test('негодная картинка по адресу из BIMI не мешает попробовать значок сайта', async () => {
  const d = deps({
    txt: {
      'default._bimi.example.com': {
        records: ['v=BIMI1; l=https://example.com/broken.svg'],
        answered: true,
      },
    },
    http: {
      // По адресу из записи лежит не картинка, а страница.
      'https://example.com/broken.svg': page('<html></html>', 'https://example.com/broken.svg'),
      'https://example.com/': page(
        '<link rel="icon" sizes="128x128" href="/i.png">',
        'https://example.com/',
      ),
      'https://example.com/i.png': image('https://example.com/i.png'),
    },
  });
  const outcome = await findLogo('example.com', d);
  assert.equal(outcome.kind, 'found');
  assert.equal(outcome.kind === 'found' && outcome.logo.source, 'favicon');
});
