/**
 * Юнит-тесты преобразования между внутренней моделью и контрактом
 * веб-интерфейса.
 *
 * Смысл этих тестов: расхождение сторон должно вскрываться здесь,
 * а не на первом экране интерфейса. Проверяются именно те места, где
 * модели не совпадают один в один: имя поля подписи, значения
 * «после удаления», операторы, идентификатор папки против пути IMAP
 * и состояние сборщика.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Folder } from '@mail-true/shared';
import {
  folderIdOfPath,
  fromWebGeneral,
  fromWebRule,
  pathOfFolderId,
  ruleNameFrom,
  toWebGeneral,
  toWebRule,
  toWebStatus,
  type WebFilterRule,
  type WebGeneralSettings,
} from './webdto.js';
import { DEFAULT_ACTIONS, defaultMailSettings, type FilterRule, type Signature } from './types.js';

const FOLDERS: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: true,
    uidValidity: 1,
  },
  {
    id: 'f-0YHRh9C10YLQsA',
    path: 'Счета',
    name: 'Счета',
    role: 'custom',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 0,
    system: false,
    uidValidity: 1,
  },
];

test('папка: идентификатор <-> путь', () => {
  assert.equal(pathOfFolderId(FOLDERS, 'inbox'), 'INBOX');
  assert.equal(pathOfFolderId(FOLDERS, 'f-0YHRh9C10YLQsA'), 'Счета');
  assert.equal(pathOfFolderId(FOLDERS, null), null);
  assert.equal(pathOfFolderId(FOLDERS, 'нет-такой'), null);
  assert.equal(folderIdOfPath(FOLDERS, 'Счета'), 'f-0YHRh9C10YLQsA');
  assert.equal(folderIdOfPath(FOLDERS, 'Нет'), null);
});

test('общие настройки: внутреннее -> DTO интерфейса', () => {
  const settings = defaultMailSettings('u@mail.local');
  settings.senderName = 'Иван Петров';
  settings.afterDelete = 'next';
  settings.replyQuote = false;
  settings.notifyBrowser = true;
  settings.autoReply = {
    enabled: true,
    subject: 'Не тема интерфейса',
    text: 'Меня нет',
    from: '2026-08-01T00:00:00.000Z',
    until: '2026-08-20T00:00:00.000Z',
    days: 7,
  };
  const signatures: Signature[] = [
    { id: 7, name: 'Рабочая', bodyHtml: 'С уважением', isDefault: true, position: 0 },
    { id: 8, name: 'Личная', bodyHtml: 'Пока', isDefault: false, position: 1 },
  ];

  const dto = toWebGeneral(settings, signatures);
  assert.equal(dto.senderName, 'Иван Петров');
  assert.equal(dto.afterDelete, 'next-message');
  assert.equal(dto.quoteOriginalOnReply, false);
  assert.equal(dto.notifications.browser, true);
  assert.equal(dto.notifications.tabCounter, true);
  assert.equal(dto.defaultSignatureId, '7');
  assert.deepEqual(dto.signatures[0], { id: '7', name: 'Рабочая', text: 'С уважением' });
  assert.deepEqual(dto.autoReply, {
    enabled: true,
    text: 'Меня нет',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-20T00:00:00.000Z',
  });
});

test('общие настройки: DTO -> заплатка, «после удаления» переводится в обе стороны', () => {
  const dto: WebGeneralSettings = {
    senderName: '  ',
    signatures: [],
    defaultSignatureId: null,
    autoReply: { enabled: false, text: '', from: null, to: null },
    notifications: { browser: false, tabCounter: false },
    quoteOriginalOnReply: true,
    afterDelete: 'next-message',
    autoCollectContacts: false,
  };
  const patch = fromWebGeneral(dto);
  assert.equal(patch.senderName, null, 'пустое имя отправителя не должно превращаться в пробелы');
  assert.equal(patch.afterDelete, 'next');
  assert.equal(patch.notifyTab, false);
  assert.equal(patch.collectContacts, false);
  assert.equal(patch.autoReply?.until, null);

  const back = toWebGeneral(
    { ...defaultMailSettings('u@mail.local'), afterDelete: 'list' },
    [],
  );
  assert.equal(back.afterDelete, 'list');
});

test('правило: внутреннее -> DTO интерфейса', () => {
  const rule: FilterRule = {
    id: 12,
    name: 'От: buh@example.com',
    position: 0,
    enabled: true,
    auto: false,
    matchMode: 'all',
    conditions: [
      { field: 'from', op: 'contains', value: 'buh@example.com' },
      { field: 'size', op: 'greater', value: '500' },
    ],
    actions: {
      ...DEFAULT_ACTIONS,
      folder: 'Счета',
      markRead: true,
      flag: true,
      forwardTo: ['boss@example.com'],
      autoReply: { subject: null, text: 'Принято', days: 7 },
      applyToSpam: true,
      continueFiltering: false,
    },
  };
  const dto = toWebRule(rule, FOLDERS);
  assert.equal(dto.id, '12', 'идентификатор в контракте — строка');
  assert.equal(dto.actions.moveToFolderId, 'f-0YHRh9C10YLQsA', 'папка отдаётся идентификатором');
  assert.equal(dto.actions.markFlagged, true);
  assert.equal(dto.actions.forwardTo, 'boss@example.com');
  assert.equal(dto.actions.autoReply, 'Принято');
  assert.equal(dto.actions.continueOtherFilters, false);
  assert.equal(dto.actions.applyToSpam, true);
  assert.deepEqual(dto.conditions, [
    { field: 'from', operator: 'contains', value: 'buh@example.com' },
    { field: 'size', operator: 'greater', value: '500' },
  ]);
  assert.deepEqual(dto.actions.applyToExistingFolderIds, [], 'разовое действие в правиле не хранится');
});

test('правило: DTO -> внутреннее, «совпадает с» становится :is', () => {
  const dto: WebFilterRule = {
    id: '',
    enabled: true,
    auto: false,
    conditions: [
      { field: 'subject', operator: 'equals', value: 'Счёт' },
      { field: 'cc', operator: 'not-contains', value: 'noreply' },
    ],
    actions: {
      moveToFolderId: 'inbox',
      markRead: false,
      markFlagged: true,
      applyToExistingFolderIds: ['inbox'],
      forwardTo: 'copy@example.com',
      autoReply: '  ',
      continueOtherFilters: true,
      applyToSpam: false,
    },
  };
  const input = fromWebRule(dto, FOLDERS);
  assert.equal(input.matchMode, 'all');
  assert.deepEqual(input.conditions, [
    { field: 'subject', op: 'is', value: 'Счёт' },
    { field: 'cc', op: 'not-contains', value: 'noreply' },
  ]);
  assert.equal(input.actions.folder, 'INBOX', 'папка сохраняется путём IMAP');
  assert.deepEqual(input.actions.forwardTo, ['copy@example.com']);
  assert.equal(input.actions.autoReply, null, 'пробельный автоответ — это отсутствие автоответа');
  assert.equal(input.name, 'Тема: Счёт');
});

test('правило переживает оборот DTO -> внутреннее -> DTO', () => {
  const dto: WebFilterRule = {
    id: '5',
    enabled: false,
    auto: true,
    conditions: [{ field: 'from', operator: 'contains', value: 'a@b' }],
    actions: {
      moveToFolderId: 'f-0YHRh9C10YLQsA',
      markRead: true,
      markFlagged: false,
      applyToExistingFolderIds: [],
      forwardTo: null,
      autoReply: null,
      continueOtherFilters: false,
      applyToSpam: true,
    },
  };
  const input = fromWebRule(dto, FOLDERS);
  const back = toWebRule(
    { id: 5, position: 0, ...input, name: input.name },
    FOLDERS,
  );
  assert.deepEqual(back, dto);
});

test('имя правила выводится из первого условия', () => {
  assert.equal(ruleNameFrom([]), 'Все письма');
  assert.equal(
    ruleNameFrom([{ field: 'from', op: 'contains', value: 'a@b' }]),
    'От: a@b',
  );
  assert.equal(
    ruleNameFrom([{ field: 'resent-to', op: 'is', value: 'list@x' }]),
    'Переадресовано для: list@x',
  );
  const long = 'x'.repeat(60);
  assert.ok(ruleNameFrom([{ field: 'subject', op: 'contains', value: long }]).endsWith('…'));
});

test('состояние сборщика переводится в три состояния контракта', () => {
  assert.equal(toWebStatus('running'), 'syncing');
  assert.equal(toWebStatus('error'), 'error');
  assert.equal(toWebStatus('partial'), 'error', 'потерянные письма — это ошибка, а не «ок»');
  assert.equal(toWebStatus('ok'), 'ok');
  assert.equal(toWebStatus('never'), 'ok');
});

/* ------------------------------------------------------------------ */
/* Логотипы отправителей                                               */
/* ------------------------------------------------------------------ */

