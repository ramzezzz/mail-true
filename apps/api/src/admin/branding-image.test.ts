/**
 * Проверка файла логотипа (OEM).
 *
 * Каждая проверка здесь закрывает конкретное требование заказчика или
 * конкретный способ навредить, и падает на коде без branding-image.ts:
 *
 *   1. Логотип берётся из файла, который приносит человек, а отдаётся
 *      НЕАУТЕНТИФИЦИРОВАННЫМ на странице входа. Значит «картинка это или
 *      нет» решается по содержимому, а не по имени файла и не по
 *      Content-Type: и то, и другое пишет клиент.
 *   2. Исполняемое содержимое под видом картинки обязано отбиваться.
 *   3. SVG — это документ, а не картинка: скрипт внутри него выполнится
 *      у того, кто откроет файл по прямому адресу.
 *   4. Отказ обязан называть причину и предел. «Некорректный запрос» на
 *      попытку загрузить фотографию с телефона не говорит ничего.
 */
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { BadRequestError } from '../errors.js';
import {
  humanBytes,
  inspectLogo,
  LOGO_MAX_BYTES,
  LOGO_MAX_HEIGHT,
  LOGO_MAX_WIDTH,
} from './branding-image.js';

/* ------------------------------------------------------------------ */
/* Заготовки файлов                                                     */
/* ------------------------------------------------------------------ */

/** Настоящий PNG нужного размера: одна серая строка на всю картинку. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    // Контрольная сумма нам не важна: проверка читает только размеры,
    // а браузер на живом стенде получает файл, собранный тем же способом.
    const crc = Buffer.alloc(4);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // глубина
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3), 0x80);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2); // длина секции
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function makeGif(width: number, height: number): Buffer {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head;
}

function makeWebp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

const svg = (inner: string, attrs = 'viewBox="0 0 200 40" width="200" height="40"'): Buffer =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`, 'utf8');

/** Сообщение отказа: тексты обязаны быть содержательными, поэтому проверяем их. */
function refusal(bytes: Buffer): string {
  try {
    inspectLogo(bytes);
  } catch (err) {
    assert.ok(err instanceof BadRequestError, 'отказ обязан быть 400, а не 500');
    return err.message;
  }
  assert.fail('файл должен был быть отклонён');
}

/* ------------------------------------------------------------------ */
/* Что принимаем                                                        */
/* ------------------------------------------------------------------ */

test('настоящие картинки принимаются, размеры читаются из самого файла', () => {
  const png = inspectLogo(makePng(200, 40));
  assert.equal(png.format, 'png');
  assert.equal(png.mime, 'image/png');
  assert.equal(png.ext, 'png');
  assert.deepEqual([png.width, png.height], [200, 40]);

  const jpeg = inspectLogo(makeJpeg(320, 64));
  assert.equal(jpeg.format, 'jpeg');
  assert.deepEqual([jpeg.width, jpeg.height], [320, 64]);

  const gif = inspectLogo(makeGif(120, 40));
  assert.equal(gif.format, 'gif');
  assert.deepEqual([gif.width, gif.height], [120, 40]);

  const webp = inspectLogo(makeWebp(300, 100));
  assert.equal(webp.format, 'webp');
  assert.deepEqual([webp.width, webp.height], [300, 100]);

  const vector = inspectLogo(svg('<rect width="200" height="40" fill="#006EC6"/>'));
  assert.equal(vector.format, 'svg');
  assert.equal(vector.mime, 'image/svg+xml');
  assert.deepEqual([vector.width, vector.height], [200, 40]);
});

test('SVG без width/height меряется по viewBox', () => {
  const info = inspectLogo(svg('<rect width="10" height="10"/>', 'viewBox="0 0 186 32"'));
  assert.deepEqual([info.width, info.height], [186, 32]);
});

/* ------------------------------------------------------------------ */
/* Исполняемое под видом картинки                                       */
/* ------------------------------------------------------------------ */

