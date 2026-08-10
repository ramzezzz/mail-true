/**
 * Тесты курсора папки и разбора отказов сервера.
 *
 * Разбирается главный найденный дефект: курсор состояния перешагивал через
 * неудавшиеся письма. Первый проход при нехватке квоты давал «скопировано 4,
 * ошибок 6» и курсор u:10; повторный запуск с тем же состоянием читал
 * источник с UID 11, докачивал ноль и рапортовал «ok, ошибок 0».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CursorTracker, describeImapError, isQuotaError } from '../migrator.js';

/** Ошибка в том виде, в каком её отдаёт imapflow при отказе команды. */
function imapError(
  message: string,
  extra: { serverResponseCode?: string; responseText?: string },
): Error {
  return Object.assign(new Error(message), extra);
}

describe('CursorTracker', () => {
  it('без единой ошибки доходит до конца папки', () => {
    const uids = [1, 2, 3, 4, 5];
    const c = new CursorTracker(uids, uids);
    for (const uid of uids) c.markCopied(uid);
    assert.equal(c.finish(), 5);
    assert.equal(c.isFrozen, false);
  });

  it('останавливается ПЕРЕД первым неудавшимся письмом', () => {
    // Ровно сценарий из отчёта: 10 писем, квоты хватило на четыре
    const uids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const c = new CursorTracker(uids, uids);
    for (const uid of uids) {
      if (uid <= 4) c.markCopied(uid);
      else c.markFailed(uid);
    }
    // До исправления здесь было 10 — и шесть писем не переезжали никогда
    assert.equal(c.finish(), 4);
    assert.equal(c.isFrozen, true);
  });

  it('одна ошибка в середине замораживает курсор, даже если дальше всё успешно', () => {
    const uids = [1, 2, 3, 4, 5];
    const c = new CursorTracker(uids, uids);
    c.markCopied(1);
    c.markCopied(2);
    c.markFailed(3);
    c.markCopied(4);
    c.markCopied(5);
    assert.equal(c.finish(), 2);
  });

  it('пропущенные дубли курсор не задерживают', () => {
    // metas — все письма папки, pending — только те, что переносим
    const uids = [1, 2, 3, 4, 5, 6];
    const c = new CursorTracker(uids, [3, 6]);
    c.markCopied(3);
    assert.equal(c.uid, 5); // 1,2 — дубли, 3 перенесено, 4,5 — дубли
    c.markCopied(6);
    assert.equal(c.finish(), 6);
  });

  it('назад не отматывается: прежнее значение курсора сохраняется', () => {
    const c = new CursorTracker([11, 12], [11, 12], 10);
    c.markFailed(11);
    assert.equal(c.finish(), 10);
  });

  it('пустая папка не сдвигает курсор', () => {
    const c = new CursorTracker([], [], 7);
    assert.equal(c.finish(), 7);
  });
});

describe('describeImapError', () => {
  it('отказ по квоте называет причину словами, а не «Command failed»', () => {
    const err = imapError('Command failed', {
      serverResponseCode: 'OVERQUOTA',
      responseText: 'Quota exceeded (mailbox for user is full)',
    });
    const text = describeImapError(err);
    assert.match(text, /квота/i);
    assert.match(text, /OVERQUOTA/);
    assert.match(text, /Quota exceeded/);
    assert.doesNotMatch(text, /^Command failed$/);
  });

  it('узнаёт квоту и по тексту ответа, без кода OVERQUOTA', () => {
    const err = imapError('Command failed', {
      responseText: 'Not enough disk space',
    });
    assert.match(describeImapError(err), /квота/i);
    assert.equal(isQuotaError(err), true);
  });

  it('обычный отказ показывает ответ сервера', () => {
    const err = imapError('Command failed', {
      responseText: "Character not allowed in mailbox name: '.'",
    });
    const text = describeImapError(err);
    assert.match(text, /Character not allowed/);
    assert.equal(isQuotaError(err), false);
  });

  it('ошибка без полей сервера не теряет собственное сообщение', () => {
    assert.equal(describeImapError(new Error('соединение оборвано')), 'соединение оборвано');
  });
});

describe('курсор и письма, которые даже не пробовали переносить', () => {
  it('письмо, отвергнутое до попытки, всё равно замораживает курсор', () => {
    /*
     * Письмо больше maxMessageSize попадает в «ошибок», но в список к
     * переносу не кладётся — то есть трекеру о нём никто не говорил, и
     * курсор через него проходил. Инвариант «курсор стоит перед первым
     * непереехавшим письмом» при этом нарушался молча: подняв предел,
     * повторный запуск это письмо уже не увидел бы никогда.
     */
    const uids = [1, 2, 3, 4, 5];
    // К переносу отобраны все, кроме третьего: он не прошёл по размеру.
    const c = new CursorTracker(uids, [1, 2, 4, 5]);
    c.markFailed(3);
    c.markCopied(1);
    c.markCopied(2);
    c.markCopied(4);
    c.markCopied(5);
    assert.equal(c.finish(), 2, 'курсор обязан встать перед непереехавшим письмом');
    assert.equal(c.isFrozen, true);
  });
});
