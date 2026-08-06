/**
 * Хранилище своего оформления входа (OEM).
 *
 * Проверки закрывают требования заказчика дословно и падают на коде без
 * branding.ts:
 *
 *   1. «Логотип должен переживать перезапуск контейнеров (том, а не
 *      память)» — состояние читается новым экземпляром хранилища из того
 *      же каталога, то есть ровно так, как после перезапуска.
 *   2. «Кнопка "вернуть стандартный" обязательна» — сброс убирает и
 *      описание, и сам файл с диска.
 *   3. «Логотип должен попадать в резервную копию» — выгрузка отдаёт
 *      байты, загрузка их принимает.
 *   4. Копию приносит человек файлом, значит логотип из копии проходит
 *      ту же проверку, что и загрузка из браузера.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { BadRequestError } from '../errors.js';
import { BrandingStore } from './branding.js';

/**
 * Настоящий PNG нужного размера. Свой, а не общий с branding-image.test.ts:
 * импорт одного файла проверок из другого заставляет node прогонять его
 * проверки дважды, и отчёт перестаёт сходиться с числом тестов.
 */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3), 0x80))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function tempStore(): Promise<{ dir: string; store: BrandingStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-branding-'));
  const store = new BrandingStore(dir);
  await store.init();
  return { dir, store };
}

test('пока логотип не загружали, оформление стандартное и ошибок нет', async () => {
  const { store } = await tempStore();
  const state = await store.read();
  assert.equal(state.logo, null);
  assert.equal(state.companyName, null);
  assert.equal(await store.readLogo(), null);
});

test('загруженный логотип переживает «перезапуск»: читается новым экземпляром', async () => {
  const { dir, store } = await tempStore();
  const png = makePng(240, 48);
  const saved = await store.saveLogo(png);
  assert.equal(saved.logo?.width, 240);

  // Ровно то, что делает контейнер после перезапуска: новый процесс,
  // тот же том. Память здесь не помогла бы ничем.
  const afterRestart = new BrandingStore(dir);
  const state = await afterRestart.read();
  assert.equal(state.logo?.version, saved.logo?.version);

  const file = await afterRestart.readLogo();
  assert.ok(file, 'файл логотипа обязан лежать в каталоге, а не в памяти');
  assert.equal(file.bytes.length, png.length);
  assert.ok(file.bytes.equals(png), 'байты не должны меняться при сохранении');
});

test('отпечаток меняется вместе с картинкой: браузер не покажет старую', async () => {
  const { store } = await tempStore();
  const first = await store.saveLogo(makePng(200, 40));
  const second = await store.saveLogo(makePng(300, 60));
  assert.notEqual(first.logo?.version, second.logo?.version);
});

test('«вернуть стандартный» убирает и описание, и файл с диска', async () => {
  const { dir, store } = await tempStore();
  await store.saveLogo(makePng(200, 40));
  assert.ok((await readdir(dir)).some((n) => n.startsWith('logo.')));

  const state = await store.resetLogo();
  assert.equal(state.logo, null);
  assert.equal(await store.readLogo(), null);
  assert.deepEqual(
    (await readdir(dir)).filter((n) => n.startsWith('logo.')),
    [],
    'файл прежнего логотипа обязан исчезнуть, а не остаться лежать',
  );
});

test('смена формата не оставляет второго файла логотипа', async () => {
  const { dir, store } = await tempStore();
  await store.saveLogo(makePng(200, 40));
  await store.saveLogo(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 40" width="200" height="40">' +
        '<rect width="200" height="40"/></svg>',
      'utf8',
    ),
  );
  const logos = (await readdir(dir)).filter((n) => n.startsWith('logo.'));
  assert.deepEqual(logos, ['logo.svg'], 'от прежнего PNG не должно остаться следа');
});

test('сброс не трогает названия компании и сервиса', async () => {
  const { store } = await tempStore();
  await store.saveTexts({ companyName: 'ООО «Ромашка»', productName: 'Почта Ромашки' });
  await store.saveLogo(makePng(200, 40));
  const state = await store.resetLogo();
  assert.equal(state.companyName, 'ООО «Ромашка»');
  assert.equal(state.productName, 'Почта Ромашки');
});

test('пустое название означает «убрать», а не «сохранить пустоту»', async () => {
  const { store } = await tempStore();
  await store.saveTexts({ companyName: 'ООО «Ромашка»' });
  const state = await store.saveTexts({ companyName: '   ' });
  assert.equal(state.companyName, null);
});

test('слишком длинное название отклоняется с объяснением, а не молча режется', async () => {
  const { store } = await tempStore();
  await assert.rejects(
    () => store.saveTexts({ companyName: 'я'.repeat(200) }),
    (err: unknown) => {
      assert.ok(err instanceof BadRequestError);
      assert.match(err.message, /не поместится/u);
      return true;
    },
  );
});

test('логотип попадает в копию настроек и возвращается из неё', async () => {
  const { store } = await tempStore();
  const png = makePng(220, 44);
  await store.saveLogo(png);
  await store.saveTexts({ companyName: 'ООО «Ромашка»' });

  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.logoBase64, png.toString('base64'));
  assert.equal(snapshot.companyName, 'ООО «Ромашка»');

  // Другая установка: пустой каталог, тот же файл копии.
  const other = await tempStore();
  await other.store.importSnapshot(snapshot);
  const restored = await other.store.readLogo();
  assert.ok(restored);
  assert.ok(restored.bytes.equals(png));
  assert.equal((await other.store.read()).companyName, 'ООО «Ромашка»');
});

test('копия без логотипа возвращает стандартный, а не оставляет прежний', async () => {
  const { store } = await tempStore();
  await store.saveLogo(makePng(200, 40));
  await store.importSnapshot({ companyName: null, productName: null, logoBase64: null });
  assert.equal((await store.read()).logo, null);
});

test('логотип из копии проверяется так же, как загруженный из браузера', async () => {
  const { store } = await tempStore();
  const evil = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40">' +
      '<script>fetch("/api/admin/users")</script></svg>',
    'utf8',
  );
  await assert.rejects(
    () =>
      store.importSnapshot({
        companyName: null,
        productName: null,
        logoBase64: evil.toString('base64'),
      }),
    (err: unknown) => {
      assert.ok(err instanceof BadRequestError, 'внутри копии проверка обязана работать тоже');
      assert.match(err.message, /script/iu);
      return true;
    },
  );
});

test('испорченный branding.json не мешает открыть страницу входа', async () => {
  const { dir, store } = await tempStore();
  await writeFile(path.join(dir, 'branding.json'), '{это не json', 'utf8');
  const state = await store.read();
  assert.equal(state.logo, null, 'битый файл читается как «оформление стандартное»');
});

test('описание есть, а файла нет — отдаём «логотипа нет», а не аварию', async () => {
  const { dir, store } = await tempStore();
  await store.saveLogo(makePng(200, 40));
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(dir, 'logo.png'));
  assert.equal(await store.readLogo(), null);
});
