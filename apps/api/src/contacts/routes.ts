/**
 * Маршруты подсказки адреса.
 *
 * Все требуют почтовую сессию и работают только со своим ящиком: адрес
 * владельца берётся из сессии, а не из запроса. Передать чужой адрес
 * нельзя — не потому что «проверяем», а потому что его негде указать.
 * Указатель переписки — сведения о круге общения человека, и второго
 * пути к ним быть не должно.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UnauthorizedError } from '../errors.js';
import type { MailSession } from '../types.js';
import type { ContactsService } from './service.js';

const suggestQuerySchema = z.object({
  /**
   * То, что человек уже набрал. Длина ограничена не «на всякий случай»:
   * запрос идёт в LIKE, и километровая строка — это работа базы впустую.
   */
  q: z.string().max(200).default(''),
  /**
   * Адреса, уже введённые в поле. Повторно предлагать их нельзя: человек
   * увидел бы в подсказке то, что у него уже написано, и выбрал бы дубль.
   *
   * Отсекаются на сервере, а не только в браузере, потому что предел
   * выдачи применяется здесь: восемь подсказок, из которых три уже
   * введены, — это пять полезных, и человек не поймёт, куда делись
   * остальные.
   */
  exclude: z.string().max(4000).optional(),
});

const addressSchema = z.object({ address: z.string().min(3).max(320) });

function requireSession(request: { mailSession: MailSession | null }): MailSession {
  const session = request.mailSession;
  if (!session) throw new UnauthorizedError();
  return session;
}

export async function contactsRoutes(
  app: FastifyInstance,
  service: ContactsService,
): Promise<void> {
  /**
   * Подсказка адреса.
   *
   * Отвечает 200 и пустым списком, даже когда база недоступна или
   * миграция не применена. Это не «проглатывание ошибки»: подсказка —
   * помощь, а не действие. Ответ 503 заставил бы интерфейс показывать
   * человеку сообщение об отказе в тот момент, когда он просто набирает
   * адрес, — и мешал бы работать сильнее, чем отсутствие подсказки.
   * О недоступности говорится в журнале сервера при старте.
   */
  app.get('/suggest', { preHandler: app.requireSession }, async (request) => {
    const session = requireSession(request);
    const query = suggestQuerySchema.parse(request.query);
    const exclude = (query.exclude ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return service.suggest(session, query.q, exclude);
  });

  /**
   * Убрать адрес из подсказок.
   *
   * Зачем это вообще есть. Человек однажды ошибся буквой в адресе, письмо
   * ушло в никуда — и опечатка попала в указатель. Без этого маршрута она
   * предлагалась бы ему год, стоя в списке рядом с верным адресом и
   * отличаясь одной буквой. Это не мелкое неудобство: подсказка,
   * содержащая неверный адрес, ровно тем и опасна, что её выбирают не
   * глядя.
   *
   * Возврат делает тот же маршрут с `restore` — убрать нужный адрес по
   * ошибке так же легко, как ошибиться в нём, и односторонняя дверь тут
   * ни к чему.
   */
  app.post('/hide', { preHandler: app.requireSession }, async (request) => {
    const session = requireSession(request);
    const { address } = addressSchema.parse(request.body);
    return service.setHidden(session, address, true);
  });

  app.post('/restore', { preHandler: app.requireSession }, async (request) => {
    const session = requireSession(request);
    const { address } = addressSchema.parse(request.body);
    return service.setHidden(session, address, false);
  });
}
