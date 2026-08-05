/**
 * Тесты учёта копий при дедупликации.
 *
 * Разбирается дефект: второй проход переноса (дельта в день переключения MX)
 * терял законно новые письма. Ключом служил Message-ID, а без него — хеш от
 * Date+From+To+Subject+размера, и решение принималось по принципу
 * «ключ встречался — значит дубль».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DedupLedger, dedupKey } from '../dedup.js';
import { FileStateStore } from '../state.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('DedupLedger', () => {
  it('пропускает ровно столько писем, сколько копий лежит в приёмнике', () => {
    const l = new DedupLedger();
    l.setPresent('mid:a@x', 1); // в приёмнике одна копия
    assert.equal(l.consume('mid:a@x'), true); // первое письмо источника — дубль
    assert.equal(l.consume('mid:a@x'), false); // второе — НОВОЕ, переносим
  });

  it('повторно использованный Message-ID не съедает второе письмо', () => {
    // Первый проход: письмо с Message-ID <auto@srv> перенесено.
    const l = new DedupLedger();
    const key = dedupKey({ messageId: '<auto@srv>' }, 1000);
    l.setPresent(key, 1);
    // Второй проход: в источнике то же письмо и новое с тем же Message-ID.
    assert.equal(l.consume(key), true);
    assert.equal(l.consume(key), false); // до исправления здесь было true
  });

  it('автоуведомления без Message-ID с одинаковыми заголовками и размером', () => {
    const headers = {
      date: 'Tue, 5 Aug 2026 10:00:00 +0300',
      from: 'robot@bank.example',
      to: 'ivanov@mail.local',
      subject: 'Операция по счёту',
    };
    const key = dedupKey(headers, 4096);
    assert.equal(dedupKey({ ...headers }, 4096), key); // ключ действительно совпадает
    const l = new DedupLedger();
    l.setPresent(key, 1); // одно такое уведомление уже перенесли
    assert.equal(l.consume(key), true);
    assert.equal(l.consume(key), false); // второе — новое, обязано переехать
  });

  it('число доступных копий задаётся явно и не накапливается', () => {
    const l = new DedupLedger();
    l.setPresent('k', 1);
    l.setPresent('k', 1); // повторный расчёт того же ключа ничего не удваивает
    assert.equal(l.presentCount('k'), 1);
    assert.equal(l.consume('k'), true);
    assert.equal(l.consume('k'), false);
  });

  it('при дельта-проходе доступных копий не остаётся: 1 в приёмнике - 1 перенесённая', () => {
    // Полный проход уже перенёс копию, письмо-источник в дельту не попало
    // (его UID меньше курсора) — значит, «съесть» новое письмо оно не может.
    const l = new DedupLedger();
    const inDest = 1;
    const inState = 1;
    l.setPresent('k', Math.max(0, inDest - inState));
    assert.equal(l.presentCount('k'), 0);
    assert.equal(l.consume('k'), false); // новое письмо переносится
  });

  it('при полном проходе берётся максимум из приёмника и состояния', () => {
    const l = new DedupLedger();
    l.setPresent('k', Math.max(2, 1));
    assert.equal(l.presentCount('k'), 2);
    assert.equal(l.consume('k'), true);
    assert.equal(l.consume('k'), true);
    assert.equal(l.consume('k'), false);
  });

  it('только что перенесённая копия не считается «уже была» для следующего письма', () => {
    const l = new DedupLedger();
    assert.equal(l.consume('k'), false); // копий нет — переносим
    l.markCopied('k');
    assert.equal(l.consume('k'), false); // следующее письмо с тем же ключом — тоже новое
  });
});

describe('FileStateStore: счётчик копий', () => {
  it('считает копии, а не факт переноса', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-state-'));
    try {
      const store = new FileStateStore(join(dir, 'state.jsonl'));
      await store.init();
      assert.equal(await store.migratedCount('acc', 'INBOX', 'k'), 0);
      await store.markMigrated('acc', 'INBOX', 'k');
      await store.markMigrated('acc', 'INBOX', 'k');
      // До исправления вторая запись отбрасывалась и здесь была бы единица
      assert.equal(await store.migratedCount('acc', 'INBOX', 'k'), 2);
      assert.equal(await store.wasMigrated('acc', 'INBOX', 'k'), true);

      // Журнал переживает перезапуск вместе со счётчиком
      const again = new FileStateStore(join(dir, 'state.jsonl'));
      await again.init();
      assert.equal(await again.migratedCount('acc', 'INBOX', 'k'), 2);
      assert.equal(await again.migratedCount('acc', 'INBOX', 'other'), 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
