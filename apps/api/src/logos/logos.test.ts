/**
 * Тесты поиска логотипов доменов.
 *
 * Разбиты по источникам и по опасностям. Проверок «отказ» здесь намеренно
 * больше, чем «успех»: цена ошибочно НЕ показанного логотипа — буква в
 * кружке, цена ошибочно показанного — доверие к письму мошенника или
 * чужой код в браузере.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bimiRecordName, isBimiDeclination, parseBimiRecord, pickBimiLocation } from './bimi.js';
import { isPublicSuffix, logoDomainCandidates } from './domain.js';
import { iconCandidates, MAX_ICON_CANDIDATES } from './icons.js';
import { inspectSenderLogo, SENDER_LOGO_MAX_BYTES } from './image.js';
import { isBlockedAddress } from './net.js';
import { sameDomainImageUrl } from './ai.js';
import { isFresh, logoVersion } from './store.js';
import { SenderLogoService } from './service.js';

/* ================================================================== */
/* BIMI                                                                */
/* ================================================================== */

test('BIMI: имя записи — селектор default', () => {
  assert.equal(bimiRecordName('example.com'), 'default._bimi.example.com');
});

test('BIMI: разбирает адрес логотипа и сертификата', () => {
  const rec = parseBimiRecord('v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem');
  assert.equal(rec?.location, 'https://example.com/logo.svg');
  assert.equal(rec?.authority, 'https://example.com/vmc.pem');
});

test('BIMI: запись без v=BIMI1 записью BIMI не считается', () => {
  // На имени `default._bimi.<домен>` может оказаться что угодно, в том числе
  // чужая TXT-запись. Без обязательного тега версии это не наша запись.
  assert.equal(parseBimiRecord('l=https://evil.example/logo.svg'), null);
  assert.equal(parseBimiRecord('v=spf1 -all'), null);
});

test('BIMI: адрес по HTTP отвергается', () => {
  // По открытому каналу картинку подменяет любой, кто сидит на пути,
  // а подменённый логотип — это и есть подделка.
  assert.equal(pickBimiLocation(['v=BIMI1; l=http://example.com/logo.svg']), null);
});

test('BIMI: из нескольких записей берётся первая пригодная', () => {
  const location = pickBimiLocation([
    'v=spf1 include:_spf.example.com ~all',
    'v=BIMI1; l=',
    'v=BIMI1; l=https://example.com/logo.svg',
  ]);
  assert.equal(location, 'https://example.com/logo.svg');
});

test('BIMI: пустое l= — это явный отказ владельца, а не отсутствие записи', () => {
  // Отличать важно: отказ запоминается надолго, «записи нет» — иначе.
  assert.equal(isBimiDeclination(['v=BIMI1; l=']), true);
  assert.equal(isBimiDeclination(['v=BIMI1; l=https://example.com/logo.svg']), false);
  assert.equal(isBimiDeclination([]), false);
});

/* ================================================================== */
/* Какие имена спрашиваем                                              */
/* ================================================================== */

test('домены: у поддомена спрашивается ещё и родитель', () => {
  assert.deepEqual(logoDomainCandidates('mail.sberbank.ru'), ['mail.sberbank.ru', 'sberbank.ru']);
  assert.deepEqual(logoDomainCandidates('example.com'), ['example.com']);
});

test('домены: родитель берётся отбрасыванием ЛЕВОЙ части — подмену это не даёт', () => {
  // У подделки `sberbank.ru.evil.com` родителем оказывается `ru.evil.com`,
  // а никак не настоящий `sberbank.ru`.
  assert.deepEqual(logoDomainCandidates('sberbank.ru.evil.com'), [
    'sberbank.ru.evil.com',
    'ru.evil.com',
  ]);
});

