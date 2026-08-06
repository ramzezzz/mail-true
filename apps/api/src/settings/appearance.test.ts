/**
 * Оформление ящика хранится за пользователем.
 *
 * Требование заказчика: «тема оформления должна запоминаться для каждого
 * юзера». Проверяется здесь именно то, из-за чего это ломается на живом
 * стенде, а не форма ответа ради формы:
 *
 *   * заплатка касается ТОЛЬКО переданных полей — иначе щелчок по палитре
 *     в шапке стирал бы выбранный фон, и наоборот;
 *   * мусор из базы или из тела запроса приводится к умолчанию, а не
 *     роняет ответ: тема — не та вещь, из-за которой пользователь должен
 *     видеть отказ;
 *   * в ответе есть АДРЕС ящика. По нему браузер отличает свой кэш от
 *     чужого; без адреса вход другим пользователем на том же компьютере
 *     показывал бы чужую тему.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromWebAppearance, saveAppearance, toWebAppearance } from './appearance.js';
import { defaultMailSettings, type MailSettings, type MailSettingsPatch } from './types.js';

/** База настроек «в памяти» — ровно то, что нужно этим проверкам. */
class FakeDb {
  settings: MailSettings;

  constructor(email: string) {
    this.settings = defaultMailSettings(email);
  }

  getSettings(_email: string): Promise<MailSettings> {
    return Promise.resolve(this.settings);
  }

  saveSettings(_email: string, patch: MailSettingsPatch): Promise<MailSettings> {
    if (patch.theme !== undefined) this.settings.theme = patch.theme;
    if (patch.wallpaper !== undefined) this.settings.wallpaper = patch.wallpaper;
    if (patch.senderName !== undefined) this.settings.senderName = patch.senderName;
    return Promise.resolve(this.settings);
  }
}

const asDb = (fake: FakeDb): any => fake;

test('новый ящик: тема системная, фон не выбран', () => {
  const dto = toWebAppearance(defaultMailSettings('test@mail.local'));
  assert.deepEqual(dto, { email: 'test@mail.local', theme: 'system', wallpaper: '' });
});

test('в ответе есть адрес ящика — по нему браузер узнаёт свой кэш', () => {
  const settings = defaultMailSettings('demo@mail.local');
  settings.theme = 'emerald';
  assert.equal(toWebAppearance(settings).email, 'demo@mail.local');
});

test('неизвестная тема из базы становится темой по умолчанию', () => {
  const settings = { ...defaultMailSettings('test@mail.local'), theme: 'неонОвая' as never };
  assert.equal(toWebAppearance(settings).theme, 'system');
});

test('мусор в выборе фона не доезжает до интерфейса', () => {
  const junk = { ...defaultMailSettings('test@mail.local'), wallpaper: 'javascript:alert(1)' };
  assert.equal(toWebAppearance(junk).wallpaper, '');
  const custom = { ...defaultMailSettings('test@mail.local'), wallpaper: 'custom' };
  assert.equal(toWebAppearance(custom).wallpaper, 'custom');
  const preset = { ...defaultMailSettings('test@mail.local'), wallpaper: 'preset:forest' };
  assert.equal(toWebAppearance(preset).wallpaper, 'preset:forest');
});

test('заплатка трогает только переданные поля', () => {
  assert.deepEqual(fromWebAppearance({ theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(fromWebAppearance({ wallpaper: 'preset:dusk' }), { wallpaper: 'preset:dusk' });
  assert.deepEqual(fromWebAppearance({}), {});
  assert.deepEqual(fromWebAppearance(null), {});
});

test('смена темы не стирает выбранный фон', async () => {
  const db = new FakeDb('test@mail.local');
  await saveAppearance(asDb(db), 'test@mail.local', { wallpaper: 'preset:plum' });
  const after = await saveAppearance(asDb(db), 'test@mail.local', { theme: 'wallpaper' });
  assert.equal(after.theme, 'wallpaper');
  assert.equal(after.wallpaper, 'preset:plum');
});

test('неизвестная тема из тела запроса сохраняется как умолчание, без отказа', async () => {
  const db = new FakeDb('test@mail.local');
  const after = await saveAppearance(asDb(db), 'test@mail.local', { theme: '<script>' });
  assert.equal(after.theme, 'system');
});

test('пустое тело ничего не пишет', async () => {
  const db = new FakeDb('test@mail.local');
  db.settings.theme = 'violet';
  let written = 0;
  const save = db.saveSettings.bind(db);
  db.saveSettings = (email: string, patch: MailSettingsPatch) => {
    written += 1;
    return save(email, patch);
  };
  const after = await saveAppearance(asDb(db), 'test@mail.local', { лишнее: 1 });
  assert.equal(written, 0);
  assert.equal(after.theme, 'violet');
});
