/**
 * Подсказка адреса: задержка перед запросом и память об уже полученном.
 *
 * ------------------------------------------------------------------
 * ЦЕНА ПОДСКАЗКИ
 * ------------------------------------------------------------------
 * Два правила, и оба про одно — про то, чтобы подсказка не стоила
 * дороже, чем помогает.
 *
 *   1. Запрос НЕ уходит на каждую букву. Человек, набирающий «петров»,
 *      породил бы шесть запросов, из которых пять заведомо ненужные:
 *      их ответы устареют раньше, чем придут. Задержка в 140 мс короче
 *      паузы между нажатиями при обычной скорости печати, поэтому уходит
 *      обычно один запрос — на то, что человек действительно набрал.
 *
 *   2. Подсказка НЕ ждёт сервер, если ответ уже есть. Набрав «пет» и
 *      дописав «р», человек не должен видеть пустой список, пока летит
 *      новый запрос: «петр» — это подмножество того, что уже пришло на
 *      «пет», и отобрать его можно прямо здесь, мгновенно. Запрос при
 *      этом всё равно уходит — вдруг у сервера есть больше, — но список
 *      под курсором не мигает.
 *
 * Отбор в браузере идёт ТЕМ ЖЕ правилом, что и отбор в базе
 * (`tokensMatch` из общего пакета). Разойдись они — и список дёргался бы
 * при каждой букве, то показывая человека, то теряя его.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПАМЯТЬ ЖИВЁТ ВНУТРИ ПОЛЯ, А НЕ В МОДУЛЕ
 * ------------------------------------------------------------------
 * Здесь лежат адреса переписки — то, что человек не обязан оставлять в
 * памяти вкладки дольше, чем нужно. Память, привязанная к полю, исчезает
 * вместе с окном написания письма; общая на весь модуль пережила бы и
 * закрытие окна, и выход из ящика.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { contactTokens, tokensMatch } from '@mail-true/shared';
import {
  EMPTY_SUGGESTIONS,
  fetchContactSuggestions,
  type ContactSuggestResponse,
  type ContactSuggestion,
} from './contactsApi';

/** Задержка перед запросом. Короче паузы между нажатиями при обычной печати. */
export const SUGGEST_DEBOUNCE_MS = 140;

/**
 * Сколько подсказок отдаёт сервер. Знать это число нужно ради одного:
 * список ровно такой длины МОГ быть обрезан, и отбирать из него в
 * браузере нельзя — за обрезом могло остаться подходящее.
 */
export const SUGGEST_LIMIT = 8;

export interface ContactSuggestState extends ContactSuggestResponse {
  /** Ответ на нынешний запрос ещё не пришёл. */
  loading: boolean;
}

/** Подходит ли подсказка под уточнённый запрос — тем же правилом, что и база. */
export function suggestionMatches(item: ContactSuggestion, query: string): boolean {
  return tokensMatch(contactTokens(item.name, item.address), query);
}

/**
 * Что можно ответить, не спрашивая сервер.
 *
 * Берётся самый длинный из уже отвеченных запросов, началом которого
 * является нынешний, и его список отбирается заново. Обрезанные списки
 * (длиной ровно в предел) не годятся: за обрезом могло остаться то, что
 * подходит под уточнённый запрос, и человек не увидел бы нужного адреса.
 */
export function answerFromMemory(
  memory: ReadonlyMap<string, ContactSuggestResponse>,
  query: string,
): ContactSuggestResponse | null {
  const exact = memory.get(query);
  if (exact) return exact;
  let best: { key: string; value: ContactSuggestResponse } | null = null;
  for (const [key, value] of memory) {
    if (!query.startsWith(key)) continue;
    if (value.items.length >= SUGGEST_LIMIT) continue;
    if (!best || key.length > best.key.length) best = { key, value };
  }
  if (!best) return null;
  return {
    items: best.value.items.filter((item) => suggestionMatches(item, query)),
    complete: best.value.complete,
  };
}

export interface UseContactSuggestOptions {
  /** Что человек набрал в нынешнем адресе (без уже введённых). */
  query: string;
  /** Адреса, уже стоящие в поле: предлагать их повторно нельзя. */
  exclude: readonly string[];
  /** Поле в работе (есть фокус). Без этого запросы не нужны вовсе. */
  enabled: boolean;
}

export function useContactSuggest(options: UseContactSuggestOptions): ContactSuggestState {
  const { query, enabled } = options;
  // Список исключений меняется редко (только когда очередной адрес дописан
  // до конца), но сравнивать массивы по ссылке нельзя: разбор строки поля
  // создаёт новый массив на каждое нажатие.
  const excludeKey = useMemo(() => [...options.exclude].sort().join(','), [options.exclude]);

  /*
   * Память своя на каждый набор исключений, а не одна общая: сервер
   * применяет предел выдачи ПОСЛЕ исключения уже введённых адресов, и
   * список, полученный при других исключениях, — это другой список.
   * Отбирать из него значило бы соврать про полноту выдачи.
   */
  const memory = useRef(new Map<string, Map<string, ContactSuggestResponse>>());
  const [state, setState] = useState<ContactSuggestState>({ ...EMPTY_SUGGESTIONS, loading: false });

  useEffect(() => {
    if (!enabled || query === '') {
      setState({ ...EMPTY_SUGGESTIONS, loading: false });
      return;
    }

    let scoped = memory.current.get(excludeKey);
    if (!scoped) {
      scoped = new Map<string, ContactSuggestResponse>();
      memory.current.set(excludeKey, scoped);
    }
    const cache = scoped;

    const exact = cache.get(query);
    if (exact) {
      // Ровно этот запрос уже отвечен — сервер не нужен вовсе.
      setState({ ...exact, loading: false });
      return;
    }

    // То, что можно показать немедленно. Запрос всё равно уйдёт — вдруг
    // у сервера есть больше, — но список под курсором не мигает.
    const known = answerFromMemory(cache, query);
    if (known) setState({ ...known, loading: true });
    else setState((prev) => ({ ...prev, loading: true }));

    const controller = new AbortController();
    const exclude = excludeKey === '' ? [] : excludeKey.split(',');
    const timer = setTimeout(() => {
      void fetchContactSuggestions(query, exclude, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        cache.set(query, response);
        // Память не должна расти бесконечно за одно написание письма.
        if (cache.size > 100) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        setState({ ...response, loading: false });
      });
    }, SUGGEST_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // options.exclude намеренно не в зависимостях: его заменяет
    // excludeKey — иначе новый массив с тем же содержимым перезапускал бы
    // запрос на каждое нажатие клавиши.
  }, [query, excludeKey, enabled]);

  return state;
}
