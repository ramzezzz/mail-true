/**
 * Настройки помощника. Ни адрес сервиса, ни название модели в коде
 * не зашиты: и то и другое приходит из настроек администратора.
 *
 * По умолчанию помощник ВЫКЛЮЧЕН — так требует главный принцип: содержимое
 * переписки не уходит наружу, пока это не разрешено явно.
 */

import { z } from 'zod';
import { isInsidePerimeter } from './perimeter.js';
import { DEFAULT_MAX_BODY_CHARS } from './sanitize.js';

const providerFieldsSchema = z.object({
  /** Разрешён ли помощник. По умолчанию нет. */
  enabled: z.boolean().default(false),
  /**
   * Адрес совместимого API без хвостового пути:
   * внешний сервис либо локальная модель, поднятая рядом.
   */
  baseUrl: z.string().url('Адрес сервиса должен быть корректным URL'),
  /** Путь метода дополнения чата относительно baseUrl. */
  chatPath: z.string().default('/chat/completions'),
  /**
   * Ключ доступа. Для локальной модели может отсутствовать.
   * Только печатные символы ASCII: значение уходит в заголовок HTTP,
   * а кириллица в заголовке обрывает запрос на уровне fetch.
   */
  apiKey: z
    .string()
    .min(1)
    .regex(/^[\x20-\x7e]+$/, 'Ключ доступа может содержать только печатные символы ASCII')
    .optional(),
  /** Название модели — строго из настроек. */
  model: z.string().min(1, 'Не указано название модели'),
  /** Человекочитаемое название сервиса для показа пользователю. */
  providerLabel: z.string().default('Сервис ИИ'),
  /** Таймаут одного запроса. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  /** Сколько раз повторять при временных ошибках. */
  maxRetries: z.number().int().min(0).max(10).default(2),
  /** Базовая задержка перед повтором; растёт экспоненциально. */
  retryBaseDelayMs: z.number().int().min(0).max(60_000).default(400),
  /** Температура по умолчанию. Для разбора и извлечения нужна низкая. */
  temperature: z.number().min(0).max(2).default(0.2),
  /** Предел длины ответа. */
  maxOutputTokens: z.number().int().positive().max(32_000).default(1024),
  /** Дополнительные заголовки запроса. */
  headers: z.record(z.string()).default({}),
  /** Предельная длина тела письма, отправляемого наружу. */
  maxBodyChars: z.number().int().positive().max(200_000).default(DEFAULT_MAX_BODY_CHARS),
});

/**
 * Настройки поставщика.
 *
 * Признак `local` («модель поднята внутри периметра, письма не покидают
 * сервер») в ЧИСЛО ВХОДНЫХ ПОЛЕЙ НЕ ВХОДИТ намеренно: это единственное
 * поле настроек, на котором держится обещание, показанное пользователю
 * почты на экране согласия. Пока его можно было прислать булевым флагом,
 * запрос мимо формы админки записывал «внутри периметра» при адресе
 * api.openai.com — и обещание становилось неправдой сразу для всего
 * домена. Теперь признак выводится из адреса здесь (см. perimeter.ts),
 * и другого источника у него нет.
 */
export const providerConfigSchema = providerFieldsSchema.transform((config) => ({
  ...config,
  local: isInsidePerimeter(config.baseUrl),
}));

export type ProviderConfigInput = z.input<typeof providerConfigSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;

export const budgetLimitsSchema = z.object({
  /** Длительность окна учёта в миллисекундах. По умолчанию сутки. */
  periodMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  /** Предел суммарных токенов за окно. null — без предела. */
  maxTokensPerPeriod: z.number().int().positive().nullable().default(null),
  /** Предел числа вызовов за окно. null — без предела. */
  maxRequestsPerPeriod: z.number().int().positive().nullable().default(null),
  /** Предел токенов одного запроса. null — без предела. */
  maxTokensPerRequest: z.number().int().positive().nullable().default(null),
});

export type BudgetLimitsInput = z.input<typeof budgetLimitsSchema>;
export type BudgetLimits = z.output<typeof budgetLimitsSchema>;

export const assistantOptionsSchema = z.object({
  /** Время жизни записи кэша в секундах. */
  cacheTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
  /** Язык ответов помощника по умолчанию. */
  defaultLanguage: z.string().min(2).default('ru'),
});

export type AssistantOptionsInput = z.input<typeof assistantOptionsSchema>;
export type AssistantOptions = z.output<typeof assistantOptionsSchema>;

export interface ConfigParseOk {
  ok: true;
  config: ProviderConfig;
}
export interface ConfigParseFail {
  ok: false;
  message: string;
  issues: string[];
}

/**
 * Проверяет настройки поставщика. Не бросает исключений:
 * неверные настройки — это не авария, а повод не показывать кнопки ИИ.
 */
export function parseProviderConfig(input: unknown): ConfigParseOk | ConfigParseFail {
  const result = providerConfigSchema.safeParse(input);
  if (result.success) return { ok: true, config: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`);
  return {
    ok: false,
    message: 'Настройки помощника заполнены неверно',
    issues,
  };
}

/** Полный адрес метода дополнения чата. */
export function chatEndpoint(config: ProviderConfig): string {
  const base = config.baseUrl.replace(/\/+$/, '');
  const path = config.chatPath.startsWith('/') ? config.chatPath : `/${config.chatPath}`;
  return `${base}${path}`;
}
