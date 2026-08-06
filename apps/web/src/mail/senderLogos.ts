/**
 * Логотипы доменов для кружков в списке писем: общий на всё окно реестр.
 *
 * ------------------------------------------------------------------
 * Зачем реестр, а не запрос из каждой строки
 * ------------------------------------------------------------------
 * Кружок рисует КАЖДАЯ строка списка, а доменов в списке из пятидесяти
 * писем обычно десяток: три письма от «Госуслуг», восемь от рассылки
 * магазина, двадцать от коллеги. Если бы за логотипом ходила строка, вышло
 * бы пятьдесят запросов вместо одного, и это при том, что строки ещё и
 * переиспользуются при прокрутке.
 *
 * Поэтому строки не спрашивают, а ЗАЯВЛЯЮТ, какой домен им нужен. Заявки
 * копятся до конца текущего кадра, схлопываются в множество и уходят одним
 * запросом. Ответ ложится в общую память окна, и все строки с этим доменом
 * перерисовываются разом.
 *
 * ------------------------------------------------------------------
 * Список писем логотипов НЕ ЖДЁТ
 * ------------------------------------------------------------------
 * Письма приходят своим запросом и рисуются сразу — с буквами. Логотипы
 * приезжают отдельно и заменяют буквы, когда приедут. Домены, которые
 * сервер ещё ищет, отвечаются как `pending`; про них переспрашиваем
 * несколько раз с растущей паузой, а потом успокаиваемся: вечно долбить
 * сервер из-за домена без логотипа незачем.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '../api/http';

export type SenderLogoState =
  /** Логотип есть, вот его адрес НА НАШЕМ сервере. */
  | { status: 'ready'; url: string }
  /** Логотипа нет — рисуется буква. */
  | { status: 'none' }
  /** Сервер ещё ищет; до ответа рисуется буква. */
  | { status: 'pending' };

interface LogosResponse {
  enabled: boolean;
  logos: Record<string, { status: string; url?: string }>;
}

/** Сколько раз переспрашивать про домены, которые ещё ищутся. */
const MAX_ROUNDS = 4;
/** Пауза перед повторным вопросом, мс. Растёт с каждым кругом. */
const RETRY_STEP_MS = 2500;
/** Домены в одном запросе. Столько же принимает сервер. */
const BATCH_LIMIT = 60;

class SenderLogoRegistry {
  #state = new Map<string, SenderLogoState>();
  #pendingRequest = new Set<string>();
  #rounds = new Map<string, number>();
  #listeners = new Set<() => void>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Сервер сказал «выключено» (не разрешил пользователь либо погашено на
   * всём сервере). Больше не спрашиваем ничего: одного запроса на сеанс
   * достаточно, чтобы это выяснить, а дальше он был бы чистым мусором.
   */
  #off = false;
  #version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Версия состояния: по её смене React перечитывает снимок. */
  getVersion = (): number => this.#version;

  get(domain: string): SenderLogoState {
    return this.#state.get(domain) ?? { status: 'pending' };
  }

  /** Строка сообщает, какой домен ей нужен. Дубликаты бесплатны. */
  want(domain: string): void {
    if (this.#off) return;
    const known = this.#state.get(domain);
    if (known && known.status !== 'pending') return;
    if (this.#pendingRequest.has(domain)) return;
    this.#pendingRequest.add(domain);
    this.#schedule(0);
  }

  /**
   * Забыть всё и спросить заново.
   *
   * Нужен ровно в одном месте: человек только что включил настройку. Без
   * этого реестр остался бы в состоянии «выключено» до перезагрузки
   * страницы, и включённая настройка выглядела бы сломанной.
   */
  reset(): void {
    this.#state.clear();
    this.#rounds.clear();
    this.#pendingRequest.clear();
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#off = false;
    this.#bump();
  }

  #schedule(delayMs: number): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, delayMs);
  }

  async #flush(): Promise<void> {
    if (this.#off) return;
    const domains = [...this.#pendingRequest].slice(0, BATCH_LIMIT);
    if (domains.length === 0) return;
    for (const domain of domains) this.#pendingRequest.delete(domain);

    let response: LogosResponse;
    try {
      response = await apiFetch<LogosResponse>('/api/sender-logos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domains }),
      });
    } catch {
      // Сеть отказала — это не «логотипа нет». Оставляем домены в покое:
      // следующее открытие списка заявит их заново.
      for (const domain of domains) this.#state.set(domain, { status: 'none' });
      this.#bump();
      return;
    }

    if (!response.enabled) {
      this.#off = true;
      for (const domain of domains) this.#state.set(domain, { status: 'none' });
      this.#pendingRequest.clear();
      this.#bump();
      return;
    }

    const stillPending: string[] = [];
    for (const domain of domains) {
      const entry = response.logos[domain];
      if (entry?.status === 'ready' && entry.url) {
        this.#state.set(domain, { status: 'ready', url: entry.url });
        this.#rounds.delete(domain);
        continue;
      }
      if (entry?.status === 'pending') {
        const round = (this.#rounds.get(domain) ?? 0) + 1;
        this.#rounds.set(domain, round);
        this.#state.set(domain, { status: 'pending' });
        if (round <= MAX_ROUNDS) stillPending.push(domain);
        else this.#state.set(domain, { status: 'none' });
        continue;
      }
      this.#state.set(domain, { status: 'none' });
      this.#rounds.delete(domain);
    }
    this.#bump();

    if (stillPending.length > 0) {
      for (const domain of stillPending) this.#pendingRequest.add(domain);
      // Пауза растёт: первый круг через 2.5 с, четвёртый — через 10.
      const round = Math.max(...stillPending.map((d) => this.#rounds.get(d) ?? 1));
      this.#schedule(RETRY_STEP_MS * round);
    } else if (this.#pendingRequest.size > 0) {
      this.#schedule(0);
    }
  }

  #bump(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

export const senderLogos = new SenderLogoRegistry();

/** Сбросить реестр — вызывается после включения настройки. */
export function resetSenderLogos(): void {
  senderLogos.reset();
}

/**
 * Состояние логотипа домена для одной строки списка.
 *
 * `domain` приходит из письма и уже проверен СЕРВЕРОМ: он не пуст только
 * у писем, чья подлинность подтверждена (см. apps/api/src/mail/sender-auth.ts).
 * Интерфейс это решение не переигрывает и своего домена не придумывает.
 */
export function useSenderLogo(domain: string | null | undefined): SenderLogoState {
  const version = useSyncExternalStore(
    senderLogos.subscribe,
    senderLogos.getVersion,
    senderLogos.getVersion,
  );
  void version;

  // Заявка подаётся эффектом, а не при отрисовке. Отрисовка в React может
  // быть отброшена и повторена, и заявка из неё превратилась бы в запрос
  // за логотипом строки, которую так и не показали.
  useEffect(() => {
    if (domain) senderLogos.want(domain);
  }, [domain]);

  if (!domain) return { status: 'none' };
  return senderLogos.get(domain);
}