test('исполняемый файл, названный картинкой, отбивается и называется своим именем', () => {
  // Имя файла в проверке не участвует вовсе: сюда приходят только байты.
  assert.match(refusal(Buffer.from('MZ\x90\x00\x03', 'latin1')), /исполняемый файл Windows/u);
  assert.match(
    refusal(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])),
    /исполняемый файл Linux/u,
  );
  assert.match(refusal(Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8')), /сценарий оболочки/u);
  assert.match(refusal(Buffer.from('<?php system($_GET["c"]); ?>', 'utf8')), /сценарий PHP/u);
  assert.match(refusal(Buffer.from('PK\x03\x04', 'latin1')), /архив ZIP/u);
});

test('произвольный мусор отклоняется с объяснением, что важно содержимое', () => {
  const message = refusal(Buffer.from('это просто текст, а не картинка', 'utf8'));
  assert.match(message, /не опознан как картинка/u);
  assert.match(message, /Расширение файла здесь не/u);
});

test('пустой файл отклоняется отдельным текстом, а не «не опознан»', () => {
  assert.match(refusal(Buffer.alloc(0)), /пустой/u);
});

/* ------------------------------------------------------------------ */
/* SVG: документ, а не картинка                                         */
/* ------------------------------------------------------------------ */

test('SVG со скриптом отбивается', () => {
  const message = refusal(svg('<script>fetch("/api/admin/users")</script>'));
  assert.match(message, /<script>/u);
  assert.match(message, /выполнять код/u);
});

test('SVG с обработчиком события отбивается — скрипт бывает и без тега', () => {
  assert.match(refusal(svg('<rect width="10" height="10" onload="alert(1)"/>')), /обработчик события/u);
  assert.match(refusal(svg('<a href="javascript:alert(1)"><rect/></a>')), /javascript:/u);
});

test('SVG со встроенным HTML (foreignObject) отбивается', () => {
  assert.match(refusal(svg('<foreignObject><body>привет</body></foreignObject>')), /foreignObject/u);
});

test('SVG с внешней сущностью отбивается: это чтение файлов сервера', () => {
  const xxe = Buffer.from(
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">&x;</svg>',
    'utf8',
  );
  assert.match(refusal(xxe), /ENTITY/u);
});

test('SVG, тянущий картинку с чужого сервера, отбивается', () => {
  const message = refusal(svg('<image href="https://example.org/logo.png" width="100" height="40"/>'));
  assert.match(message, /сторонний сервер/u);
});

test('обычный фирменный SVG проходит: запреты не задевают честные файлы', () => {
  const real = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 186 32" width="186" height="32" ' +
      'role="img" aria-label="Компания"><title>Компания</title>' +
      '<path fill="#006EC6" d="M3 0 H6.8 A2.2 2.2 0 0 0 11.2 0Z"/></svg>',
    'utf8',
  );
  const info = inspectLogo(real);
  assert.equal(info.format, 'svg');
});

/* ------------------------------------------------------------------ */
/* Пределы — с внятным отказом                                          */
/* ------------------------------------------------------------------ */

test('слишком большой файл: в отказе назван и его размер, и предел', () => {
  const big = Buffer.concat([makePng(200, 40), Buffer.alloc(LOGO_MAX_BYTES)]);
  const message = refusal(big);
  assert.match(message, /МБ|КБ/u);
  assert.ok(message.includes(humanBytes(LOGO_MAX_BYTES)), 'предел обязан быть назван');
  assert.doesNotMatch(message, /^Некорректный запрос/u);
});

test('фотография с телефона отклоняется с указанием обоих размеров', () => {
  const message = refusal(makePng(4032, 3024));
  assert.match(message, /4032×3024/u);
  assert.ok(message.includes(`${LOGO_MAX_WIDTH}×${LOGO_MAX_HEIGHT}`));
  assert.match(message, /фотография|исходник/u);
});

test('favicon вместо логотипа отклоняется: на входе он превратится в пятно', () => {
  const message = refusal(makePng(16, 16));
  assert.match(message, /16×16/u);
  assert.match(message, /слишком мало/u);
});

test('картинка ровно по пределу проходит', () => {
  const info = inspectLogo(makePng(LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT));
  assert.deepEqual([info.width, info.height], [LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT]);
});

test('humanBytes пишет по-человечески', () => {
  assert.equal(humanBytes(512 * 1024), '512 КБ');
  assert.equal(humanBytes(3 * 1024 * 1024), '3.0 МБ');
  assert.equal(humanBytes(900), '900 Б');
});
