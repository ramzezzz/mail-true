/**
 * Проверка связи с сервером ДО начала переноса.
 *
 * Зачем отдельная операция. Отказ на входе — самое частое место отказа
 * вообще: адрес, порт, режим TLS и пароль вводят руками. Перенос ящика
 * идёт часами и запускается обычно на ночь; узнавать об опечатке в имени
 * сервера утром, когда задание встало на первом же ящике, — потеря целой
 * ночи. Проверка стоит секунду и отвечает словами, а не кодом.
 *
 * Что проверяется:
 *   1) соединение и TLS;
 *   2) вход (в служебном режиме — именно служебный, `ящик*служебный`);
 *   3) LIST — то есть у входа есть доступ к ящику, а не только к серверу.
 *
 * Третий шаг важен именно для служебного доступа: пароль служебного
 * пользователя может быть верным, а права на чужой ящик — не выданы.
 * Такой отказ виден только при обращении к ящику, и без него проверка
 * бодро отвечала бы «связь есть», а перенос падал бы на первой папке.
 */

import { connectWithReason, createClient, describeImapError } from './migrator.js';
import {
  loginNameOf,
  type ImapEndpoint,
  type MigrateMailboxOptions,
  type ProbeResult,
} from './types.js';

/** Сколько папок опрашивать по STATUS: полный обход большого ящика — это минуты. */
const STATUS_LIMIT = 200;

/**
 * Проверить связь и доступ к ящику.
 *
 * Никогда не бросает: отказ — это результат проверки, а не авария.
 * В `error` лежит уже разобранное человеческое объяснение
 * (см. describeImapError и connectWithReason).
 */
export async function probeEndpoint(
  endpoint: ImapEndpoint,
  options: {
    role?: 'исходному' | 'целевому';
    logger?: MigrateMailboxOptions['logger'];
    /** Считать письма (лишний обход папок; для быстрой проверки не нужен). */
    countMessages?: boolean;
  } = {},
): Promise<ProbeResult> {
  const loginName = loginNameOf(endpoint);
  const client = createClient(endpoint, options.logger);
  // imapflow бросает 'error' как событие; без обработчика это падение процесса
  client.on('error', () => undefined);

  try {
    await connectWithReason(client, endpoint, options.role ?? 'исходному');
  } catch (err) {
    // Сокет закрываем ОБЯЗАТЕЛЬНО. Отказ входа (сервер ответил NO) соединение
    // не рвёт: оно остаётся открытым и держит и наш процесс, и сессию на
    // чужом сервере. Проверку связи жмут подряд, подбирая параметры, — за
    // десяток попыток это десяток повисших соединений.
    client.close();
    return { ok: false, loginName, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const list = await client.list();
    let messages = 0;
    if (options.countMessages !== false) {
      for (const item of list.slice(0, STATUS_LIMIT)) {
        // \Noselect — папка-контейнер, открыть её нельзя; STATUS по ней
        // вернёт отказ, и это не повод объявлять проверку неуспешной.
        if (item.flags instanceof Set && item.flags.has('\\Noselect')) continue;
        try {
          const st = await client.status(item.path, { messages: true });
          messages += st.messages ?? 0;
        } catch {
          /* папка исчезла или недоступна — не повод валить всю проверку */
        }
      }
    }
    return { ok: true, loginName, folders: list.length, messages };
  } catch (err) {
    return {
      ok: false,
      loginName,
      error:
        `вход прошёл, но список папок получить не удалось: ${describeImapError(err)}` +
        (endpoint.masterUser
          ? '. При служебном доступе это обычно значит, что служебному ' +
            'пользователю не разрешён вход в этот ящик'
          : ''),
    };
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
