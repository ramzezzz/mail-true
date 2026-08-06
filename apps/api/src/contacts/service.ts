/**
 * Подсказка адреса: сведение указателя, сборщика и настройки ящика.
 *
 * Здесь же живёт единственное правило, ради которого этот слой вообще
 * нужен: подсказка отвечает по тому, что уже собрано, и НИКОГДА не ждёт
 * сборщика. Человек в этот момент печатает адрес; заставить его ждать
 * выборки писем из IMAP — значит вернуть ту самую задержку, ради
 * устранения которой указатель и заведён.
 */
import type { Logger } from 'pino';
import { errorInfo } from '../log.js';
import type { MailSession } from '../types.js';
import type { ContactsDb } from './db.js';
import type { ContactHarvester } from './harvester.js';
import { rankContacts, SUGGEST_LIMIT } from './rank.js';
import { normalizeAddress, normalizeQuery } from './tokens.js';
import type { ContactSuggestResponse } from './types.js';

export interface ContactsEnvironment {
  /**
   * Разрешил ли человек пополнять адресную книгу из полученных писем.
   *
   * Это переключатель «автоматически пополнять контакты» из общих
   * настроек ящика — он был в контракте настроек с самого начала, но не
   * управлял ничем, потому что самой книги не существовало; из-за этого
   * его даже не показывали в интерфейсе. Теперь он управляет ровно тем,
   * что обещает.
   */
  collectReceived(email: string): Promise<boolean>;
}

export interface ContactsServiceOptions {
  db: ContactsDb | null;
  harvester: ContactHarvester | null;
  env: ContactsEnvironment;
  logger: Logger;
}

const EMPTY: ContactSuggestResponse = { items: [], complete: false };

export class ContactsService {
  readonly #db: ContactsDb | null;
  #harvester: ContactHarvester | null;
  readonly #env: ContactsEnvironment;
  readonly #logger: Logger;
  /** Указатель ящика разобран целиком — чтобы не спрашивать базу лишний раз. */
  readonly #complete = new Set<string>();

  constructor(opts: ContactsServiceOptions) {
    this.#db = opts.db;
    this.#harvester = opts.harvester;
    this.#env = opts.env;
    this.#logger = opts.logger;
  }

  /** Есть ли база: без неё подсказка молчит, а почта работает как обычно. */
  get available(): boolean {
    return this.#db !== null;
  }

  /**
   * Связывает службу со сборщиком.
   *
   * Отдельным вызовом, а не параметром конструктора, потому что связь
   * взаимная: сборщик сообщает службе о своей готовности (onProgress), а
   * служба его будит. Требовать друг друга в конструкторах значило бы
   * сделать невозможным случай «база не настроена», где сборщика нет
   * вовсе, а служба обязана работать и отвечать пустой подсказкой.
   */
  attachHarvester(harvester: ContactHarvester | null): void {
    this.#harvester = harvester;
  }

  /**
   * Просит сборщик пополнить указатель, ничего не ожидая.
   *
   * Зовётся, как только поле «Кому» получает фокус (интерфейс шлёт
   * запрос с пустым `q`), а не с первой набранной буквой. Разница в
   * сотнях миллисекунд, и они решают: пока человек тянется к клавиатуре,
   * сборщик успевает разобрать последние письма — то есть ровно те
   * адреса, которые сейчас понадобятся.
   *
   * Настройка «пополнять контакты» спрашивается КАЖДЫЙ раз, без запоминания
   * на время. Запоминание сэкономило бы один запрос по первичному ключу
   * (доли миллисекунды при том, что ответ подсказки этого не ждёт) и купило
   * бы взамен неприятность: человек выключил сбор, а он ещё минуту
   * продолжается. Про приватность так не поступают.
   */
  warm(session: MailSession): void {
    if (!this.#harvester) return;
    void this.#env
      .collectReceived(session.email)
      .then((collectReceived) => this.#harvester?.kick({ session, collectReceived }))
      .catch((err: unknown) => {
        this.#logger.debug(errorInfo(err), 'Подсказка адреса: не удалось запустить сборщик');
      });
  }

  /**
   * Подсказка по набранному началу.
   *
   * Порядок действий важен: сначала СПРАШИВАЕМ указатель, потом просим
   * сборщик пополниться. Наоборот — значит подмешать в ответ ожидание
   * сборщика, пусть даже небольшое.
   */
  async suggest(
    session: MailSession,
    rawQuery: string,
    exclude: readonly string[] = [],
  ): Promise<ContactSuggestResponse> {
    const db = this.#db;
    if (!db) return EMPTY;

    const account = session.email.toLowerCase();
    const query = normalizeQuery(rawQuery);

    // Пустой запрос: подсказывать нечего, но повод разогреть указатель
    // есть — поле «Кому» только что получило фокус, и следующая буква
    // должна найти уже собранные адреса.
    if (query === '') {
      this.warm(session);
      return { items: [], complete: this.#complete.has(account) };
    }

    let items: ContactSuggestResponse['items'] = [];
    try {
      const excluded = exclude
        .map((value) => normalizeAddress(value))
        .filter((value): value is string => value !== null);
      const rows = await db.suggest(account, query, excluded);
      items = rankContacts(rows, query, new Date(), SUGGEST_LIMIT).map((row) => ({
        address: row.address,
        name: row.name,
        own: row.sentCount > 0,
      }));
    } catch (err) {
      // Отказ базы не должен мешать писать письмо: подсказка молчит,
      // поле «Кому» работает ровно так же, как работало до неё.
      this.#logger.warn(errorInfo(err), 'Подсказка адреса: указатель не прочитан');
      return EMPTY;
    }

    this.warm(session);
    return { items, complete: this.#complete.has(account) };
  }

  /** Убрать адрес из подсказок или вернуть обратно. */
  async setHidden(
    session: MailSession,
    rawAddress: string,
    hidden: boolean,
  ): Promise<{ address: string; hidden: boolean }> {
    const db = this.#db;
    const address = normalizeAddress(rawAddress);
    if (!db || !address) return { address: rawAddress, hidden: false };
    await db.setHidden(session.email.toLowerCase(), address, hidden);
    return { address, hidden };
  }

  /** Отмечает, что указатель ящика разобран целиком (зовёт сборщик). */
  markComplete(email: string, complete: boolean): void {
    const account = email.toLowerCase();
    if (complete) this.#complete.add(account);
    else this.#complete.delete(account);
  }
}
