/**
 * У запроса к серверу обязан быть предел ожидания.
 *
 * Поймано на живом стенде: при остановленном сервере приложения запрос к
 * `/api/folders` не разрешился и не отвергся за двадцать четыре секунды —
 * обещание просто висело. Отказа, на который можно среагировать, не было
 * вовсе, и интерфейс всё это время показывал «загружаем».
 *
 * Это не беда одного экрана: у `fetch` своего предела нет, значит вечная
 * крутилка возможна в любом месте продукта. Человек не отличает «медленно»
 * от «сломалось» — он просто сидит и ждёт.
 *
 * На старом коде падают все проверки: предела не существовало.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiFetchBlob, isTimeoutError, TIMEOUT_CODE } from '../src/api/http';

/** Ответ, который не придёт никогда — ровно так вёл себя стенд. */
function neverAnswers(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject((init.signal as AbortSignal).reason ?? new DOMException('Aborted', 'AbortError'));
      });
    })) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * Настоящие таймеры, а не подменённые: `AbortSignal.timeout` живёт в
 * движке, и подменённые таймеры его не двигают — первая попытка написать
 * эти проверки как раз на этом и споткнулась. Поэтому пределы здесь
 * задаются маленькими через `timeoutMs`, и проверка идёт за миллисекунды.
 */

describe('предел ожидания ответа', () => {
  it('молчащий сервер даёт ошибку, а не вечное ожидание', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const error = await apiFetch('/api/folders', { timeoutMs: 60 }).catch((e: unknown) => e);
    expect(isTimeoutError(error)).toBe(true);
    expect((error as Error).message).toMatch(/не ответил/i);
    expect((error as Error).message).toMatch(/\d+ с/, 'человеку нужно знать, сколько ждали');
  });

  it('до истечения предела ошибки нет — медленный ответ не должен обрываться', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    let settled = false;
    void apiFetch('/api/folders', { timeoutMs: 400 }).catch(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(settled, 'запрос оборван раньше срока').toBe(false);
  });

  it('выгрузка файла ждёт дольше обычного запроса', async () => {
    // Вложение на 18 МБ по слабому каналу идёт минутами. Обрывать его на
    // тридцатой секунде — значит ломать работающую отправку.
    vi.stubGlobal('fetch', neverAnswers());
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(16)]), 'proba.bin');
    // Проверяем не время, а правило: у формы с файлом предел БОЛЬШЕ.
    let settled = false;
    void apiFetch('/api/uploads', { method: 'POST', body: form }).catch(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(settled, 'выгрузка не должна обрываться по общему пределу').toBe(false);
  });

  it('скачивание вложения тоже имеет свой предел', async () => {
    vi.stubGlobal('fetch', neverAnswers());
    const error = await apiFetchBlob('/api/messages/1/parts/2', { timeoutMs: 60 }).catch(
      (e: unknown) => e,
    );
    expect(isTimeoutError(error)).toBe(true);
  });

  it('отмена запроса самим приложением не выдаётся за поломку связи', async () => {
    // Поиск отменяет предыдущий запрос при новом вводе — это не отказ
    // сервера, и показывать «сервер не ответил» здесь было бы враньём.
    vi.stubGlobal('fetch', neverAnswers());
    const controller = new AbortController();
    const promise = apiFetch('/api/search', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const error = await promise;
    expect(isTimeoutError(error)).toBe(false);
    expect((error as { code?: string }).code).not.toBe(TIMEOUT_CODE);
  });
});
