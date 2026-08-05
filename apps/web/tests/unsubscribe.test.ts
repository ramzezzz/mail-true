/**
 * «Отписаться» — по заголовку List-Unsubscribe.
 *
 * Проверка `'List-Unsubscribe' in message.headers` не срабатывала никогда:
 * сервер отдаёт имена заголовков в НИЖНЕМ регистре. Проверено живым ответом
 * `GET /api/messages/inbox:209`:
 *
 *   "headers": {"authentication-results": "ORIGINATING; auth=pass …"}
 *
 * Второй слой той же беды — на стороне API: mailparser сводит всю группу
 * `list-*` в один ключ `list`, поэтому `headers.get('list-unsubscribe')`
 * возвращает undefined и заголовок вообще не доходит до интерфейса (в том же
 * ответе `headers` пришли пустыми, хотя письмо отправлено с List-Unsubscribe).
 * Здесь мы понимаем оба варианта — и отдельный заголовок, и сводный `list`.
 */

import { describe, expect, it } from 'vitest';
import { canUnsubscribe, unsubscribeLinks } from '../src/lib/unsubscribe';

describe('unsubscribeLinks', () => {
  it('находит заголовок в нижнем регистре — так его и отдаёт сервер', () => {
    const headers = {
      'list-unsubscribe': '<mailto:unsub@example.com>, <https://example.com/unsub?u=1>',
    };
    // Старая проверка: 'List-Unsubscribe' in headers === false
    expect('List-Unsubscribe' in headers).toBe(false);
    expect(canUnsubscribe(headers)).toBe(true);
    expect(unsubscribeLinks(headers)).toEqual({
      mailto: 'mailto:unsub@example.com',
      http: 'https://example.com/unsub?u=1',
      oneClick: false,
    });
  });

  it('понимает и заголовок с заглавных — сервер может измениться', () => {
    expect(canUnsubscribe({ 'List-Unsubscribe': '<https://example.com/u>' })).toBe(true);
  });

  it('понимает сводный ключ list — так их складывает mailparser', () => {
    expect(canUnsubscribe({ list: '<mailto:unsub@example.com>' })).toBe(true);
  });

  it('замечает отписку в одно нажатие (RFC 8058)', () => {
    const links = unsubscribeLinks({
      'list-unsubscribe': '<https://example.com/u>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    });
    expect(links?.oneClick).toBe(true);
  });

  it('терпит адрес без угловых скобок', () => {
    expect(unsubscribeLinks({ 'list-unsubscribe': 'https://example.com/u' })?.http).toBe(
      'https://example.com/u',
    );
  });

  it('в обычном письме отписки нет', () => {
    expect(unsubscribeLinks({ 'return-path': 'a@example.com' })).toBeNull();
    expect(canUnsubscribe({})).toBe(false);
    expect(canUnsubscribe(null)).toBe(false);
  });

  it('пустой заголовок кнопки не рисует', () => {
    expect(canUnsubscribe({ 'list-unsubscribe': '' })).toBe(false);
    expect(canUnsubscribe({ 'list-unsubscribe': '<ftp://example.com/u>' })).toBe(false);
  });
});
