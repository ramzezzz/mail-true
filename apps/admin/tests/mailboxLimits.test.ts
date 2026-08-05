/**
 * Пределы длины и форма почтового адреса.
 *
 * Предела у имени ящика раньше не было вовсе: проверялся только адрес
 * целиком, и то в символах — 200-буквенное имя до «@» проходило молча, хотя
 * почтовый протокол таких не принимает. А форму проверял zod, и любая
 * опечатка возвращалась одинаковым «Некорректные данные запроса».
 *
 * Правила лежат в packages/shared, и оттуда же их берут и панель, и сервер.
 * Отдельной проверки «числа совпадают» здесь нет нарочно: совпадение
 * обеспечено тем, что источник один, а не тем, что кто-то за ним следит.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_MAX_BYTES,
  ADDRESS_MAX_CHARS,
  DISPLAY_NAME_MAX_CHARS,
  LOCAL_PART_MAX_BYTES,
  addressLengthProblem,
  addressProblem,
  addressProblemWhileTyping,
  byteLength,
  charLength,
  displayNameLengthProblem,
} from '@shared/mailbox-limits';

const domain = '@mail.local';

describe('числа пределов', () => {
  it('взяты из спецификации и из схемы базы', () => {
    expect(LOCAL_PART_MAX_BYTES).toBe(64); // RFC 5321, октеты
    expect(ADDRESS_MAX_BYTES).toBe(320); // RFC 5321, октеты
    expect(ADDRESS_MAX_CHARS).toBe(255); // virtual_users.email VARCHAR(255)
    expect(DISPLAY_NAME_MAX_CHARS).toBe(255); // virtual_users.display_name
  });
});

describe('длина в байтах, а не в символах', () => {
  it('кириллическая буква занимает два байта', () => {
    expect(byteLength('и')).toBe(2);
    expect(charLength('и')).toBe(1);
    expect(byteLength('i')).toBe(1);
  });
});

describe('длина адреса', () => {
  it('обычный адрес проходит', () => {
    expect(addressLengthProblem('ivan@mail.local')).toBeNull();
  });

  it('ровно 64 байта до «@» — ещё можно, 65 — уже нет', () => {
    expect(addressLengthProblem('a'.repeat(64) + domain)).toBeNull();
    const problem = addressLengthProblem('a'.repeat(65) + domain);
    expect(problem).not.toBeNull();
    expect(problem).toContain('64');
    expect(problem).toContain('65');
  });

  it('предел считается в октетах: 33 русские буквы — это 66 байт', () => {
    const name = 'и'.repeat(33);
    expect(charLength(name)).toBe(33);
    expect(byteLength(name)).toBe(66);

    const problem = addressLengthProblem(name + domain);
    expect(problem).not.toBeNull();
    expect(problem).toContain('66');
    expect(problem).toContain('байт');
    // Про два байта на букву сказано прямо, иначе «33 символа много» звучит дико
    expect(problem).toContain('два байта');

    // 32 буквы — ровно 64 байта, впритык проходит
    expect(addressLengthProblem('и'.repeat(32) + domain)).toBeNull();
  });

  it('локальная часть в 200 символов больше не проходит молча', () => {
    expect(addressProblem('a'.repeat(200) + domain)).not.toBeNull();
  });

  it('слишком длинный адрес целиком тоже отбивается', () => {
    expect(addressLengthProblem(`a@${'d'.repeat(400)}.local`)).not.toBeNull();
  });

  it('отказ написан по-человечески, а не кодом ошибки', () => {
    const problem = addressProblem('a'.repeat(100) + domain) ?? '';
    expect(problem).toContain('Имя ящика');
    expect(problem).not.toMatch(/VALIDATION|too_big|invalid/u);
  });
});

describe('форма адреса', () => {
  it('кириллица объясняется раскладкой, а не общей ошибкой', () => {
    const problem = addressProblem('иван@mail.local');
    expect(problem).not.toBeNull();
    expect(problem).toContain('латин');
    expect(problem).toContain('раскладка');
    expect(problem).not.toContain('Некорректные данные запроса');
  });

  it('разные беды объясняются по-разному, а не одной фразой на всё', () => {
    const messages = [
      'ivan',
      'ivan@maillocal',
      'иван@mail.local',
      'ivan mail@mail.local',
      'ivan@@mail.local',
      'a'.repeat(65) + domain,
    ].map((a) => addressProblem(a));
    for (const m of messages) expect(m).not.toBeNull();
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('правильный адрес претензий не вызывает', () => {
    for (const a of ['ivan@mail.local', 'i.petrov+work@sub.mail.local', 'a1@b.co']) {
      expect(addressProblem(a)).toBeNull();
    }
  });

  it('пустое поле при наборе не ругается, а пустой адрес на отправке — да', () => {
    expect(addressProblemWhileTyping('')).toBeNull();
    expect(addressProblemWhileTyping('   ')).toBeNull();
    expect(addressProblem('')).not.toBeNull();
  });
});

describe('отображаемое имя', () => {
  it('255 символов проходят, 256 — нет', () => {
    expect(displayNameLengthProblem('и'.repeat(255))).toBeNull();
    const problem = displayNameLengthProblem('и'.repeat(256));
    expect(problem).not.toBeNull();
    expect(problem).toContain('256');
  });

  it('предел назван в символах — так и проверяется', () => {
    // 255 кириллических букв — это 510 байт, и это НЕ повод отказать:
    // колонка в Postgres считает символы. Говорим то, что правда.
    expect(byteLength('и'.repeat(255))).toBe(510);
    expect(displayNameLengthProblem('и'.repeat(255))).toBeNull();
    expect(displayNameLengthProblem('и'.repeat(256))).toContain('символ');
  });
});
