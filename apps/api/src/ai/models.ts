/**
 * Список моделей у поставщика ИИ.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ
 * ------------------------------------------------------------------
 * Название модели вводилось руками в текстовое поле. Опечатка в нём
 * («qwen2.5:7b» против «qwen2.5-7b») выясняется не при сохранении, а
 * потом — отказом сервиса на первом же письме, и выглядит это как
 * «помощник не работает», а не как «в названии лишний дефис». Список у
 * поставщика есть всегда: и OpenAI-совместимые сервисы, и Ollama отдают
 * его по одному и тому же адресу.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РАЗБОР ОТДЕЛЬНОЙ ФУНКЦИЕЙ
 * ------------------------------------------------------------------
 * Ответы разные по форме, и это не редкость, а норма: OpenAI отдаёт
 * `{data: [{id}]}`, нативный Ollama — `{models: [{name}]}`, часть
 * самодельных обёрток — просто массив строк. Разбор без сети проверяется
 * тестом на каждой из форм, а сетевая часть остаётся тонкой.
 */

/** Адрес списка моделей рядом с адресом сервиса. */
export function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

/**
 * Названия моделей из ответа поставщика.
 *
 * Пустой список — это ответ «поставщик ничего не назвал», а не ошибка:
 * бывает у обёрток с одной прибитой моделью. Человеку тогда честно
 * говорят, что выбирать не из чего, и оставляют ручной ввод.
 */
export function parseModelList(payload: unknown): string[] {
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload.models)
          ? payload.models
          : []
      : [];

  const names: string[] = [];
  for (const row of rows) {
    // Строка — так отвечают самодельные обёртки.
    if (typeof row === 'string') {
      if (row.trim() !== '') names.push(row.trim());
      continue;
    }
    if (!isRecord(row)) continue;
    // `id` — OpenAI-совместимые, `name` — нативный Ollama и часть обёрток.
    const value =
      typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '';
    if (value.trim() !== '') names.push(value.trim());
  }

  /*
   * Дедупликация нужна не для красоты: обёртки над несколькими
   * поставщиками отдают одну и ту же модель по разу на каждого, и в
   * выпадающем списке она троилась бы.
   *
   * Порядок — по алфавиту без учёта регистра. Порядок поставщика ничего
   * не значит (у одних он по дате, у других случайный), а список из
   * полусотни моделей глазами читается только отсортированным.
   */
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Сетевой отказ — словами.
 *
 * `fetch` в Node на любую сетевую беду отдаёт одно и то же «fetch
 * failed», а настоящая причина лежит в `cause`. Разница здесь
 * принципиальная: «имя не разрешается» — опечатка в адресе, «соединение
 * отвергнуто» — сервис не поднят, «сертификат» — самоподписанный TLS. Всё
 * это чинится по-разному, и человеку у формы нужно знать, что именно.
 *
 * Найдено живой проверкой: при неверном имени хоста панель показывала
 * ровно «Не удалось обратиться к сервису: fetch failed».
 */
export function describeNetworkFailure(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'сервис не ответил вовремя';
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'имя из адреса не разрешается — проверьте адрес сервиса';
    case 'ECONNREFUSED':
      return 'адрес есть, но по нему никто не слушает — сервис не запущен или порт другой';
    case 'ECONNRESET':
      return 'соединение оборвано на середине';
    case 'ETIMEDOUT':
      return 'соединение не установилось — вероятно, мешает сеть или межсетевой экран';
    case 'CERT_HAS_EXPIRED':
      return 'у сервиса просроченный сертификат';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'у сервиса самоподписанный сертификат, которому здесь не доверяют';
    default:
      break;
  }
  const message = cause instanceof Error ? cause.message : err instanceof Error ? err.message : '';
  return message === '' ? 'сеть недоступна' : message;
}
