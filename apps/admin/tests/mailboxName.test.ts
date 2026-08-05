/**
 * Пределы длины адреса и отображаемого имени.
 *
 * Предела у имени ящика раньше не было вовсе: проверялся только адрес
 * целиком, и то в символах — 240-буквенное имя до «@» проходило, хотя
 * почтовый протокол таких не принимает. Здесь закреплены и сами числа,
 * и то, что отказ объясняется словами.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_MAX_BYTES,
  ADDRESS_MAX_CHARS,
  DISPLAY_NAME_MAX_CHARS,
  LOCAL_PART_MAX_BYTES,
  byteLength,
  charLength,
  checkDisplayName,
  checkMailboxAddress,
} from '../src/lib/mailboxName';
import {
  ADDRESS_MAX_BYTES as API_ADDRESS_MAX_BYTES,
  ADDRESS_MAX_CHARS as API_ADDRESS_MAX_CHARS,
  DISPLAY_NAME_MAX_CHARS as API_DISPLAY_NAME_MAX_CHARS,
  LOCAL_PART_MAX_BYTES as API_LOCAL_PART_MAX_BYTES,
  addressLengthProblem,
} from '../../api/src/admin/address-limits';

const domain = '@mail.local';

describe('числа пределов', () => {
  it('взяты из спецификации и из схемы базы', () => {
    expect(LOCAL_PART_MAX_BYTES).toBe(64); // RFC 5321
    expect(ADDRESS_MAX_BYTES).toBe(320); // RFC 5321
    expect(ADDRESS_MAX_CHARS).toBe(255); // virtual_users.email VARCHAR(255)
    expect(DISPLAY_NAME_MAX_CHARS).toBe(255); // virtual_users.display_name
  });

  it('совпадают с серверными — иначе интерфейс обещал бы одно, а сервер делал другое', () => {
    expect(LOCAL_PART_MAX_BYTES).toBe(API_LOCAL_PART_MAX_BYTES);
    expect(ADDRESS_MAX_BYTES).toBe(API_ADDRESS_MAX_BYTES);
    expect(ADDRESS_MAX_CHARS).toBe(API_ADDRESS_MAX_CHARS);
    expect(DISPLAY_NAME_MAX_CHARS).toBe(API_DISPLAY_NAME_MAX_CHARS);
  });
});

describe('длина в байтах, а не в символах', () => {
  it('кириллическая буква занимает два байта', () => {
    expect(byteLength('и')).toBe(2);
    expect(charLength('и')).toBe(1);
    expect(byteLength('i')).toBe(1);
  });
});

describe('checkMailboxAddress', () => {
  it('обычный адрес проходит', () => {
    expect(checkMailboxAddress('ivan@mail.local')).toBeNull();
    expect(checkMailboxAddress('')).toBeNull();
  });

  it('ровно 64 байта до «@» — ещё можно', () => {
    expect(checkMailboxAddress('a'.repeat(64) + domain)).toBeNull();
  });

  it('65 байт до «@» — уже нельзя', () => {
    const problem = checkMailboxAddress('a'.repeat(65) + domain);
    expect(problem).not.toBeNull();
    expect(problem).toContain('64');
    expect(problem).toContain('65');
  });

  it('33 русские буквы — это 66 байт, и они не проходят', () => {
    // Ровно тот случай, ради которого предел считается в байтах:
    // символов всего 33, а места занято больше 64.
    const name = 'и'.repeat(33);
    expect(charLength(name)).toBe(33);
    expect(byteLength(name)).toBe(66);

    const problem = checkMailboxAddress(name + domain);
    expect(problem).not.toBeNull();
    expect(problem).toContain('66');
    expect(problem).toContain('байт');
    // Про два байта на букву сказано прямо, иначе «33 символа много» звучит дико
    expect(problem).toContain('два байта');
  });

  it('32 русские буквы — 64 байта, проходит впритык', () => {
    expect(checkMailboxAddress('и'.repeat(32) + domain)).toBeNull();
  });

  it('отказ написан по-человечески, а не кодом ошибки', () => {
    const problem = checkMailboxAddress('a'.repeat(100) + domain) ?? '';
    expect(problem).toContain('Имя ящика');
    expect(problem).not.toMatch(/VALIDATION|too_big|invalid/u);
  });

  it('слишком длинный адрес целиком тоже отбивается', () => {
    // Локальная часть в пределах, а домен огромный
    const address = `a@${'d'.repeat(400)}.local`;
    const problem = checkMailboxAddress(address);
    expect(problem).not.toBeNull();
  });

  it('интерфейс и сервер отвечают одинаково', () => {
    for (const address of [
      'ivan@mail.local',
      'a'.repeat(65) + domain,
      'и'.repeat(33) + domain,
      'a'.repeat(64) + domain,
    ]) {
      expect(checkMailboxAddress(address)).toBe(addressLengthProblem(address));
    }
  });
});

describe('checkDisplayName', () => {
  it('255 символов проходят, 256 — нет', () => {
    expect(checkDisplayName('и'.repeat(255))).toBeNull();
    const problem = checkDisplayName('и'.repeat(256));
    expect(problem).not.toBeNull();
    expect(problem).toContain('256');
  });

  it('предел назван в символах — так и проверяется', () => {
    // 255 кириллических букв — это 510 байт, и это НЕ повод отказать:
    // колонка в Postgres считает символы. Говорим то, что правда.
    expect(byteLength('и'.repeat(255))).toBe(510);
    expect(checkDisplayName('и'.repeat(255))).toBeNull();
    expect(checkDisplayName('и'.repeat(256))).toContain('символ');
  });
});
