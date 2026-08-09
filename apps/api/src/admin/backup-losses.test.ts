/**
 * Восстановление из копии не должно терять то, что в копии есть.
 *
 * ------------------------------------------------------------------
 * ДВЕ ПОТЕРИ, ОБЕ С ОТЧЁТОМ ОБ УСПЕХЕ
 * ------------------------------------------------------------------
 * 1. ТЕКСТ ПОДВАЛА СТРАНИЦЫ ВХОДА. В файл копии он попадал — выгрузка
 *    кладёт состояние оформления как есть, без схемы. А разбор файла шёл
 *    через zod, который по умолчанию ВЫБРАСЫВАЕТ неизвестные ключи, и
 *    поля loginFooter в схеме не было. Значит восстановление раздела
 *    «Оформление входа» из свежей копии ВСЕГДА затирало подвал пустотой.
 *    Место заметное: его читают, пока вводят пароль, и организации держат
 *    там телефон поддержки и порядок обращения.
 *
 * 2. ШЕСТЬ ПОЛЕЙ НАСТРОЕК ЯЩИКА: тема, обои, логотипы отправителей, срок
 *    отмены отправки, режим списка и срок восстановления из корзины.
 *    Выгрузка берёт строку целиком (SELECT *), поэтому в копии они были;
 *    восстановление писало только колонки из списка, написанного руками,
 *    а список отстал от схемы.
 *
 * Ни одна из потерь не была видна: отчёт показывал «обновлено», план
 * восстановления о них не предупреждал.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSettingsBackup } from './backup-format.js';

const source = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(name, import.meta.url).href.replace('/dist/', '/src/')),
    'utf8',
  );

/** Файл копии, снятой ПОСЛЕ появления подвала. */
function backupWithFooter(): string {
  return JSON.stringify({
    kind: 'mail.true/settings-backup',
    version: 1,
    createdAt: '2026-08-09T10:00:00.000Z',
    source: { hostname: 'mail.local', domain: 'mail.local' },
    data: {
      domains: [],
      mailboxes: [],
      aliases: [],
      userSettings: [],
      spam: null,
      ai: [],
      branding: {
        companyName: 'ООО «Ромашка»',
        productName: null,
        loginFooter: 'Поддержка: +7 495 000-00-00, обращения — через журнал',
        logo: null,
        logoBase64: null,
      },
    },
  });
}

test('подвал страницы входа переживает оборот через файл копии', () => {
  const parsed = parseSettingsBackup(backupWithFooter());
  assert.equal(
    parsed.data.branding?.loginFooter,
    'Поддержка: +7 495 000-00-00, обращения — через журнал',
    'схема выбрасывала неизвестные ключи — и подвал терялся молча',
  );
});

test('копия, снятая до появления подвала, читается по-прежнему', () => {
  /*
   * Поле остаётся необязательным намеренно: старые копии обязаны
   * восстанавливаться. Разница в том, что теперь этот путь для старых
   * копий, а не для всех подряд.
   */
  const old = JSON.parse(backupWithFooter()) as { data: { branding: Record<string, unknown> } };
  delete old.data.branding.loginFooter;
  const parsed = parseSettingsBackup(JSON.stringify(old));
  assert.equal(parsed.data.branding?.loginFooter, null);
});

test('в восстановление настроек ящика входят все колонки схемы', () => {
  const store = source('./backup-store.ts');
  const list = store.slice(
    store.indexOf('const USER_SETTINGS_COLUMNS'),
    store.indexOf('] as const;', store.indexOf('const USER_SETTINGS_COLUMNS')),
  );
  for (const column of [
    'theme',
    'wallpaper',
    'sender_logos',
    'undo_send_seconds',
    'threaded_list',
    'trash_recovery_days',
  ]) {
    assert.match(
      list,
      new RegExp(`'${column}'`),
      `${column} есть в копии, но не восстанавливался — настройка молча возвращалась к умолчанию`,
    );
  }
});

test('отсутствующее в копии поле не подставляется как NULL', () => {
  /*
   * Шесть добавленных колонок объявлены NOT NULL. Прежний код подставлял
   * отсутствующему полю null — и копия, снятая до их появления, уронила
   * бы восстановление целиком: починка одной потери устроила бы другую,
   * крупнее.
   */
  const store = source('./backup-store.ts');
  const block = store.slice(store.indexOf('async function restoreUserSettings'));
  assert.match(
    block.slice(0, 1800),
    /filter\(\(col\) => stored\[col\] !== undefined\)/,
    'колонки обязаны отбираться по наличию в копии',
  );
});