test('домены: до зоны не поднимаемся', () => {
  assert.equal(isPublicSuffix('co.uk'), true);
  assert.equal(isPublicSuffix('com'), true);
  assert.deepEqual(logoDomainCandidates('shop.co.uk'), ['shop.co.uk']);
  assert.deepEqual(logoDomainCandidates('co.uk'), []);
});

/* ================================================================== */
/* Значки сайта                                                        */
/* ================================================================== */

test('значки: apple-touch-icon предпочтительнее мелкого favicon', () => {
  const html = `
    <link rel="icon" sizes="16x16" href="/small.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
  `;
  const urls = iconCandidates(html, 'https://example.com/');
  assert.equal(urls[0], 'https://example.com/touch.png');
});

test('значки: крупный объявленный обходит мелкий', () => {
  const html = `
    <link rel="icon" sizes="16x16" href="/a.png">
    <link rel="icon" sizes="192x192" href="/b.png">
  `;
  const urls = iconCandidates(html, 'https://example.com/');
  assert.equal(urls[0], 'https://example.com/b.png');
});

test('значки: /favicon.ico добавляется последней надеждой', () => {
  const urls = iconCandidates('<html><head></head></html>', 'https://example.com/');
  assert.deepEqual(urls, ['https://example.com/favicon.ico']);
});

test('значки: ссылка по HTTP и data: отбрасываются', () => {
  const html = `
    <link rel="icon" href="http://example.com/insecure.png">
    <link rel="icon" href="data:image/png;base64,AAAA">
  `;
  const urls = iconCandidates(html, 'https://example.com/');
  assert.deepEqual(urls, ['https://example.com/favicon.ico']);
});

test('значки: mask-icon пропускается — в кружке это чёрная клякса', () => {
  const html = '<link rel="mask-icon" href="/mask.svg" color="#000">';
  const urls = iconCandidates(html, 'https://example.com/');
  assert.equal(urls.includes('https://example.com/mask.svg'), false);
});

test('значки: <base href> меняет точку отсчёта относительных ссылок', () => {
  const html = '<base href="https://cdn.example.net/assets/"><link rel="icon" href="i.png">';
  const urls = iconCandidates(html, 'https://example.com/');
  assert.equal(urls[0], 'https://cdn.example.net/assets/i.png');
});

test('значки: число попыток ограничено', () => {
  const html = Array.from(
    { length: 20 },
    (_, i) => `<link rel="icon" sizes="${String(64 + i)}x${String(64 + i)}" href="/i${String(i)}.png">`,
  ).join('');
  assert.equal(iconCandidates(html, 'https://example.com/').length, MAX_ICON_CANDIDATES);
});

/* ================================================================== */
/* Проверка скачанной картинки                                         */
/* ================================================================== */

/** Минимальный корректный заголовок PNG с заданными размерами. */
function png(width: number, height: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(16);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([head, ihdr, Buffer.alloc(16)]);
}

/** Минимальный ICO с одной картинкой заданного размера. */
function ico(side: number): Buffer {
  const buf = Buffer.alloc(6 + 16 + 16);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(1, 4);
  buf[6] = side === 256 ? 0 : side;
  buf[7] = side === 256 ? 0 : side;
  return buf;
}

test('картинка: PNG нормального размера принимается', () => {
  const image = inspectSenderLogo(png(180, 180));
  assert.equal(image?.format, 'png');
  assert.equal(image?.mime, 'image/png');
  assert.equal(image?.width, 180);
});

test('картинка: ICO опознаётся и меряется по самой крупной вложенной', () => {
  const image = inspectSenderLogo(ico(32));
  assert.equal(image?.format, 'ico');
  assert.equal(image?.mime, 'image/x-icon');
  assert.equal(image?.width, 32);
});

test('картинка: SVG со скриптом отвергается целиком', () => {
  // Логотип отдаётся с нашего адреса. SVG — это документ, и открытый
  // отдельной вкладкой он выполнялся бы от НАШЕГО имени.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>fetch("/api/messages")</script></svg>',
    'utf8',
  );
  assert.equal(inspectSenderLogo(svg), null);
});

