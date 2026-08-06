/**
 * Защита процесса от смерти по необработанной ошибке.
 *
 * Дважды за проход проверок процесс API умирал целиком. Причина у такой
 * смерти всегда одна из двух:
 *
 *  1. Необработанное событие `error` на источнике событий. Node в этом случае
 *     не «логирует и продолжает», а бросает ошибку в пустоту и убивает
 *     процесс. Источников тут хватает: IMAP-клиенты пула и IDLE-соединения
 *     WebSocket живут долго и рвутся вместе с сетью.
 *  2. Отклонённое обещание, которое никто не поймал (`unhandledRejection`) —
 *     начиная с Node 15 это тоже гарантированная смерть процесса.
 *
 * Слушателей на оба события не было вовсе, поэтому единственный чужой сбой
 * (перезапуск Dovecot, обрыв TCP) валил весь API вместе с чужими сессиями.
 *
 * Что делаем: пишем в журнал и продолжаем работать. Это осознанный выбор.
 * Подавляющее большинство таких ошибок приходит от внешних соединений и
 * состояние сервера не портит, а падение процесса гарантированно рвёт все
 * запросы всех пользователей — цена несопоставима. Чтобы это не превращалось
 * в тихое гниение, каждая такая ошибка пишется уровнем `error` с признаком
 * `fatalGuard`, по которому её видно в журнале.
 */
import type { Logger } from 'pino';

export type GuardKind = 'uncaughtException' | 'unhandledRejection';

export interface ProcessGuards {
  /** Снимает установленные слушатели (нужно тестам и корректному останову). */
  uninstall(): void;
}

/** Обрабатывает одну необработанную ошибку: пишет в журнал и не роняет процесс. */
export function handleFatal(logger: Logger, kind: GuardKind, err: unknown): void {
  try {
    logger.error(
      { err, kind, fatalGuard: true },
      kind === 'uncaughtException'
        ? 'Необработанное исключение — процесс продолжает работу'
        : 'Необработанное отклонение обещания — процесс продолжает работу'
    );
  } catch {
    // Журнал сломан — но и он не повод убивать процесс
     
    console.error('Необработанная ошибка:', err);
  }
}

/** Вешает слушатели на uncaughtException и unhandledRejection. */
export function installProcessGuards(logger: Logger, target: NodeJS.Process = process): ProcessGuards {
  const onException = (err: unknown): void => handleFatal(logger, 'uncaughtException', err);
  const onRejection = (reason: unknown): void => handleFatal(logger, 'unhandledRejection', reason);

  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);

  return {
    uninstall(): void {
      target.off('uncaughtException', onException);
      target.off('unhandledRejection', onRejection);
    },
  };
}
