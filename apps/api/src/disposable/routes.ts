/**
 * Маршруты раздела «Одноразовые адреса».
 *
 *   GET    /api/settings/aliases          — список со сводкой по журналу
 *   POST   /api/settings/aliases          — завести адрес
 *   PATCH  /api/settings/aliases/:id      — выключить/включить, поправить пометку
 *   DELETE /api/settings/aliases/:id      — удалить совсем
 *
 * Ящик берётся ИЗ СЕССИИ, и передать чужой негде: в запросах для него нет
 * места. Это не удобство, а суть раздела — список чужих псевдонимов
 * отвечает на вопрос «под какими адресами этот человек прячется», и
 * возможность его получить обесценила бы всю затею.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import type { MailSession } from '../types.js';
import { isUniqueViolation, type DisposableRow, type DisposableStore } from './db.js';
import { checkLocalPart, domainOf, suggestLocalPart } from './name.js';
import { readTraffic } from './traffic.js';
import type { DisposableAlias, DisposableState } from './types.js';

export const DISPOSABLE_NO_DATABASE =
  'Одноразовые адреса недоступны: не настроена база данных. Почта работает как обычно.';

export const DISPOSABLE_MIGRATION_HINT =
  'Одноразовые адреса недоступны: не применена миграция ' +
  'infra/postgres/migrations/0028_disposable_aliases.sql';

export interface DisposableDeps {
  /** Хранилище; null — возможности нет, причина в `unavailableReason`. */
  store: DisposableStore | null;
  unavailableReason: string;
  /** Предел числа адресов на ящик, считая выключенные. */
  limit: number;
  /** Где лежит postfix.log — из него берётся сводка. */
  logDir: string;
}

const createSchema = z.object({
  /**
   * Имя адреса без домена. Пусто — придумать самим: человек нажал
   * «придумать», не вписав ничего.
   */
  name: z.string().trim().toLowerCase().max(64).default(''),
  /** Кому выдан. */
  note: z.string().trim().max(500).default(''),
});

const patchSchema = z.object({
  active: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function disposableRoutes(app: FastifyInstance, deps: DisposableDeps): Promise<void> {
  const sessionOf = (request: { mailSession: MailSession | null }): MailSession => {
    if (!request.mailSession) throw new UnauthorizedError();
    return request.mailSession;
  };

  /** Хранилище или честный отказ — один на все меняющие маршруты. */
  const storeOf = (): DisposableStore => {
    if (!deps.store) throw new BadRequestError(deps.unavailableReason);
    return deps.store;
  };

  app.get(
    '/aliases',
    { preHandler: app.requireSession },
    async (request): Promise<DisposableState> => {
      const session = sessionOf(request);
      if (!deps.store) {
        return {
          available: false,
          reason: deps.unavailableReason,
          items: [],
          domain: domainOf(session.email),
          limit: deps.limit,
          used: 0,
        };
      }

      const rows = await deps.store.list(session.email);
      /*
       * Сводка по журналу собирается ОДНИМ проходом на весь список
       * (см. traffic.ts). Её отсутствие не должно ронять список: адреса
       * важнее чисел про них, и раздел обязан открываться на сервере, где
       * журнал Postfix не примонтирован вовсе.
       */
      let traffic: Awaited<ReturnType<typeof readTraffic>> = null;
      try {
        traffic = await readTraffic({ dir: deps.logDir, addresses: rows.map((r) => r.address) });
      } catch {
        traffic = null;
      }

      return {
        available: true,
        reason: null,
        items: rows.map((row) => toDto(row, traffic?.get(row.address.toLowerCase()) ?? null)),
        domain: domainOf(session.email),
        limit: deps.limit,
        used: rows.length,
      };
    },
  );

  app.post('/aliases', { preHandler: app.requireSession }, async (request, reply) => {
    const session = sessionOf(request);
    const store = storeOf();
    const body = createSchema.parse(request.body);
    const domain = domainOf(session.email);

    /*
     * Предел на число адресов.
     *
     * Проверяется ДО всего остального и считает ВЫКЛЮЧЕННЫЕ тоже. Иначе
     * предела нет вовсе: выключил — завёл следующий, а имена в домене
     * заняты все, потому что выключенный адрес имя не освобождает
     * (и не должен, см. миграцию 0028).
     */
    const used = await store.count(session.email);
    if (used >= deps.limit) {
      throw new BadRequestError(
        `Больше ${deps.limit} одноразовых адресов на ящик заводить нельзя — сейчас занято ${used}. ` +
          'Удалите ненужные: выключенный адрес продолжает занимать имя, потому что ' +
          'освободить его значило бы отдать чужому человеку почту, которую ещё шлют на старый адрес.',
      );
    }

    const name = body.name === '' ? suggestLocalPart(body.note) : body.name;
    const problem = checkLocalPart(name);
    if (problem) throw new BadRequestError(problem.message);

    const address = `${name}@${domain}`;

    /*
     * Занятость смотрится по ОБЕИМ таблицам — ящикам и алиасам
     * (см. store.taken). Это тот самый риск, ради которого пункт 14
     * разбора помечен опасным: псевдоним, совпавший с живым ящиком,
     * уводит всю его входящую почту, потому что карта алиасов
     * разбирается раньше карты ящиков.
     */
    if (await store.taken(address)) {
      throw new BadRequestError(
        `Адрес «${address}» уже занят. Возьмите другое имя — например, ` +
          `«${suggestLocalPart(name)}».`,
      );
    }

    const domainId = await store.domainId(domain);
    if (domainId === null) {
      throw new BadRequestError(
        `Домен «${domain}» не заведён на сервере. Одноразовый адрес можно завести только в своём домене.`,
      );
    }

    try {
      const row = await store.create({
        domainId,
        address,
        ownerEmail: session.email,
        note: body.note,
      });
      reply.status(201);
      return toDto(row, null);
    } catch (err) {
      /*
       * Уникальный индекс сработал между проверкой и записью: тот же
       * адрес завели в соседней вкладке. Отказ понятный, а не 500.
       */
      if (isUniqueViolation(err)) {
        throw new BadRequestError(`Адрес «${address}» только что заняли. Попробуйте другое имя.`);
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/aliases/:id',
    { preHandler: app.requireSession },
    async (request) => {
      const session = sessionOf(request);
      const store = storeOf();
      const { id } = idParam.parse(request.params);
      const body = patchSchema.parse(request.body);

      let row: DisposableRow | null = null;
      if (body.active !== undefined) {
        row = await store.setActive(session.email, id, body.active);
        if (!row) throw new NotFoundError('Адрес не найден');
      }
      if (body.note !== undefined) {
        row = await store.setNote(session.email, id, body.note);
        if (!row) throw new NotFoundError('Адрес не найден');
      }
      if (!row) throw new BadRequestError('Нечего менять');
      return toDto(row, null);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/aliases/:id',
    { preHandler: app.requireSession },
    async (request) => {
      const session = sessionOf(request);
      const store = storeOf();
      const { id } = idParam.parse(request.params);
      const row = await store.remove(session.email, id);
      if (!row) throw new NotFoundError('Адрес не найден');
      return { ok: true, address: row.address };
    },
  );
}

const toDto = (row: DisposableRow, traffic: DisposableAlias['traffic']): DisposableAlias => ({
  id: row.id,
  address: row.address,
  destination: row.destination,
  active: row.active,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
  disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
  traffic,
});
