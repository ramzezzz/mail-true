/**
 * Формулировки запросов к модели и их версии.
 *
 * Версия входит в ключ кэша: поменяли текст запроса — старые записи
 * автоматически перестают использоваться, пересчёт произойдёт сам.
 * Версию нужно менять ВСЯКИЙ РАЗ при правке соответствующей формулировки.
 */

import type { AiFeature } from './types.js';
import { categoryTitles, mailCategories, toneTitles, type ReplyTone, type RewriteMode } from './schemas.js';

export const PROMPT_VERSIONS: Record<AiFeature, string> = {
  'summarize.message': 'v1',
  'summarize.thread': 'v1',
  classify: 'v1',
  'reply.variants': 'v1',
  'reply.continue': 'v1',
  rewrite: 'v1',
  extract: 'v1',
  translate: 'v1',
  'search.query': 'v1',
};

const JSON_RULE =
  'Ответь ТОЛЬКО объектом JSON без пояснений, без ограждений кода и без текста до или после него.';

const PRIVACY_RULE =
  'Не придумывай фактов, которых нет в тексте. Если данных не хватает, оставь поле пустым или null.';

/** Общее вступление для всех запросов. */
function base(language: string): string {
  return [
    'Ты — помощник почтового клиента.',
    `Отвечай на языке с кодом «${language}», если в задании не сказано иное.`,
    PRIVACY_RULE,
  ].join(' ');
}

export function summarizeMessagePrompt(language: string): string {
  return [
    base(language),
    'Задача: кратко изложить письмо в три-четыре строки.',
    'Поля ответа: summary (строка, суть письма), bullets (массив строк, ключевые пункты, не более 5),',
    'actionRequired (булево: требуется ли действие от получателя).',
    JSON_RULE,
  ].join(' ');
}

export function summarizeThreadPrompt(language: string): string {
  return [
    base(language),
    'Задача: кратко изложить всю цепочку переписки: о чём договорились, что осталось нерешённым.',
    'Письма даны по порядку, от раннего к позднему.',
    'Поля ответа: summary (строка), bullets (массив строк, не более 6), actionRequired (булево).',
    JSON_RULE,
  ].join(' ');
}

export function classifyPrompt(language: string): string {
  const list = mailCategories.map((c) => `${c} — ${categoryTitles[c]}`).join('; ');
  return [
    base(language),
    'Задача: отнести письмо к одной категории по смыслу.',
    `Допустимые значения category: ${list}.`,
    'Поля ответа: category (одно из перечисленных значений), confidence (число от 0 до 1),',
    'reason (короткое объяснение), labels (массив дополнительных меток, не более 3).',
    JSON_RULE,
  ].join(' ');
}

export function replyVariantsPrompt(language: string, tones: readonly ReplyTone[]): string {
  const wanted = tones.map((t) => `${t} (${toneTitles[t]})`).join(', ');
  return [
    base(language),
    'Задача: предложить варианты ответа на письмо.',
    `Нужны варианты с тонами: ${wanted}.`,
    'short — две-три фразы; detailed — развёрнутый ответ по пунктам; formal — деловой стиль, обращение на «вы».',
    'Не подписывайся: подпись подставит почтовый клиент.',
    'Поля ответа: variants (массив объектов с полями tone и body).',
    JSON_RULE,
  ].join(' ');
}

export function continuePrompt(language: string): string {
  return [
    base(language),
    'Задача: продолжить начатую пользователем фразу в письме.',
    'Верни ТОЛЬКО продолжение, не повторяя уже написанное. Продолжение должно',
    'грамматически стыковаться с концом введённого текста.',
    'Поля ответа: continuation (строка).',
    JSON_RULE,
  ].join(' ');
}

export function rewritePrompt(language: string, mode: RewriteMode): string {
  const task: Record<RewriteMode, string> = {
    shorten: 'сократить текст, сохранив все существенные сведения и просьбы',
    soften: 'смягчить тон, убрать резкость и упрёки, сохранив смысл и требования',
    fix: 'исправить орфографию, пунктуацию и согласование, ничего не переписывая по смыслу',
  };
  return [
    base(language),
    `Задача: ${task[mode]}.`,
    'Сохрани разбиение на абзацы и списки. Язык результата — язык исходного текста.',
    'Поля ответа: text (исправленный текст), changes (массив строк: что изменено, не более 5).',
    JSON_RULE,
  ].join(' ');
}

export function extractPrompt(language: string, today: string): string {
  return [
    base(language),
    'Задача: извлечь из письма полезные данные.',
    `Сегодня ${today} — относительные даты («завтра», «в пятницу») приводи к абсолютным.`,
    'Поля ответа:',
    'events (массив: title, startsAt, endsAt, location, source; даты в ISO 8601 или null),',
    'amounts (массив: amount, currency, purpose, source),',
    'requisites (массив: kind из inn|kpp|bic|account|iban|card|invoice-number|contract-number|other, value, label),',
    'tasks (массив: title, dueAt, assignee, source),',
    'tracking (массив: number, carrier, url).',
    'Пустые разделы возвращай пустыми массивами.',
    JSON_RULE,
  ].join(' ');
}

export function translatePrompt(targetLanguage: string): string {
  return [
    'Ты — переводчик писем.',
    `Переведи текст на язык с кодом «${targetLanguage}».`,
    'СОХРАНИ разметку без изменений: абзацы, списки, теги HTML, ссылки, адреса и числа.',
    'Переводи только видимый текст. Имена собственные и адреса электронной почты не переводи.',
    PRIVACY_RULE,
    'Поля ответа: text (перевод), detectedLanguage (код языка оригинала по ISO 639-1).',
    JSON_RULE,
  ].join(' ');
}

export function searchQueryPrompt(language: string, today: string): string {
  return [
    base(language),
    'Задача: превратить запрос обычными словами в параметры поиска по почте.',
    `Сегодня ${today}. Относительные промежутки («в марте», «на прошлой неделе») приводи к датам.`,
    'Поля ответа: from (массив строк), to (массив строк), subject (массив слов),',
    'text (массив слов для поиска в теме и теле), dateFrom и dateTo (даты вида ГГГГ-ММ-ДД или null),',
    'hasAttachments (булево или null), unreadOnly (булево или null), folder (строка или null),',
    'explanation (обязательно: одной фразой на русском, что именно будет найдено).',
    'Не выдумывай адреса: если отправитель назван словом («бухгалтерия»), положи это слово в from.',
    JSON_RULE,
  ].join(' ');
}
