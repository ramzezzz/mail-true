/**
 * Журнал самого сервера приложения — вторым потоком в файл общего тома.
 *
 * ЗАЧЕМ. Раздел «Журналы» админки обязан показывать не только почтовые
 * службы, но и то, что пишет сервер приложения. Его записи уходят в stdout
 * контейнера, а прочитать stdout можно только через сокет Docker, которого
 * у нас нет и не будет (это права root на всей машине). Значит, нужен файл.
 *
 * ПОЧЕМУ НЕ ВМЕСТО STDOUT, А ВМЕСТЕ С НИМ. `docker compose logs api` —
 * первое, куда смотрят при разборе аварии, и на этот вывод опираются
 * проверки стенда. Отобрать его ради админки нельзя. Поэтому pino пишет
 * в оба места сразу.
 *
 * ПРОВОРОТ. Файл в томе никто не проворачивает — значит, проворачиваем
 * сами по размеру. Без этого журнал рос бы без конца и однажды занял бы
 * место, нужное письмам.
 */
import { renameSync, statSync } from 'node:fs';
// Модуль целиком, а не `{ pino }`: у pino объявлен `export =`, и
// destination/multistream живут на самой функции, а не рядом с ней.
import pino from 'pino';

export interface AppLogFileOptions {
  /** Путь к файлу. Пусто — файл не ведём, остаётся только stdout. */
  path: string;
  /** Уровень, с которого пишем (тот же, что у stdout). */
  level: string;
  /** Предел размера, после которого файл проворачивается. */
  maxBytes?: number;
  /** Сколько провёрнутых кусков хранить. */
  keep?: number;
  /** Куда пожаловаться, если файл открыть не удалось. */
  onError?: (message: string) => void;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Собирает набор потоков для pino: stdout всегда, файл — если задан и
 * открылся.
 *
 * Неудача с файлом НЕ должна ронять сервер: журнал в админке — удобство,
 * а работающая почта — нет. Если файл не открылся, остаётся stdout, а
 * причина попадает в него же.
 */
export function createLogStreams(options: AppLogFileOptions): {
  stream: pino.DestinationStream;
  rotate: (() => void) | null;
} {
  const streams: pino.StreamEntry[] = [
    { level: options.level as pino.Level, stream: process.stdout },
  ];
  let rotate: (() => void) | null = null;

  if (options.path !== '') {
    try {
      const dest = pino.destination({ dest: options.path, sync: false, mkdir: true });
      streams.push({ level: options.level as pino.Level, stream: dest });
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      const keep = Math.max(1, options.keep ?? 2);
      rotate = () => {
        try {
          const size = statSync(options.path).size;
          if (size < maxBytes) return;
          // Сдвигаем поколения: api.log.1 -> api.log.2 и так далее.
          for (let i = keep - 1; i >= 1; i -= 1) {
            try {
              renameSync(`${options.path}.${i}`, `${options.path}.${i + 1}`);
            } catch {
              // Такого поколения ещё нет — это нормально
            }
          }
          renameSync(options.path, `${options.path}.1`);
          // Без переоткрытия запись продолжилась бы в переименованный файл
          // по уже открытому дескриптору, а новый остался бы пустым.
          dest.reopen();
        } catch {
          // Проворот — обслуживание, а не работа сервера: молча пропускаем
        }
      };
    } catch (err) {
      options.onError?.(
        `Не удалось открыть файл журнала ${options.path}: ${
          err instanceof Error ? err.message : String(err)
        }. Раздел «Журналы» админки не покажет записи сервера приложения; ` +
          'в stdout контейнера они идут по-прежнему.',
      );
    }
  }

  return { stream: pino.multistream(streams), rotate };
}
