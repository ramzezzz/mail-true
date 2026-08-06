/**
 * Сохранённые поисковые запросы: обращения к API.
 *
 * Сохранённый запрос — это ИМЯ и СТРОКА поиска, а не папка. Разница не
 * косметическая: в папку можно переложить письмо, её можно очистить и
 * переименовать, а письмо из неё лежит именно там. Сохранённый запрос
 * ничего этого не умеет и уметь не должен — он лишь открывает тот же
 * поиск заново. Поэтому и показан он отдельной группой со значком лупы,
 * а не подделкой под папку (так делает Thunderbird, и это сбивает).
 */

import { apiFetch } from '../api/http';
import { useMocks } from '../api/mockFlag';

export interface SavedSearch {
  id: string;
  name: string;
  /** Строка поиска со всеми операторами, как её набрал человек. */
  query: string;
  /** Искать ли в Спаме и Корзине. */
  includeJunk: boolean;
  position: number;
}

/**
 * Состояние возможности целиком.
 *
 * `available: false` значит, что запросы негде хранить (не настроена база
 * или не применена миграция). Тогда интерфейс УБИРАЕТ и кнопку «Сохранить
 * запрос», и группу в левой колонке, а не показывает их и потом отказывает
 * — то же правило, что у меток и отложенных писем.
 */
export interface SavedSearchesState {
  available: boolean;
  reason: string | null;
  items: SavedSearch[];
}

export const SAVED_SEARCHES_UNAVAILABLE: SavedSearchesState = {
  available: false,
  reason: null,
  items: [],
};

/*
 * На заглушках запроса нет вовсе — то же правило, что у меток
 * (mail/labelsApi.ts) и отложенных писем. Своего хранилища у заглушек нет,
 * а сходить на настоящий адрес нельзя: без сессии он отвечает 401, и общий
 * обработчик уводит на экран входа из режима, где входа не предполагается.
 */
const ON_MOCKS: SavedSearchesState = {
  available: false,
  reason: 'На заглушечных данных сохранённые запросы не ведутся',
  items: [],
};

export interface SavedSearchDraft {
  name: string;
  query: string;
  includeJunk: boolean;
}

export const savedSearchesApi = {
  getSavedSearches: (): Promise<SavedSearchesState> => {
    if (useMocks) return Promise.resolve(ON_MOCKS);
    return apiFetch('/api/searches');
  },

  createSavedSearch: (draft: SavedSearchDraft): Promise<SavedSearch> =>
    apiFetch('/api/searches', { method: 'POST', body: JSON.stringify(draft) }),

  deleteSavedSearch: (id: string): Promise<{ ok: boolean; id: string; name: string }> =>
    apiFetch(`/api/searches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
