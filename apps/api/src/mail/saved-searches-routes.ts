/**
 * Маршруты сохранённых поисковых запросов.
 *
 *   GET    /api/searches      — список и доступность возможности
 *   POST   /api/searches      — сохранить запрос под именем
 *   DELETE /api/searches/:id  — убрать
 *
 * Правки нет намеренно. Сохранённый запрос — это строка, которую человек
 * видит целиком и может открыть, поправить в поисковой строке и сохранить
 * заново; отдельная форма правки повторяла бы поисковую строку и неизбежно
 * от неё отстала бы. Переименование при этом делается тем же путём.
 *
 * Возможность целиком зависит от базы: нет базы или не применена миграция —
 * `available: false` с причиной, и интерфейс не показывает ни кнопки
 * «Сохранить запрос», ни группы в левой колонке. Кнопка появляется вместе
 * с поведением — то же правило, что у меток и отложенных писем.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import {
  MAX_SAVED_SEARCH_NAME_LENGTH,
  MAX_SAVED_SEARCH_QUERY_LENGTH,
  MAX_SAVED_SEARCHES,
  normalizeSavedSearchName,
  normalizeSavedSearchQuery,
  type SavedSearch,
} from './saved-searches.js';
import { isUndefinedTable, type SavedSearchStore } from './saved-searches-db.js';
import type { MailSession } from '../types.js';

/** Подсказка, если миграцию 0027 ещё не применили. */
export const SAVED_SEARCHES_MIGRATION_HINT =
  'Таблицы сохранённых запросов нет. Примените ' +
  'infra/postgres/migrations/0001_baseline.sql к работающей базе.';

const draftSchema = z.object({
  name: z.string().min(1).max(MAX_SAVED_SEARCH_NAME_LENGTH),
  query: z.string().min(1).max(MAX_SAVED_SEARCH_QUERY_LENGTH),
  includeJunk: z.boolean().default(false),
});

const idParamSchema = z.object({ id: z.string().min(1).max(32) });

export interface SavedSearchesDeps {
  store: SavedSearchStore | null;
  /** Почему возможности нет. Пусто — возможность есть. */
  unavailableReason: string;
}

/**
 * Состояние возможности: список либо есть целиком, либо честно нет.
 * Отдельного «частично работает» не бывает намеренно — см. LabelsState.
 */
export interface SavedSearchesState {
  available: boolean;
  reason: string | null;
  items: SavedSearch[];
}

function requireMailSession(session: MailSession | null): MailSession {
  if (!session) throw new UnauthorizedError();
  return session;
}

export async function savedSearchRoutes(
  app: FastifyInstance,
  deps: SavedSearchesDeps,
): Promise<void> {
  const requireStore = (): SavedSearchStore => {
    if (!deps.store) throw new BadRequestError(deps.unavailableReason);
    return deps.store;
  };

  const listOf = async (session: MailSession): Promise<SavedSearch[]> => {
    if (!deps.store) return [];
    try {
      return await deps.store.list(session.email);
    } catch (err) {
      if (isUndefinedTable(err)) throw new BadRequestError(SAVED_SEARCHES_MIGRATION_HINT);
      throw err;
    }
  };

  app.get(
    '/searches',
    { preHandler: app.requireSession },
    async (request): Promise<SavedSearchesState> => {
      const session = requireMailSession(request.mailSession);
      if (!deps.store) {
        return { available: false, reason: deps.unavailableReason, items: [] };
      }
      return { available: true, reason: null, items: await listOf(session) };
    },
  );

  app.post('/searches', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const body = draftSchema.parse(request.body);
    const name = normalizeSavedSearchName(body.name);
    const query = normalizeSavedSearchQuery(body.query);
    if (name === '') throw new BadRequestError('У сохранённого запроса должно быть имя');
    /*
     * Пустой запрос сохранить нельзя. Поиск без запроса ничего не ищет
     * (см. apps/web/src/search/useSearch.ts), и такой сохранённый запрос
     * открывал бы пустой экран — то есть был бы кнопкой без поведения.
     */
    if (query === '') throw new BadRequestError('Нечего сохранять: запрос пуст');

    const existing = await listOf(session);
    if (existing.length >= MAX_SAVED_SEARCHES) {
      throw new BadRequestError(
        `Сохранённых запросов уже ${String(MAX_SAVED_SEARCHES)} — больше не поместится в колонку. ` +
          'Уберите ненужные.',
      );
    }

    const created = await requireStore().create(session.email, {
      name,
      query,
      includeJunk: body.includeJunk,
    });
    /*
     * `null` — имя занято. Отвечаем отказом, а не молча вторым таким же
     * именем: два одинаковых имени в колонке человек различить не сможет
     * и нажимать будет наугад.
     */
    if (!created) throw new BadRequestError(`Запрос с именем «${name}» уже сохранён`);
    return created;
  });

  app.delete('/searches/:id', { preHandler: app.requireSession }, async (request) => {
    const session = requireMailSession(request.mailSession);
    const { id } = idParamSchema.parse(request.params);
    const removed = await requireStore().remove(session.email, id);
    if (!removed) throw new NotFoundError(`Сохранённый запрос не найден: ${id}`);
    return { ok: true, id: removed.id, name: removed.name };
  });
}
