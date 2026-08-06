/**
 * Значки для уведомлений операционной системы.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ОТДЕЛЬНЫЕ ФАЙЛЫ, ЕСЛИ ЗНАК БРЕНДА УЖЕ ЕСТЬ
 * ------------------------------------------------------------------
 * Знак лежит в brand/mark.svg, и поставить его в уведомление нельзя:
 * Chrome не рисует SVG в полях `icon` и `badge` вовсе — уведомление
 * выходит без значка, молча. Нужен растр.
 *
 * Отсюда два файла:
 *   notification-icon.png (192×192) — цветной значок слева в уведомлении.
 *     192 — размер, который Chrome берёт на экранах с двойной плотностью;
 *     меньший он растянет и замылит.
 *   notification-badge.png (96×96) — одноцветный силуэт для строки
 *     состояния Android. Там значок перекрашивается системой в один цвет,
 *     поэтому рисуем белым по прозрачному: цветная картинка превратилась
 *     бы в бесформенное пятно.
 *
 * Генератор, а не картинка «из редактора»: знак должен меняться вместе
 * с брендом, а не жить своей жизнью. В сборку он не включён намеренно —
 * готовые файлы лежат в public/brand и попадают в образ как есть; запускать
 * генератор нужно ровно тогда, когда изменится сам знак:
 *
 *     node apps/web/scripts/build-notification-icons.mjs
 *
 * Растеризация своя и очень простая (расстояние до фигуры + сглаживание
 * по четырём точкам на пиксель): ставить ради двух значков зависимость
 * с нативным кодом было бы несоразмерно.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../public/brand');

/** Фирменный синий — тот же, что в mark.svg. */
const BRAND = [0x00, 0x6e, 0xc6];

/** Расстояние от точки до отрезка — основа для всех фигур ниже. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Скруглённый квадрат: отрицательное значение — внутри фигуры. */
function roundedSquare(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Галочка знака Mail.True в координатах 0..1. */
const CHECK = [
  [0.281, 0.5],
  [0.456, 0.675],
  [0.731, 0.325],
];

function checkDistance(x, y, size) {
  const p = CHECK.map(([cx, cy]) => [cx * size, cy * size]);
  return Math.min(
    distanceToSegment(x, y, p[0][0], p[0][1], p[1][0], p[1][1]),
    distanceToSegment(x, y, p[1][0], p[1][1], p[2][0], p[2][1]),
  );
}

/**
 * Рисует значок. `mono` — силуэт для строки состояния: там всё,
 * что не прозрачно, система перекрасит в свой цвет.
 */
function render(size, mono) {
  const pixels = Buffer.alloc(size * size * 4);
  const stroke = size * 0.103; // та же толщина, что stroke-width 3.3 при 32
  const radius = size * 0.094; // тот же радиус, что 3 при 32

  const coverage = (fn) => (x, y) => {
    // Четыре точки на пиксель: без сглаживания скруглённый угол
    // на 96 пикселях выглядит рваным.
    let sum = 0;
    for (const [ox, oy] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ]) {
      sum += fn(x + ox, y + oy) <= 0 ? 1 : 0;
    }
    return sum / 4;
  };

  const inSquare = coverage((x, y) => roundedSquare(x, y, size, radius));
  const inCheck = coverage((x, y) => checkDistance(x, y, size) - stroke / 2);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const square = inSquare(x, y);
      const check = inCheck(x, y);
      if (mono) {
        // Силуэт: подложка целиком, галочка вырезана насквозь —
        // так знак читается и после перекраски в один цвет.
        const alpha = Math.max(0, square - check);
        pixels[offset] = 0xff;
        pixels[offset + 1] = 0xff;
        pixels[offset + 2] = 0xff;
        pixels[offset + 3] = Math.round(alpha * 255);
      } else {
        const white = Math.min(square, check);
        pixels[offset] = Math.round(BRAND[0] * (1 - white) + 0xff * white);
        pixels[offset + 1] = Math.round(BRAND[1] * (1 - white) + 0xff * white);
        pixels[offset + 2] = Math.round(BRAND[2] * (1 - white) + 0xff * white);
        pixels[offset + 3] = Math.round(square * 255);
      }
    }
  }
  return pixels;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function toPng(size, pixels) {
  // Каждой строке PNG предшествует байт способа предсказания; нам хватает
  // нулевого («как есть»): картинки крошечные, сжимает их zlib.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // цвет с прозрачностью
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ['notification-icon.png', 192, false],
  ['notification-badge.png', 96, true],
];
for (const [name, size, mono] of files) {
  const png = toPng(size, render(size, mono));
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`${name}: ${String(size)}×${String(size)}, ${String(png.length)} байт`);
}
