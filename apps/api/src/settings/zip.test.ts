/**
 * Проверка записи ZIP — настоящим распаковщиком, а не собственными
 * представлениями о формате.
 *
 * Написать «свой» ZIP, который открывает только твой же читатель, легко и
 * бесполезно: человек понесёт архив в проводник Windows и в Thunderbird.
 * Поэтому проверка идёт двумя способами сразу:
 *
 *   1. Разбор оглавления по спецификации (подписи, смещения, размеры).
 *   2. Обратное развёртывание содержимого через zlib — байт в байт.
 *
 * Второе важнее первого: именно оно ловит перепутанные местами crc и
 * размеры, из-за которых архив открывается, но файлы в нём битые.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { ZipWriter, crc32, dosDateTime, safeEntryName, safeEntryPath } from './zip.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface ReadEntry {
  name: string;
  data: Buffer;
}

/** Разбирает готовый архив так же, как это сделал бы распаковщик. */
function readZip(archive: Buffer): ReadEntry[] {
  // Оглавление ищется от конца — как и положено формату: только там
  // распаковщик может узнать, где что лежит.
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, 'нет записи конца оглавления');
  assert.equal(archive.readUInt32LE(eocd), SIG_EOCD);
  const count = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);

  const entries: ReadEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(archive.readUInt32LE(at), SIG_CENTRAL, 'битая запись оглавления');
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const csize = archive.readUInt32LE(at + 20);
    const usize = archive.readUInt32LE(at + 24);
    const nameLen = archive.readUInt16LE(at + 28);
    const extraLen = archive.readUInt16LE(at + 30);
    const commentLen = archive.readUInt16LE(at + 32);
    const localAt = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    assert.equal(archive.readUInt32LE(localAt), SIG_LOCAL, 'битый заголовок файла');
    const localNameLen = archive.readUInt16LE(localAt + 26);
    const localExtraLen = archive.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = archive.subarray(dataAt, dataAt + csize);
    const data = method === 0 ? raw : inflateRawSync(raw);

    assert.equal(data.length, usize, `размер ${name} не совпал`);
    assert.equal(crc32(data), crc, `контрольная сумма ${name} не совпала`);
    entries.push({ name, data });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('архив открывается и содержимое совпадает байт в байт', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mt-zip-'));
  const path = join(dir, 'a.zip');
  try {
    const zip = new ZipWriter(path);
    // Три разных случая сразу: обычный текст, кириллица в имени и данные,
    // которые от сжатия только вырастут (уже сжатое вложение).
    const text = Buffer.from('Здравствуйте!\r\nЭто письмо.\r\n', 'utf8');
    const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) % 256));
    await zip.add('Входящие/000001 Привет.eml', text, new Date('2026-08-06T12:34:56Z'));
    await zip.add('Спам/000002 без темы.eml', random, new Date('2026-08-06T12:34:56Z'));
    await zip.add('ЧИТАТЬ.txt', Buffer.from('пусто', 'utf8'), new Date());
    const size = await zip.finish();

    const archive = await readFile(path);
    assert.equal(archive.length, size, 'обещанный размер не совпал с файлом');

    const entries = readZip(archive);
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['Входящие/000001 Привет.eml', 'Спам/000002 без темы.eml', 'ЧИТАТЬ.txt'],
    );
    assert.deepEqual(entries[0]!.data, text);
    assert.deepEqual(entries[1]!.data, random);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('пустой архив тоже правильный: оглавление есть, файлов нет', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mt-zip-'));
  const path = join(dir, 'empty.zip');
  try {
    const zip = new ZipWriter(path);
    await zip.finish();
    const archive = await readFile(path);
    assert.equal(readZip(archive).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('имя файла не может увести распаковщик за пределы каталога', () => {
  // Классическая дыра «Zip Slip»: имя складывается из пути папки IMAP и
  // темы письма, то есть из данных, и `..` там появляется бесплатно.
  assert.equal(safeEntryName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeEntryPath(['..', 'Входящие', '..']), 'Входящие');
  assert.equal(safeEntryName('тема: с "кавычками" и |чертой|'), 'тема с кавычками и чертой');
  assert.equal(safeEntryName('   '), 'без имени');
  assert.equal(safeEntryName('файл.'), 'файл');
});

test('дата раньше 1980 прижимается к началу, а не уезжает в мусор', () => {
  // У формата год отсчитывается от 1980; часы отправителя врут регулярно.
  const early = dosDateTime(new Date('1975-01-01T00:00:00Z'));
  assert.equal(early.time, 0);
  assert.equal(early.date, (1 << 5) | 1);
});

test('контрольная сумма совпадает с известным значением', () => {
  // Значение CRC-32 для «123456789» — общеизвестная проверочная величина.
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});