test('логотипы отправителей: значение доходит до заплатки в обе стороны', () => {
  const settings = { ...defaultMailSettings('a@mail.local'), senderLogos: true };
  const dto = toWebGeneral(settings, []);
  assert.equal(dto.showSenderLogos, true);
  assert.equal(fromWebGeneral(dto).senderLogos, true);
  assert.equal(fromWebGeneral({ ...dto, showSenderLogos: false }).senderLogos, false);
});

test('логотипы отправителей: тело БЕЗ поля не гасит настройку молча', () => {
  /*
   * Тот же контракт правит админка (admin/user-settings.ts), и о поле она
   * не знает. Отсутствие поля обязано означать «не трогать»: иначе каждое
   * сохранение из панели выключало бы человеку логотипы, и он бы гадал,
   * почему они пропадают сами.
   */
  const dto = toWebGeneral(defaultMailSettings('a@mail.local'), []);
  delete dto.showSenderLogos;
  assert.equal('senderLogos' in fromWebGeneral(dto), false);
});

test('логотипы отправителей: маршрут не выбрасывает поле из тела запроса', async () => {
  /*
   * Ошибка, найденная на живом стенде: поля не было в схеме zod, а zod
   * молча выбрасывает незнакомое. Интерфейс слал настройку, сервер отвечал
   * «сохранено», в базе оставалось прежнее. Проверяем именно схему.
   */
  const { generalSchema } = await import('./routes.js');
  const parsed = generalSchema.parse({ senderName: 'x', showSenderLogos: true });
  assert.equal(parsed.showSenderLogos, true);
  // А тело без поля остаётся телом без поля — значения по умолчанию нет.
  assert.equal(generalSchema.parse({ senderName: 'x' }).showSenderLogos, undefined);
});