test('картинка: SVG с обработчиком события отвергается', () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" onload="alert(1)"><rect/></svg>',
    'utf8',
  );
  assert.equal(inspectSenderLogo(svg), null);
});

test('картинка: безобидный SVG принимается', () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30"/></svg>',
    'utf8',
  );
  const image = inspectSenderLogo(svg);
  assert.equal(image?.format, 'svg');
  assert.equal(image?.width, 64);
});

test('картинка: исполняемый файл под видом значка отвергается', () => {
  assert.equal(inspectSenderLogo(Buffer.from('MZ ...', 'latin1')), null);
  assert.equal(inspectSenderLogo(Buffer.from('<?php system($_GET[0]); ?>', 'latin1')), null);
});

test('картинка: слишком мелкое и слишком крупное не годятся', () => {
  assert.equal(inspectSenderLogo(png(8, 8)), null);
  assert.equal(inspectSenderLogo(png(4000, 4000)), null);
});

test('картинка: полоса в круг не вписывается — отказ', () => {
  // Это не значок, а «логотип в шапке» целиком: в кружке он превратится
  // в ниточку поперёк, что хуже честной буквы.
  assert.equal(inspectSenderLogo(png(600, 60)), null, 'широкая полоса');
  assert.equal(inspectSenderLogo(png(60, 600)), null, 'высокая полоса');
  // А умеренно неквадратные проходят: их вписывание в круг выглядит хорошо.
  assert.notEqual(inspectSenderLogo(png(180, 200)), null);
  assert.notEqual(inspectSenderLogo(png(240, 100)), null);
});

test('картинка: пустой ответ и превышение предела размера отвергаются', () => {
  assert.equal(inspectSenderLogo(Buffer.alloc(0)), null);
  assert.equal(inspectSenderLogo(Buffer.alloc(SENDER_LOGO_MAX_BYTES + 1)), null);
});

/* ================================================================== */
/* Куда серверу ходить нельзя (SSRF)                                   */
/* ================================================================== */

test('сеть: петля, частные сети и метаданные облака закрыты', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.28.0.5', // сеть нашего docker-стека
    '192.168.1.1',
    '169.254.169.254', // адрес метаданных в облаках
    '0.0.0.0',
    '100.64.0.1',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test('сеть: петля, записанная как IPv6, закрыта тоже', () => {
  // Без разбора формы `::ffff:` запрет обходился бы сменой записи адреса.
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('fd00::1'), true);
  assert.equal(isBlockedAddress('fe80::1'), true);
});

