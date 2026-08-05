/**
 * Заголовок с типом содержимого на запросах БЕЗ тела.
 *
 * Условие «ставим JSON везде, кроме формы с файлом» ставило заголовок и на
 * запросы вовсе без тела. Сервер такой запрос отвергает («Пустое тело
 * запроса»), и девять операций не работали вовсе, ничего об этом не сообщая:
 * очистка и удаление папки, удаление фильтра, проверка и удаление внешнего
 * ящика, отписка от рассылки, отзыв согласия помощника, удаление его ответов
 * — и выход из ящика.
 *
 * Выход был опаснее всех: ошибка глоталась, показывался экран входа, а сессия
 * на сервере продолжала действовать. На общем компьютере человек уверен, что
 * вышел, а почта доступна следующему.
 *
 * Заглушки поймать это не могли — они не делают HTTP-запросов вовсе. Поэтому
 * проверка смотрит на аргументы самого fetch, а не на поведение заглушки.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/api/http';

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Заголовки последнего запроса в виде обычного объекта. */
function lastHeaders(): Record<string, string> {
  const init = calls[calls.length - 1]?.init;
  return (init?.headers as Record<string, string> | undefined) ?? {};
}

describe('заголовок типа содержимого', () => {
  it('не ставится на запрос без тела', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    expect(lastHeaders()['Content-Type']).toBeUndefined();
  });

  it('не ставится на DELETE без тела', async () => {
    await apiFetch('/api/settings/filters/7', { method: 'DELETE' });
    expect(lastHeaders()['Content-Type']).toBeUndefined();
  });

  it('не ставится на обычный GET', async () => {
    await apiFetch('/api/messages');
    expect(lastHeaders()['Content-Type']).toBeUndefined();
  });

  it('ставится, когда тело есть', async () => {
    await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@b.c' }),
    });
    expect(lastHeaders()['Content-Type']).toBe('application/json');
  });

  it('не ставится на форму с файлом: границу частей выставляет сам браузер', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    await apiFetch('/api/attachments', { method: 'POST', body: form });
    expect(lastHeaders()['Content-Type']).toBeUndefined();
  });

  it('пустая строка в теле не считается телом', async () => {
    // JSON.stringify(undefined) даёт undefined, а не строку: такой запрос
    // уходит без тела, и заголовок на нём тоже лишний.
    await apiFetch('/api/folders/x/clear', { method: 'POST', body: null });
    expect(lastHeaders()['Content-Type']).toBeUndefined();
  });
});
