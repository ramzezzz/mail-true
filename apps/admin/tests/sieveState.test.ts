/**
 * Судьба личного файла правил ящика — словами.
 *
 * Дефект найден на живом стенде: сервер приложения работает в контейнере
 * без sievec, поэтому КАЖДОЕ сохранение фильтров возвращало ok=false, а
 * интерфейс на это объявлял «фильтры и автоответчик работать не будут».
 * Правила при этом были записаны и работали — их собирает сам Dovecot при
 * доставке. Пугать администратора на ровном месте нельзя ровно так же,
 * как и молчать о настоящей беде: если файл НЕ записан, в ящике остались
 * прежние правила, а человек уверен, что поменял их.
 */
import { describe, expect, it } from 'vitest';
import type { SieveSyncState } from '../src/api/types';
import { sieveNotice } from '../src/lib/sieveState';

function state(over: Partial<SieveSyncState> = {}): SieveSyncState {
  return {
    transport: 'local',
    path: '/var/mail/vhosts/mail.local/demo/.dovecot.sieve',
    activeRules: 4,
    ok: true,
    written: true,
    error: '',
    ...over,
  };
}

describe('состояние файла правил', () => {
  it('всё записано и проверено — спокойное сообщение', () => {
    const notice = sieveNotice(state());
    expect(notice?.tone).toBe('success');
    expect(notice?.text).toContain('4 действующих правил');
  });

  it('записано, но проверить нечем — это не беда и красным не показывается', () => {
    const notice = sieveNotice(
      state({ ok: false, written: true, error: 'рядом нет компилятора Sieve (sievec)' }),
    );
    expect(notice?.tone).toBe('info');
    expect(notice?.text).toContain('обновлён');
    // Ни слова о том, что фильтры не работают: они работают.
    expect(notice?.text).not.toMatch(/не будут|НЕ обновлён/);
  });

  it('файл не записан — вот это беда, и сказано прямо', () => {
    const notice = sieveNotice(
      state({ ok: false, written: false, error: 'ошибка компиляции в строке 3' }),
    );
    expect(notice?.tone).toBe('error');
    expect(notice?.text).toContain('НЕ обновлён');
    // Главное последствие названо: в ящике действуют СТАРЫЕ правила.
    expect(notice?.text).toContain('прежние правила');
  });

  it('состояния нет — и сообщения нет', () => {
    expect(sieveNotice(null)).toBeNull();
  });
});