test('сеть: обычные адреса разрешены', () => {
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('сеть: неразобранный адрес считается запрещённым', () => {
  // Сомнение здесь толкуется не в пользу запроса.
  assert.equal(isBlockedAddress('не адрес'), true);
  assert.equal(isBlockedAddress(''), true);
});

/* ================================================================== */
/* Подсказка помощника ИИ                                              */
/* ================================================================== */

test('ИИ: адрес внутри того же домена принимается', () => {
  assert.equal(
    sameDomainImageUrl('https://cdn.example.com/static/logo.png', 'example.com'),
    'https://cdn.example.com/static/logo.png',
  );
});

test('ИИ: адрес на ЧУЖОМ домене отбрасывается', () => {
  /*
   * Главное ограничение источника. Модель на вопрос про домен подделки
   * охотно называет настоящий банк — и без этой проверки его логотип встал
   * бы в кружок рядом с письмом мошенника.
   */
  assert.equal(sameDomainImageUrl('https://sberbank.ru/logo.svg', 'sberbank-security.xyz'), null);
  assert.equal(sameDomainImageUrl('https://example.com.evil.net/logo.png', 'example.com'), null);
});

test('ИИ: «НЕТ» и болтовня без адреса ничего не дают', () => {
  assert.equal(sameDomainImageUrl('НЕТ', 'example.com'), null);
  assert.equal(sameDomainImageUrl('Логотип этой компании — синяя буква S.', 'example.com'), null);
});

test('ИИ: адрес по HTTP отбрасывается', () => {
  assert.equal(sameDomainImageUrl('http://example.com/logo.png', 'example.com'), null);
});

/* ================================================================== */
/* Кэш                                                                 */
/* ================================================================== */

test('кэш: отпечаток меняется вместе с картинкой', () => {
  const a = logoVersion('example.com', Buffer.from('AAA'));
  const b = logoVersion('example.com', Buffer.from('BBB'));
  assert.notEqual(a, b);
  assert.equal(a, logoVersion('example.com', Buffer.from('AAA')));
});

test('кэш: отрицательный ответ тоже имеет отпечаток', () => {
  assert.equal(typeof logoVersion('example.com', null), 'string');
});

test('кэш: срок годности решает, свежая ли запись', () => {
  const base = {
    domain: 'example.com',
    source: null,
    mime: null,
    bytes: null,
    width: null,
    height: null,
    version: 'v',
  };
  assert.equal(isFresh({ ...base, expiresAt: new Date(Date.now() + 1000) }), true);
  assert.equal(isFresh({ ...base, expiresAt: new Date(Date.now() - 1000) }), false);
});

/* ================================================================== */
/* Разбор списка доменов из запроса                                    */
/* ================================================================== */

test('запрос: домены приводятся к одному виду и не повторяются', () => {
  const domains = SenderLogoService.normalizeDomains([
    'Example.COM',
    'example.com.',
    'example.com',
    'mail.example.com',
  ]);
  assert.deepEqual(domains, ['example.com', 'mail.example.com']);
});

test('запрос: мусор отбрасывается молча', () => {
  // Список приходит из чужих заголовков писем — там бывает что угодно.
  const domains = SenderLogoService.normalizeDomains([
    null,
    42,
    '',
    'localhost',
    '../../etc/passwd',
    '[192.0.2.1]',
    'ok.example',
  ]);
  assert.deepEqual(domains, ['ok.example']);
});

test('запрос: число доменов в одном ответе ограничено', () => {
  const many = Array.from({ length: 200 }, (_, i) => `d${String(i)}.example`);
  assert.equal(SenderLogoService.normalizeDomains(many).length, 60);
});

/* ================================================================== */
/* Ручная картинка администратора                                      */
/* ================================================================== */

test('ручная картинка проверяется ТЕМ ЖЕ модулем, что логотип входа', async () => {
  /*
   * Второй проверки картинок в продукте быть не должно: разбор SVG защищает
   * от чужого кода, и его копия однажды разойдётся с оригиналом — причём
   * разойдётся в опасную сторону. Здесь проверяется, что для кружка меняются
   * ЧИСЛА, а не модуль.
   */
  const { inspectLogo } = await import('../admin/branding-image.js');
  const { MANUAL_LOGO_LIMITS } = await import('./admin.js');

  // 16×16 — обычный размер значка сайта. Для страницы входа он слишком мал
  // (нижняя граница 32×16), а для кружка 32 точки это норма.
  const small = png16();
  assert.throws(() => inspectLogo(small), /слишком мало/u);
  assert.equal(inspectLogo(small, MANUAL_LOGO_LIMITS).width, 16);

  // А вот разбор SVG остаётся общим и с другими пределами не смягчается.
  const dangerous = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>x()</script></svg>',
    'utf8',
  );
  assert.throws(() => inspectLogo(dangerous, MANUAL_LOGO_LIMITS), /script/iu);
});

/** PNG 16×16 — размер обычного значка сайта. */
function png16(): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(16);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(16, 8);
  ihdr.writeUInt32BE(16, 12);
  return Buffer.concat([head, ihdr, Buffer.alloc(16)]);
}
