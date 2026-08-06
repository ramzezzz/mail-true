/**
 * GET /api/version — версия работающего сервера приложения.
 *
 * Зачем отдельный источник. Нижняя строка состояния в почте показывает
 * версию продукта мелким шрифтом — это первое, что спрашивает поддержка,
 * когда человек пишет «у меня не работает». Спросить её было негде: ни
 * одного маршрута с версией у почтового API не было, а вшить строку
 * в интерфейс значило бы показывать версию СБОРКИ ФРОНТЕНДА, которая
 * после обновления одного лишь сервера разъедется с действительностью
 * и будет врать ровно в тот момент, когда важна правда.
 *
 * Версия берётся из манифеста самого приложения, а не из переменной
 * окружения и не из константы в коде: манифест — единственное место,
 * где она уже есть, и разъехаться с ней невозможно. Если манифест
 * почему-то не читается (обрезанный образ), поле приходит ПУСТЫМ —
 * интерфейс тогда не покажет ничего. Выдуманная «0.0.0» была бы хуже
 * молчания: поддержка приняла бы её за настоящую.
 *
 * Маршрут внутри группы `/api`, то есть за проверкой сессии: версия
 * сервера — подсказка нашему пользователю, а не всякому, кто постучал
 * в порт.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../errors.js';

/**
 * Версия из текста манифеста. Вынесена отдельно и без обращения к диску,
 * чтобы проверка могла показать главное: запасной «0.0.0» здесь неоткуда
 * взяться — неизвестная версия остаётся пустой.
 */
export function parseVersion(manifest: string | null): string | null {
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(manifest) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Версия из apps/api/package.json.
 *
 * Читается ОДИН раз при загрузке модуля: файл на диске не меняется,
 * пока процесс жив, а маршрут не должен ходить в файловую систему на
 * каждый запрос. Путь одинаков и в исходниках (`src/routes/`), и
 * в сборке (`dist/routes/`) — оба лежат на два уровня ниже манифеста.
 */
export function readOwnVersion(): string | null {
  try {
    return parseVersion(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  } catch {
    // Манифеста нет — версия неизвестна.
    return null;
  }
}

const VERSION = readOwnVersion();

export interface VersionResponse {
  /** Версия сервера приложения или null, если узнать её неоткуда. */
  version: string | null;
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/version', { preHandler: app.requireSession }, async (request): Promise<VersionResponse> => {
    if (!request.mailSession) throw new UnauthorizedError();
    return { version: VERSION };
  });
}
