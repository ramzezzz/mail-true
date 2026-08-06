/**
 * Сериализация сохранений черновика.
 *
 * Дефект, который здесь закрывается. Сохранение черновика — это два действия:
 * положить новую версию (IMAP APPEND) и удалить старую по её UID. Они не были
 * ни сериализованы, ни связаны между собой, поэтому пять одновременных
 * сохранений одного черновика создавали пять писем: каждое клало свою копию
 * и пыталось удалить один и тот же исходный UID, который после первого раза
 * уже не существовал. Ровно это и происходит, когда таймер автосохранения
 * срабатывает вместе с явным «сохранить».
 *
 * Что делает эта очередь:
 *  - сохранения одного ящика (и одного окна написания) идут строго по одному;
 *  - если черновик уже переехал на новый UID, следующее сохранение удаляет
 *    ИМЕННО ЕГО, а не устаревший UID, присланный клиентом.
 */

export interface DraftSaveResult<T> {
  /** UID новой версии черновика (null — не удалось узнать). */
  uid: number | null;
  result: T;
}

interface Chain {
  queue: Promise<unknown>;
  /** UID последней версии, записанной этой очередью. */
  latest: number | undefined;
  /** UID, которые эта очередь уже заменила. */
  replaced: Set<number>;
  forgetTimer: NodeJS.Timeout | null;
}

/** Сколько помнить состояние окна написания после последнего сохранения. */
const FORGET_AFTER_MS = 30 * 60 * 1000;
/** Ограничение памяти на одну цепочку. */
const MAX_REPLACED = 200;

export class DraftSequencer {
  private readonly chains = new Map<string, Chain>();

  constructor(private readonly forgetAfterMs: number = FORGET_AFTER_MS) {}

  private chainFor(key: string): Chain {
    const existing = this.chains.get(key);
    if (existing) {
      if (existing.forgetTimer) {
        clearTimeout(existing.forgetTimer);
        existing.forgetTimer = null;
      }
      return existing;
    }
    const chain: Chain = {
      queue: Promise.resolve(),
      latest: undefined,
      replaced: new Set(),
      forgetTimer: null,
    };
    this.chains.set(key, chain);
    return chain;
  }

  private scheduleForget(key: string, chain: Chain): void {
    if (chain.forgetTimer) clearTimeout(chain.forgetTimer);
    chain.forgetTimer = setTimeout(() => {
      if (this.chains.get(key) === chain) this.chains.delete(key);
    }, this.forgetAfterMs);
    chain.forgetTimer.unref?.();
  }

  /**
   * Выполняет сохранение черновика по очереди.
   *
   * @param key ключ окна написания (`ящик` или `ящик:идентификатор окна`)
   * @param requestedUid UID, который прислал клиент
   * @param trackWindow помнить последнюю версию, даже если UID не прислан
   *   (окно написания опознано клиентом) — иначе автосохранение нового письма
   *   всё равно наплодит копий
   * @param op само сохранение; получает UID версии, которую нужно удалить
   */
  async save<T>(
    key: string,
    requestedUid: number | undefined,
    trackWindow: boolean,
    op: (previousUid: number | undefined) => Promise<DraftSaveResult<T>>,
  ): Promise<T> {
    const chain = this.chainFor(key);

    const run = async (): Promise<T> => {
      let previous = requestedUid;
      if (requestedUid !== undefined && chain.replaced.has(requestedUid)) {
        // Присланный UID уже заменён этой же очередью — удалять надо новую версию
        previous = chain.latest;
      } else if (requestedUid === undefined && trackWindow) {
        previous = chain.latest;
      }

      const { uid, result } = await op(previous);

      if (previous !== undefined) chain.replaced.add(previous);
      if (requestedUid !== undefined) chain.replaced.add(requestedUid);
      if (chain.replaced.size > MAX_REPLACED) {
        // Держим только хвост: старые UID уже никому не интересны
        const tail = [...chain.replaced].slice(-MAX_REPLACED / 2);
        chain.replaced.clear();
        for (const value of tail) chain.replaced.add(value);
      }
      if (uid !== null) chain.latest = uid;
      return result;
    };

    const task = chain.queue.then(run, run);
    chain.queue = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      this.scheduleForget(key, chain);
    }
  }

  /** Забывает состояние ящика (например, при выходе). */
  forget(key: string): void {
    const chain = this.chains.get(key);
    if (chain?.forgetTimer) clearTimeout(chain.forgetTimer);
    this.chains.delete(key);
  }
}
