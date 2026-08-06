/**
 * Сохранённые запросы: заглушки и сборка адреса.
 *
 * Главное здесь — режим заглушек. Интерфейс обязан работать без сервера
 * (VITE_API_MOCK), и раздел, за которым ничего нет, в этом режиме не должен
 * ни показываться, ни стучаться в несуществующий адрес: без сессии тот
 * ответит 401, и общий обработчик уведёт на экран входа из режима, где
 * входа не предполагается. Ровно на этом однажды сломались метки.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/mockFlag', () => ({ useMocks: true }));
vi.mock('../src/api/http', () => ({
  apiFetch: () => {
    throw new Error('На заглушках запроса к серверу быть не должно');
  },
  buildQuery: () => '',
}));

const { savedSearchesApi } = await import('../src/search/savedSearchesApi');

describe('savedSearchesApi на заглушках', () => {
  it('возможность честно объявлена недоступной, запроса к серверу нет', async () => {
    const state = await savedSearchesApi.getSavedSearches();
    expect(state.available).toBe(false);
    expect(state.items).toEqual([]);
    // Причина названа: интерфейс не молчит, а может её показать
    expect(state.reason).toBeTruthy();
  });
});
