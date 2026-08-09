/**
 * Шаблоны писем: обращения к API и подстановки.
 *
 * Отдельным файлом, а не внутри общего клиента (api/client.ts), по той же
 * причине, по какой отдельно живут метки и отложенные письма: возможность
 * не должна появляться в интерфейсе, пока сервер не сказал, что она у него
 * есть. Кнопка «Шаблоны» в окне написания и раздел в настройках висят на
 * одном и том же поле `available`.
 */

import { useMocks } from '../api/mockFlag';
import { apiFetch } from '../api/http';
import type { ComposeAttachment } from '../app/store';
import { parseAddresses } from '../lib/addresses';

/** Вложение шаблона. Байты сюда не приезжают — только имя и размер. */
export interface TemplateAttachment {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailTemplate {
  id: number;
  name: string;
  subject: string;
  bodyHtml: string;
  position: number;
  attachments: TemplateAttachment[];
}

/**
 * Состояние возможности целиком.
 *
 * `available: false` значит, что хранилища нет (не настроена база или не
 * применена миграция 0026). Тогда интерфейс УБИРАЕТ и кнопку в окне
 * написания, и раздел настроек, а не показывает их и потом отказывает —
 * то же правило, что у меток и отложенных писем.
 */
export interface TemplatesState {
  available: boolean;
  reason: string | null;
  items: MailTemplate[];
}

/** Что уходит на сервер при заведении и правке. */
export interface TemplateDraft {
  name: string;
  subject: string;
  bodyHtml: string;
  /**
   * Идентификаторы ВРЕМЕННЫХ загрузок — тех же, что уходят в письмо.
   * Байты по ним сервер копирует себе (см. apps/api/src/templates/routes.ts).
   *
   * Отсутствие поля и пустой список — разные просьбы: первая значит «не
   * трогать вложения», вторая — «убрать все». Правка одного лишь названия
   * не должна стирать приложенный прайс.
   */
  attachmentIds?: string[] | undefined;
}

/** Возможности нет, пока сервер не сказал обратного. */
export const TEMPLATES_UNAVAILABLE: TemplatesState = {
  available: false,
  reason: null,
  items: [],
};

const TEMPLATES_ON_MOCKS: TemplatesState = {
  available: false,
  reason: 'На заглушечных данных шаблоны писем не хранятся',
  items: [],
};

export const templatesApi = {
  getTemplates: (): Promise<TemplatesState> => {
    /*
     * На заглушках интерфейса запроса нет вовсе — то же правило, что у
     * меток и отложенных писем. Своего хранилища у заглушек нет, а сходить
     * на настоящий адрес нельзя: без сессии он ответит 401, и общий
     * обработчик уведёт человека на экран входа из режима, где никакого
     * входа не предполагается.
     */
    if (useMocks) return Promise.resolve(TEMPLATES_ON_MOCKS);
    return apiFetch('/api/templates');
  },

  createTemplate: (draft: TemplateDraft): Promise<MailTemplate> =>
    apiFetch('/api/templates', { method: 'POST', body: JSON.stringify(draft) }),

  updateTemplate: (id: number, patch: Partial<TemplateDraft>): Promise<MailTemplate> =>
    apiFetch(`/api/templates/${String(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),

  deleteTemplate: (id: number): Promise<{ ok: boolean; id: number; name: string }> =>
    apiFetch(`/api/templates/${String(id)}`, { method: 'DELETE' }),

  reorderTemplates: (ids: readonly number[]): Promise<{ items: MailTemplate[] }> =>
    apiFetch('/api/templates/order', { method: 'POST', body: JSON.stringify({ ids: [...ids] }) }),

  /**
   * Вложения шаблона — во временное хранилище загрузок.
   *
   * Зовётся ТОЛЬКО при вставке шаблона, у которого вложения есть: запрос
   * создаёт файлы на сервере, и делать его ради шаблона из одного текста
   * значило бы мусорить впустую.
   */
  materializeAttachments: (id: number): Promise<{ attachments: ComposeAttachment[] }> =>
    apiFetch(`/api/templates/${String(id)}/attachments`, { method: 'POST' }),
};

/**
 * Переставляет шаблон на одну позицию вверх или вниз.
 *
 * Стрелками, а не перетаскиванием, — так же, как порядок правил фильтрации
 * (см. lib/filterRules.ts, moveRule). Причина та же: перетаскивание
 * недоступно с клавиатуры и промахивается на сенсорном экране, а порядок
 * здесь меняют раз в месяц.
 */
export function moveTemplate(
  items: readonly MailTemplate[],
  id: number,
  direction: 'up' | 'down',
): MailTemplate[] {
  const index = items.findIndex((t) => t.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const moved = next[index];
  const replaced = next[target];
  if (!moved || !replaced) return next;
  next[index] = replaced;
  next[target] = moved;
  return next;
}

/* ------------------------------------------------------------------ */
/* Подстановки                                                         */
/* ------------------------------------------------------------------ */

/**
 * Подстановка — это место в шаблоне, куда при вставке встаёт имя адресата.
 *
 * Без неё шаблон остаётся заготовкой, которую всё равно надо править
 * руками, — а правят там ровно одно: обращение. С ней «Здравствуйте,
 * {{имя}}!» превращается в готовое письмо.
 *
 * Записываются двойными фигурными скобками, как у Superhuman и в большинстве
 * систем рассылок: одиночные скобки слишком часто встречаются в обычном
 * тексте (и в коде, который пересылают в письмах).
 */
export interface TemplatePlaceholder {
  /** Как пишется в шаблоне, без скобок. */
  key: string;
  /** Что это значит — показывается в подсказке под полем тела. */
  title: string;
}

export const TEMPLATE_PLACEHOLDERS: TemplatePlaceholder[] = [
  { key: 'имя', title: 'имя адресата (первое слово)' },
  { key: 'адресат', title: 'адресат целиком — имя или адрес' },
  { key: 'адрес', title: 'почтовый адрес адресата' },
  { key: 'моё имя', title: 'ваше имя из настроек ящика' },
];

/** Что знаем о получателе и о себе на момент вставки шаблона. */
export interface SubstitutionContext {
  /** Имя первого получателя, если оно известно. */
  recipientName: string | null;
  /** Адрес первого получателя, если он указан. */
  recipientAddress: string | null;
  /** Имя владельца ящика из /api/account. */
  ownName: string | null;
}

/** Ищет `{{что-нибудь}}` — то же выражение читают вставка и проверка. */
const PLACEHOLDER_RE = /\{\{\s*([^{}]{1,40}?)\s*\}\}/gu;

/**
 * Первое слово имени.
 *
 * «Пётр Волков» -> «Пётр». Обращение по одному имени — это то, ради чего
 * подстановка и нужна: «Здравствуйте, Пётр Волков!» звучит как письмо из
 * банка.
 *
 * Запись «Иванов, Иван» разбирается наоборот — имя стоит ПОСЛЕ запятой.
 * Так подписывают отправителя корпоративные почтовые системы, и приходит
 * такое имя к нам само, из заголовков писем в подсказку поля «Кому».
 * Первое слово по общему правилу дало бы «Здравствуйте, Иванов,!» —
 * с чужой фамилией и с запятой посреди приветствия.
 */
export function firstName(full: string): string {
  const trimmed = full.trim();
  const surnameFirst = /^([^,]+),\s*(.+)$/u.exec(trimmed);
  const source = surnameFirst?.[2] ?? trimmed;
  return source.trim().split(/\s+/u)[0] ?? '';
}

/**
 * Что подставить вместо подстановки. `null` — подставить нечего.
 *
 * Именно `null`, а не пустая строка: неизвестное имя нельзя заменять
 * пустым местом («Здравствуйте, !»), и нельзя выдумывать из адреса
 * (`info@…` дало бы «Здравствуйте, info!»). Неизвестное остаётся в тексте
 * как есть, а человеку об этом говорят — см. `unresolvedPlaceholders`.
 */
export function substitutionFor(key: string, ctx: SubstitutionContext): string | null {
  const normalized = key.trim().toLowerCase();
  switch (normalized) {
    case 'имя':
      return ctx.recipientName ? firstName(ctx.recipientName) : null;
    case 'адресат':
      return ctx.recipientName ?? ctx.recipientAddress;
    case 'адрес':
      return ctx.recipientAddress;
    case 'моё имя':
    case 'мое имя':
      return ctx.ownName;
    default:
      /*
       * Незнакомая подстановка не трогается вовсе. Человек мог написать
       * `{{номер договора}}` намеренно — как напоминание себе, что здесь
       * надо вписать номер. Стереть это значило бы отправить письмо с
       * дырой на месте, где человек ждал напоминания.
       */
      return null;
  }
}

/** Подставляет всё, что известно; неизвестное оставляет как было. */
export function applySubstitutions(text: string, ctx: SubstitutionContext): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) => substitutionFor(key, ctx) ?? whole);
}

/**
 * Подстановки, которые остались незаполненными.
 *
 * Нужны дважды: сказать при вставке («имя адресата неизвестно») и
 * остановить отправку письма, в котором так и осталось «Здравствуйте,
 * {{имя}}!». Второе — не придирка: именно это и есть та ошибка, ради
 * которой Superhuman не даёт отправить письмо с незаполненным заполнителем.
 */
export function unresolvedPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const whole = match[0];
    if (!found.includes(whole)) found.push(whole);
  }
  return found;
}

/**
 * Разбирает первого получателя из строки поля «Кому».
 *
 * Берётся ПЕРВЫЙ и только он. Письмо, начинающееся с «Здравствуйте,
 * Пётр!», уходит и Петру, и Анне — подставлять имя во множественной
 * рассылке всё равно нельзя, а первый получатель — тот, кому письмо
 * адресовано на самом деле.
 *
 * Строка режется общим разбором (`parseAddresses` из lib/addresses.ts), а
 * не своим `split(/[,;]/)`. Своё резало ровно так, как в поле «Кому» уже
 * однажды сломалось: имя «Иванов, Иван» — а его ставит сама подсказка
 * адреса, в кавычках, и такие имена массово раздают корпоративные
 * почтовые системы — давало первым получателем обрывок «"Иванов». Адреса
 * в нём нет, имени нет, и подстановки {{имя}}, {{адресат}}, {{адрес}}
 * оставались в тексте: окно писало «заполните вручную», а отправка
 * останавливалась — при том что получатель указан правильно.
 */
export function firstRecipient(to: string): { name: string | null; address: string | null } {
  const first = parseAddresses(to)[0];
  if (!first) return { name: null, address: null };
  // Голый адрес: имени мы не знаем и выдумывать его из левой части не
  // будем — см. `substitutionFor`. А недописанный получатель («пет») — это
  // ещё не адрес, и подставлять его в письмо нельзя.
  return { name: first.name, address: first.address.includes('@') ? first.address : null };
}

/**
 * Готовит тело шаблона к вставке в письмо.
 *
 * Подстановки применяются к РАЗМЕТКЕ целиком, а не к тексту: `{{имя}}`
 * человек мог выделить жирным, и тогда в разметке оно живёт внутри тега.
 * Опасности это не несёт — имя вставляется экранированным.
 */
export function prepareTemplateBody(html: string, ctx: SubstitutionContext): string {
  return html.replace(PLACEHOLDER_RE, (whole, key: string) => {
    const value = substitutionFor(key, ctx);
    return value === null ? whole : escapeHtml(value);
  });
}

/** Тема — обычный текст, экранировать нечего. */
export function prepareTemplateSubject(subject: string, ctx: SubstitutionContext): string {
  return applySubstitutions(subject, ctx);
}

/**
 * Имя адресата попадает в РАЗМЕТКУ письма, а пришло оно из поля ввода.
 * Без экранирования получатель по имени `<b onmouseover=…>` менял бы
 * разметку письма отправителя.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}
