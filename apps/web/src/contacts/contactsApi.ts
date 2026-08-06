/**
 * Клиент подсказки адреса.
 *
 * Отказ здесь НИКОГДА не поднимается наверх. Подсказка — помощь, а не
 * действие: сервер не ответил — значит, поле «Кому» работает ровно так
 * же, как работало до появления подсказки. Показывать человеку сообщение
 * об ошибке в тот момент, когда он просто набирает адрес, значит мешать
 * ему сильнее, чем отсутствие подсказки.
 */

/** Одна строка подсказки — то, что отдаёт GET /api/contacts/suggest. */
export interface ContactSuggestion {
  address: string;
  name: string | null;
  /** Человек писал по этому адресу сам. */
  own: boolean;
}

export interface ContactSuggestResponse {
  items: ContactSuggestion[];
  /** Указатель переписки разобран целиком. */
  complete: boolean;
}

export const EMPTY_SUGGESTIONS: ContactSuggestResponse = { items: [], complete: false };

/**
 * Спрашивает подсказку.
 *
 * `signal` обязателен по смыслу, хоть и необязателен по типу: человек
 * печатает быстрее, чем отвечает сеть, и ответ на позавчерашние буквы,
 * пришедший последним, перезаписал бы список под курсором.
 */
export async function fetchContactSuggestions(
  query: string,
  exclude: readonly string[],
  signal?: AbortSignal,
): Promise<ContactSuggestResponse> {
  const params = new URLSearchParams({ q: query });
  if (exclude.length > 0) params.set('exclude', exclude.join(','));
  try {
    const response = await fetch(`/api/contacts/suggest?${params.toString()}`, {
      credentials: 'same-origin',
      signal: signal ?? null,
    });
    if (!response.ok) return EMPTY_SUGGESTIONS;
    const body = (await response.json()) as Partial<ContactSuggestResponse>;
    return {
      items: Array.isArray(body.items) ? body.items : [],
      complete: body.complete === true,
    };
  } catch {
    // Прерванный запрос — это норма, а не сбой: значит, человек уже
    // набрал следующую букву.
    return EMPTY_SUGGESTIONS;
  }
}

/**
 * Убирает адрес из подсказок навсегда (или возвращает обратно).
 *
 * Зачем это есть. Человек однажды ошибся буквой в адресе — и опечатка
 * попала в указатель переписки. Без этой возможности она предлагалась бы
 * ему год, стоя рядом с верным адресом и отличаясь одной буквой; выбирают
 * такое не глядя, и письмо снова уходит в никуда.
 */
export async function setContactHidden(address: string, hidden: boolean): Promise<boolean> {
  try {
    const response = await fetch(`/api/contacts/${hidden ? 'hide' : 'restore'}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
