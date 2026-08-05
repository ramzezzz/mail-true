/**
 * Устойчивый разбор ответа модели.
 *
 * Модель — не программа: она добавит пояснение до JSON, обернёт ответ
 * в тройные кавычки, поставит запятую перед закрывающей скобкой или
 * оборвёт вывод на середине. Ни один из этих случаев не должен
 * приводить к исключению.
 */

import type { z } from 'zod';
import { aiFail, type AiOutcome } from './types.js';
import { aiOk, ZERO_USAGE } from './types.js';

/** Вырезает JSON из произвольного текста ответа. */
export function extractJsonText(raw: string): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;

  // Ответ в ограждении ```json ... ```
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const startObject = text.indexOf('{');
  const startArray = text.indexOf('[');
  let start: number;
  if (startObject === -1 && startArray === -1) return null;
  if (startObject === -1) start = startArray;
  else if (startArray === -1) start = startObject;
  else start = Math.min(startObject, startArray);

  const balanced = sliceBalanced(text, start);
  return balanced ?? text.slice(start);
}

/** Находит конец сбалансированной структуры, учитывая строки и экранирование. */
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Снимает частые огрехи: лишние запятые, «умные» кавычки в ключах. */
function repairJson(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/\ufeff/g, '');
}

export interface LooseParseOk {
  ok: true;
  value: unknown;
  /** Потребовалась ли починка текста. Полезно для журнала. */
  repaired: boolean;
}
export interface LooseParseFail {
  ok: false;
  reason: string;
}

/** Разбирает JSON из ответа модели, не бросая исключений. */
export function parseJsonLoose(raw: string): LooseParseOk | LooseParseFail {
  const text = extractJsonText(raw);
  if (text === null) return { ok: false, reason: 'в ответе нет JSON' };

  try {
    return { ok: true, value: JSON.parse(text), repaired: false };
  } catch {
    // продолжаем
  }

  try {
    return { ok: true, value: JSON.parse(repairJson(text)), repaired: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'не удалось разобрать JSON',
    };
  }
}

/**
 * Разбирает ответ модели и проверяет его схемой.
 * Любая неудача — понятный отказ вида `bad-response`, а не исключение.
 */
export function parseWithSchema<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
): AiOutcome<z.output<S>> {
  const parsed = parseJsonLoose(raw);
  if (!parsed.ok) {
    return aiFail('bad-response', 'Ответ сервиса ИИ не удалось разобрать', {
      retryable: true,
      details: `${parsed.reason}; ответ: ${raw.slice(0, 300)}`,
    });
  }

  const checked = schema.safeParse(parsed.value);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
      .join('; ');
    return aiFail('bad-response', 'Ответ сервиса ИИ не соответствует ожидаемому виду', {
      retryable: true,
      details: issues,
    });
  }

  return aiOk(checked.data, { usage: ZERO_USAGE });
}
