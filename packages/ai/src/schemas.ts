/**
 * Схемы результатов возможностей помощника.
 *
 * Схема — это контракт с моделью и одновременно защита от неё:
 * что не прошло проверку, наружу не выйдет и интерфейс не сломает.
 * Все поля с разумными значениями по умолчанию, чтобы неполный ответ
 * модели не превращался в отказ там, где данных достаточно.
 */

import { z } from 'zod';

// --- Резюме ----------------------------------------------------------------

export const summarySchema = z.object({
  /** Три-четыре строки: суть письма или цепочки. */
  summary: z.string().min(1),
  /** Ключевые пункты для плашки. */
  bullets: z.array(z.string().min(1)).max(10).default([]),
  /** Требуется ли действие от получателя. */
  actionRequired: z.boolean().default(false),
});
export type Summary = z.output<typeof summarySchema>;

// --- Категория -------------------------------------------------------------

/**
 * Категории соответствуют смысловым группам привычный почтовый интерфейс («Финансы», «Заказы»,
 * «Билеты», «Учётные записи»), но без жёстко зашитых правил.
 */
export const mailCategories = [
  'invoice',
  'delivery',
  'meeting',
  'contract',
  'personal',
  'account',
  'travel',
  'newsletter',
  'support',
  'other',
] as const;

export type MailCategory = (typeof mailCategories)[number];

/** Русские названия категорий для интерфейса. */
export const categoryTitles: Record<MailCategory, string> = {
  invoice: 'Счета',
  delivery: 'Доставки',
  meeting: 'Встречи',
  contract: 'Договоры',
  personal: 'Личное',
  account: 'Учётные записи',
  travel: 'Билеты и поездки',
  newsletter: 'Рассылки',
  support: 'Поддержка',
  other: 'Прочее',
};

export const classificationSchema = z.object({
  category: z.enum(mailCategories),
  /** Уверенность от 0 до 1. */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Короткое объяснение — почему такая категория. */
  reason: z.string().default(''),
  /** Дополнительные метки, которые можно повесить на письмо. */
  labels: z.array(z.string().min(1)).max(5).default([]),
});
export type Classification = z.output<typeof classificationSchema>;

// --- Ответы ----------------------------------------------------------------

export const replyTones = ['short', 'detailed', 'formal'] as const;
export type ReplyTone = (typeof replyTones)[number];

export const toneTitles: Record<ReplyTone, string> = {
  short: 'Коротко',
  detailed: 'Подробно',
  formal: 'Официально',
};

export const replyVariantSchema = z.object({
  tone: z.enum(replyTones),
  body: z.string().min(1),
});

export const replyVariantsSchema = z.object({
  variants: z.array(replyVariantSchema).min(1).max(5),
});
export type ReplyVariant = z.output<typeof replyVariantSchema>;
export type ReplyVariants = z.output<typeof replyVariantsSchema>;

export const continuationSchema = z.object({
  /** Продолжение начатой фразы — БЕЗ повтора уже написанного. */
  continuation: z.string(),
});
export type Continuation = z.output<typeof continuationSchema>;

// --- Правка текста ---------------------------------------------------------

export const rewriteModes = ['shorten', 'soften', 'fix'] as const;
export type RewriteMode = (typeof rewriteModes)[number];

export const rewriteModeTitles: Record<RewriteMode, string> = {
  shorten: 'Сократить',
  soften: 'Смягчить',
  fix: 'Исправить ошибки',
};

export const rewriteSchema = z.object({
  text: z.string().min(1),
  /** Что именно изменено — короткими пунктами. */
  changes: z.array(z.string().min(1)).max(10).default([]),
});
export type RewriteResult = z.output<typeof rewriteSchema>;

// --- Извлечение полезного --------------------------------------------------

export const extractedEventSchema = z.object({
  title: z.string().min(1),
  /** Начало в ISO 8601; null — в письме нет однозначной даты. */
  startsAt: z.string().nullable().default(null),
  endsAt: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  /** Фрагмент письма, откуда это взято, — чтобы пользователь мог проверить. */
  source: z.string().default(''),
});

export const extractedAmountSchema = z.object({
  /** Сумма строкой: в письмах бывают «1 234,56» и «1,234.56». */
  amount: z.string().min(1),
  /** Код валюты: RUB, USD, EUR… */
  currency: z.string().default(''),
  /** За что: «итого», «НДС», «предоплата». */
  purpose: z.string().default(''),
  source: z.string().default(''),
});

export const requisiteKinds = [
  'inn',
  'kpp',
  'bic',
  'account',
  'iban',
  'card',
  'invoice-number',
  'contract-number',
  'other',
] as const;

export const extractedRequisiteSchema = z.object({
  kind: z.enum(requisiteKinds).default('other'),
  value: z.string().min(1),
  label: z.string().default(''),
});

export const extractedTaskSchema = z.object({
  title: z.string().min(1),
  /** Срок в ISO 8601; null — срок не указан. */
  dueAt: z.string().nullable().default(null),
  assignee: z.string().nullable().default(null),
  source: z.string().default(''),
});

export const extractedTrackingSchema = z.object({
  number: z.string().min(1),
  carrier: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});

export const extractionSchema = z.object({
  events: z.array(extractedEventSchema).max(20).default([]),
  amounts: z.array(extractedAmountSchema).max(20).default([]),
  requisites: z.array(extractedRequisiteSchema).max(20).default([]),
  tasks: z.array(extractedTaskSchema).max(20).default([]),
  tracking: z.array(extractedTrackingSchema).max(20).default([]),
});
export type Extraction = z.output<typeof extractionSchema>;
export type ExtractedEvent = z.output<typeof extractedEventSchema>;
export type ExtractedAmount = z.output<typeof extractedAmountSchema>;
export type ExtractedRequisite = z.output<typeof extractedRequisiteSchema>;
export type ExtractedTask = z.output<typeof extractedTaskSchema>;
export type ExtractedTracking = z.output<typeof extractedTrackingSchema>;

// --- Перевод ---------------------------------------------------------------

export const translationSchema = z.object({
  /** Перевод с сохранением разметки исходного текста. */
  text: z.string().min(1),
  /** Определённый язык оригинала, код по ISO 639-1. */
  detectedLanguage: z.string().default(''),
});
export type Translation = z.output<typeof translationSchema>;

// --- Поиск обычными словами ------------------------------------------------

export const searchQuerySchema = z.object({
  /** Адреса или их части, по которым фильтруем отправителя. */
  from: z.array(z.string().min(1)).max(10).default([]),
  to: z.array(z.string().min(1)).max(10).default([]),
  /** Слова, которые должны встретиться в теме. */
  subject: z.array(z.string().min(1)).max(10).default([]),
  /** Слова, которые должны встретиться в теме или теле. */
  text: z.array(z.string().min(1)).max(10).default([]),
  /** Нижняя граница даты, ISO 8601 (только дата). */
  dateFrom: z.string().nullable().default(null),
  /** Верхняя граница даты, ISO 8601 (только дата), включительно. */
  dateTo: z.string().nullable().default(null),
  hasAttachments: z.boolean().nullable().default(null),
  unreadOnly: z.boolean().nullable().default(null),
  /** Папка, если она названа в запросе явно. */
  folder: z.string().nullable().default(null),
  /**
   * Во что превратился запрос — простыми словами.
   * Показывается пользователю обязательно: он должен видеть, что ищется.
   */
  explanation: z.string().min(1),
});
export type ParsedSearchQuery = z.output<typeof searchQuerySchema>;
