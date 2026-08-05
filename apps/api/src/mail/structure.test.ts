import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageStructureObject } from 'imapflow';
import {
  cidToPartMap,
  collectAttachments,
  decodedPartSize,
  hasRealAttachments,
  pickTextPart,
} from './structure.js';

/** Письмо «переслано как вложение»: text/plain + message/rfc822. */
function forwardedAsAttachment(subject?: string): MessageStructureObject {
  return {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 42 },
      {
        part: '2',
        type: 'message/rfc822',
        size: 4096,
        ...(subject === undefined ? {} : { envelope: { subject } as never }),
        childNodes: [{ part: '2.1', type: 'text/plain', size: 100 }],
      },
    ],
  } as MessageStructureObject;
}

/**
 * Главный случай. У части message/rfc822 нет ни Content-Disposition, ни имени
 * файла, ни типа image/*, поэтому вложением она не считалась — а данные при
 * этом отдавались: запрос /parts/2 возвращал 200. Пользователь видел письмо
 * без вложения и не мог скачать то, что в письме есть.
 */
test('вложенное письмо (message/rfc822) попадает в список вложений', () => {
  const list = collectAttachments(forwardedAsAttachment('Отчёт за июль'));
  assert.equal(list.length, 1);
  const att = list[0];
  assert.ok(att);
  assert.equal(att.partId, '2');
  assert.equal(att.mimeType, 'message/rfc822');
  assert.equal(att.inline, false);
  assert.equal(att.size, 4096);
  assert.equal(att.filename, 'Отчёт за июль.eml');
});

test('вложенное письмо считается настоящим вложением (скрепка в списке)', () => {
  assert.equal(hasRealAttachments(forwardedAsAttachment('Тема')), true);
});

test('вложенное письмо без темы получает понятное имя файла', () => {
  const list = collectAttachments(forwardedAsAttachment(undefined));
  assert.equal(list[0]?.filename, 'Вложенное письмо.eml');
});

test('в имени файла вложенного письма нет запрещённых символов', () => {
  const list = collectAttachments(forwardedAsAttachment('Счёт №5/2026: срочно?'));
  const name = list[0]?.filename ?? '';
  assert.match(name, /\.eml$/);
  assert.equal(/[\\/:*?"<>|]/.test(name), false, `в имени остались запрещённые символы: ${name}`);
});

test('части внутри вложенного письма не считаются отдельными вложениями', () => {
  const structure: MessageStructureObject = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 10 },
      {
        part: '2',
        type: 'message/rfc822',
        size: 9000,
        envelope: { subject: 'Пересылаю' } as never,
        childNodes: [
          {
            part: '2',
            type: 'multipart/mixed',
            childNodes: [
              { part: '2.1', type: 'text/plain', size: 10 },
              {
                part: '2.2',
                type: 'application/pdf',
                size: 8000,
                disposition: 'attachment',
                dispositionParameters: { filename: 'внутри.pdf' },
              },
            ],
          },
        ],
      },
    ],
  } as MessageStructureObject;

  const list = collectAttachments(structure);
  assert.deepEqual(
    list.map((a) => a.partId),
    ['2'],
    'вложение внутри пересланного письма отдельной строкой не показывается'
  );
});

test('сниппет берётся из текста письма, а не из вложенного письма', () => {
  const ref = pickTextPart(forwardedAsAttachment('Тема'));
  assert.equal(ref?.part, '1');
});

// --- Проверки, что прежнее поведение не сломалось ---

test('обычное вложение с именем файла по-прежнему находится', () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 10 },
      {
        part: '2',
        type: 'application/pdf',
        size: 100,
        disposition: 'attachment',
        dispositionParameters: { filename: 'счёт.pdf' },
      },
    ],
  } as MessageStructureObject;
  const list = collectAttachments(structure);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.filename, 'счёт.pdf');
  assert.equal(list[0]?.inline, false);
});

test('встроенная картинка остаётся inline и попадает в карту cid', () => {
  const structure = {
    type: 'multipart/related',
    childNodes: [
      { part: '1', type: 'text/html', size: 10 },
      { part: '2', type: 'image/png', size: 100, id: '<logo@x>' },
    ],
  } as MessageStructureObject;
  const list = collectAttachments(structure);
  assert.equal(list[0]?.inline, true);
  assert.equal(list[0]?.contentId, 'logo@x');
  assert.equal(hasRealAttachments(structure), false);
  assert.equal(cidToPartMap(structure).get('logo@x'), '2');
});

test('простое письмо без вложений остаётся без них', () => {
  const structure = { part: '1', type: 'text/plain', size: 10 } as MessageStructureObject;
  assert.deepEqual(collectAttachments(structure), []);
  assert.equal(pickTextPart(structure)?.part, '1');
});

/* ------------------------------------------------------------------ */
/* Находка 6: размер вложения показывался закодированный               */
/* ------------------------------------------------------------------ */

/**
 * В BODYSTRUCTURE лежит размер части уже в base64. Файл на 3 000 000 байт
 * приезжает как 4 105 262 — завышение примерно на 37%. Скачивался он при
 * этом байт в байт, то есть в списке вложений стояла заведомая неправда.
 *
 * Число 4 105 262 не выдумано: 3 000 000 байт дают 4 000 000 символов
 * base64, которые разложены по 76 символов в строке — это 52 631 перенос
 * строки по два байта. Ровно так кодирует MailComposer.
 */
test('размер вложения показывается как размер файла, а не как размер в письме', () => {
  const node = {
    part: '2',
    type: 'application/pdf',
    encoding: 'base64',
    size: 4_105_262,
    disposition: 'attachment',
    dispositionParameters: { filename: 'отчёт.pdf' },
  } as MessageStructureObject;
  assert.equal(decodedPartSize(node), 3_000_000);

  const list = collectAttachments({
    type: 'multipart/mixed',
    childNodes: [{ part: '1', type: 'text/plain', size: 10 }, node],
  } as MessageStructureObject);
  assert.equal(list[0]?.size, 3_000_000);
});

test('размер части без base64 остаётся как есть', () => {
  const node = { part: '1', type: 'text/plain', encoding: '7bit', size: 12_345 } as MessageStructureObject;
  assert.equal(decodedPartSize(node), 12_345);
  const qp = { part: '1', type: 'text/plain', encoding: 'quoted-printable', size: 900 } as MessageStructureObject;
  assert.equal(decodedPartSize(qp), 900);
});

test('пересчёт размера base64 держится в пределах погрешности на разных объёмах', () => {
  // Считаем закодированный размер так же, как это делает почтовый клиент,
  // и проверяем, что обратный пересчёт возвращает исходное число.
  for (const bytes of [1, 100, 999, 65_536, 1_000_000, 17_000_000]) {
    const chars = Math.ceil(bytes / 3) * 4;
    const encoded = chars + Math.max(0, Math.ceil(chars / 76) - 1) * 2;
    const back = decodedPartSize({
      part: '1',
      type: 'application/octet-stream',
      encoding: 'base64',
      size: encoded,
    } as MessageStructureObject);
    assert.ok(
      Math.abs(back - bytes) <= 3,
      `${String(bytes)} Б -> ${String(encoded)} Б -> ${String(back)} Б: расхождение больше трёх байт`
    );
  }
});
