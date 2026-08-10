/**
 * Подписи: сохранение выбора и чужая работа.
 *
 * ------------------------------------------------------------------
 * ЧТО ЗАКРЫВАЕТСЯ
 * ------------------------------------------------------------------
 * 1. «Без подписи» не сохранялось НИКОГДА. После каждой правки
 *    хранилище возвращало признак «основная» первой подписи — защита от
 *    состояния «подписи есть, а основной нет». Человек выбирал «Без
 *    подписи», жал «Сохранить», и селект на глазах перескакивал обратно,
 *    а окно написания продолжало подставлять отключённую подпись.
 * 2. Правило «чего нет в присланном списке — удаляем» сносило подписи,
 *    заведённые уже после загрузки формы: вкладка, открытая час назад,
 *    уносила чужую работу вместе с написанным текстом. Восстановить его
 *    нечем — он остаётся только в журнале аудита.
 * 3. Запрос без поля `signatures` стирал все подписи ящика и отвечал
 *    200. Рядом три соседних поля намеренно оставлены без умолчаний
 *    ровно по этой причине.
 * 4. Новая подпись всегда уезжала в конец: место в списке ей не
 *    задавали. Поднять её наверх было нельзя — сохранение возвращало вниз.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveGeneralWithSignatures } from './general.js';
import type { SettingsDb } from './db.js';
import type { Signature } from './types.js';
import type { WebGeneralSettings } from './webdto.js';

/** Хранилище подписей в памяти — с тем же поведением, что у настоящего. */
function fakeDb(initial: Signature[] = []): SettingsDb {
  let list = initial.map((item) => ({ ...item }));
  let nextId = Math.max(0, ...list.map((s) => s.id)) + 1;

  /** Та самая защита: подписи есть, а основной нет — помечаем первую. */
  const ensureOne = (): void => {
    if (list.length > 0 && !list.some((s) => s.isDefault)) {
      const first = [...list].sort((a, b) => a.position - b.position || a.id - b.id)[0];
      if (first) first.isDefault = true;
    }
  };

  /** Настройки ящика: здесь важны только подписи, остальное — пустышки. */
  const settings = {
    accountEmail: 'ivan@mail.local',
    senderName: null,
    theme: 'system',
    wallpaper: '',
    replyQuote: true,
    afterDelete: 'list',
    notifyBrowser: false,
    notifyTab: true,
    autoCollectContacts: true,
    autoReply: { enabled: false, text: '', from: null, until: null },
  };

  type CreateInput = { name: string; bodyHtml: string; isDefault: boolean; position?: number };
  type UpdatePatch = {
    name?: string | undefined;
    bodyHtml?: string | undefined;
    isDefault?: boolean | undefined;
    position?: number | undefined;
  };

  return {
    saveSettings: async () => undefined,
    getSettings: async () => settings,
    listSignatures: async () => list.map((item) => ({ ...item })),
    createSignature: async (_email: string, input: CreateInput) => {
      if (input.isDefault) for (const item of list) item.isDefault = false;
      list.push({
        id: nextId++,
        name: input.name,
        bodyHtml: input.bodyHtml,
        isDefault: input.isDefault,
        position: input.position ?? list.length,
      });
      ensureOne();
      return list.map((item) => ({ ...item }));
    },
    updateSignature: async (_email: string, id: number, patch: UpdatePatch) => {
      const found = list.find((item) => item.id === id);
      if (found) {
        if (patch.name !== undefined) found.name = patch.name;
        if (patch.bodyHtml !== undefined) found.bodyHtml = patch.bodyHtml;
        if (patch.isDefault === true) for (const item of list) item.isDefault = item.id === id;
        if (patch.position !== undefined) found.position = patch.position;
      }
      ensureOne();
      return list.map((item) => ({ ...item }));
    },
    deleteSignature: async (_email: string, id: number) => {
      list = list.filter((item) => item.id !== id);
      ensureOne();
      return list.map((item) => ({ ...item }));
    },
    clearDefaultSignatureChoice: async () => {
      for (const item of list) item.isDefault = false;
      return list.map((item) => ({ ...item }));
    },
  } as unknown as SettingsDb;
}

/** Минимальная форма настроек: интересуют только подписи. */
function form(patch: Partial<WebGeneralSettings>): WebGeneralSettings {
  return {
    senderName: 'Пётр',
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: true },
    quoteOriginalOnReply: true,
    afterDelete: 'list',
    autoCollectContacts: true,
    ...patch,
  } as WebGeneralSettings;
}

const SIGN = (id: number, name: string, isDefault = false): Signature => ({
  id,
  name,
  bodyHtml: `текст ${name}`,
  isDefault,
  position: id,
});