/* ------------------------------------------------------------------ */
/* Отмена отправки                                                     */
/* ------------------------------------------------------------------ */

test('срок отмены отправки доходит до заплатки в обе стороны', () => {
  const settings = { ...defaultMailSettings('a@mail.local'), undoSendSeconds: 30 };
  const dto = toWebGeneral(settings, []);
  assert.equal(dto.undoSendSeconds, 30);
  assert.equal(fromWebGeneral(dto).undoSendSeconds, 30);
  // Ноль — это «выключено», а не «поле не заполнено»: его обязано доносить
  // так же честно, иначе выключить отмену было бы нечем
  assert.equal(fromWebGeneral({ ...dto, undoSendSeconds: 0 }).undoSendSeconds, 0);
});

test('срок отмены отправки: тело БЕЗ поля не гасит настройку молча', () => {
  // Та же беда, что и с логотипами: этот контракт правит админка, которая
  // о поле не знает. Без этого сохранение оттуда молча возвращало бы
  // человеку отправку без отмены.
  const dto = toWebGeneral(defaultMailSettings('a@mail.local'), []);
  delete dto.undoSendSeconds;
  assert.equal('undoSendSeconds' in fromWebGeneral(dto), false);
});

test('срок отмены отправки: схема принимает только разрешённые значения', async () => {
  const { generalSchema } = await import('./routes.js');
  for (const seconds of [0, 5, 10, 30]) {
    assert.equal(generalSchema.parse({ undoSendSeconds: seconds }).undoSendSeconds, seconds);
  }
  // Обратный ход: чужое значение не принимается вовсе. Сервер держит письмо
  // ровно столько, сколько сказано, и «3600» превратило бы настройку
  // в способ задержать почту на час.
  assert.throws(() => generalSchema.parse({ undoSendSeconds: 3600 }));
  assert.throws(() => generalSchema.parse({ undoSendSeconds: 7 }));
  assert.equal(generalSchema.parse({ senderName: 'x' }).undoSendSeconds, undefined);
});

test('по умолчанию отмена включена и равна пяти секундам', () => {
  // Возможность, которую надо сперва найти в настройках, не спасёт никого:
  // ошибку, от которой она спасает, иначе не исправить ничем.
  assert.equal(defaultMailSettings('a@mail.local').undoSendSeconds, 5);
});