void test('«Без подписи» сохраняется, а не возвращается обратно', async () => {
  const db = fakeDb([SIGN(1, 'Рабочая', true), SIGN(2, 'Личная')]);
  await saveGeneralWithSignatures(
    db,
    'ivan@mail.local',
    form({
      defaultSignatureId: null,
      signatures: [
        { id: '1', name: 'Рабочая', text: 'текст Рабочая' },
        { id: '2', name: 'Личная', text: 'текст Личная' },
      ],
      knownSignatureIds: ['1', '2'],
    }),
  );
  const after = await db.listSignatures('ivan@mail.local');
  assert.equal(
    after.some((s) => s.isDefault),
    false,
    'выбор «Без подписи» не сохранился — окно написания подставит отключённую подпись',
  );
  assert.equal(after.length, 2, 'подписи при этом никуда не делись');
});

void test('выбранная основная подпись остаётся выбранной', async () => {
  // Обратная сторона: снятие флага не должно ломать обычный случай.
  const db = fakeDb([SIGN(1, 'Рабочая', true), SIGN(2, 'Личная')]);
  await saveGeneralWithSignatures(
    db,
    'ivan@mail.local',
    form({
      defaultSignatureId: '2',
      signatures: [
        { id: '1', name: 'Рабочая', text: 'текст Рабочая' },
        { id: '2', name: 'Личная', text: 'текст Личная' },
      ],
      knownSignatureIds: ['1', '2'],
    }),
  );
  const after = await db.listSignatures('ivan@mail.local');
  assert.deepEqual(
    after.filter((s) => s.isDefault).map((s) => s.id),
    [2],
  );
});

void test('подпись, заведённая после загрузки формы, не удаляется', async () => {
  /*
   * Вкладка открыта час назад: на экране была одна подпись. За это время
   * из админки завели вторую. Сохранение прежней формы не должно её
   * сносить — текст восстановить нечем.
   */
  const db = fakeDb([SIGN(1, 'Рабочая', true), SIGN(2, 'Корпоративная')]);
  await saveGeneralWithSignatures(
    db,
    'ivan@mail.local',
    form({
      defaultSignatureId: '1',
      signatures: [{ id: '1', name: 'Рабочая', text: 'текст Рабочая' }],
      // Клиент видел только первую.
      knownSignatureIds: ['1'],
    }),
  );
  const after = await db.listSignatures('ivan@mail.local');
  assert.deepEqual(
    after.map((s) => s.name),
    ['Рабочая', 'Корпоративная'],
  );
});

void test('свою подпись удалить по-прежнему можно', async () => {
  // Иначе защита превратилась бы в «удаление не работает».
  const db = fakeDb([SIGN(1, 'Рабочая', true), SIGN(2, 'Личная')]);
  await saveGeneralWithSignatures(
    db,
    'ivan@mail.local',
    form({
      defaultSignatureId: '1',
      signatures: [{ id: '1', name: 'Рабочая', text: 'текст Рабочая' }],
      knownSignatureIds: ['1', '2'],
    }),
  );
  const after = await db.listSignatures('ivan@mail.local');
  assert.deepEqual(
    after.map((s) => s.name),
    ['Рабочая'],
  );
});

void test('без списка виденных подписей удаление работает как раньше', async () => {
  // Старая сборка панели поля не шлёт — она не должна перестать удалять.
  const db = fakeDb([SIGN(1, 'Рабочая', true), SIGN(2, 'Личная')]);
  await saveGeneralWithSignatures(
    db,
    'ivan@mail.local',
    form({
      defaultSignatureId: '1',
      signatures: [{ id: '1', name: 'Рабочая', text: 'текст Рабочая' }],
    }),
  );
  assert.equal((await db.listSignatures('ivan@mail.local')).length, 1);
});

void test('запрос без поля signatures подписи не трогает вовсе', async () => {
  /*
   * Раньше поле имело умолчание «пустой список», и такой запрос стирал
   * ВСЕ подписи ящика, отвечая 200. Тексты подписей человек пишет
   * руками — цена ошибки выше, чем у флажка.
   */
  const db = fakeDb([SIGN(1, 'Рабочая', true), SIGN(2, 'Личная')]);
  await saveGeneralWithSignatures(db, 'ivan@mail.local', form({ defaultSignatureId: '1' }));
  assert.equal((await db.listSignatures('ivan@mail.local')).length, 2);
});

void test('новая подпись встаёт на своё место в списке, а не в конец', async () => {
  /*
   * Администратор добавляет подпись, поднимает её наверх, сохраняет — и
   * она возвращалась вниз, потому что место ей не задавали.
   */
  const db = fakeDb([SIGN(1, 'Рабочая', true)]);
  await saveGeneralWithSignatures(
    db,
    'ivan@mail.local',
    form({
      defaultSignatureId: '1',
      signatures: [
        { id: 'new-1', name: 'Новая', text: 'свежий текст' },
        { id: '1', name: 'Рабочая', text: 'текст Рабочая' },
      ],
      knownSignatureIds: ['1'],
    }),
  );
  const after = (await db.listSignatures('ivan@mail.local')).sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );
  assert.deepEqual(
    after.map((s) => s.name),
    ['Новая', 'Рабочая'],
  );
});
