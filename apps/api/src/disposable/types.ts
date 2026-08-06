/**
 * Контракт раздела «Одноразовые адреса» — общий для сервера и интерфейса.
 *
 * Повторяет форму, принятую у разделов владельца ящика: ответ ВСЕГДА
 * начинается с `available` и `reason`, и только потом идут данные. Причина
 * нужна словами: «не применена миграция 0028» человек прочитает и передаст
 * администратору, а пустой список — нет.
 */

/** Один одноразовый адрес в том виде, в каком его видит владелец ящика. */
export interface DisposableAlias {
  id: number;
  /** Сам адрес: shop-2026@mail.local. */
  address: string;
  /** Куда ведёт — основной ящик владельца. */
  destination: string;
  /** Работает ли. false — приём отклоняется на команде RCPT TO. */
  active: boolean;
  /** Кому выдан: личная пометка владельца («Магазин обуви»). */
  note: string;
  createdAt: string;
  /** Когда выключен; null — работает. */
  disabledAt: string | null;
  /** Что известно про почту на этот адрес. null — журнал недоступен. */
  traffic: DisposableTraffic | null;
}

/**
 * Наблюдения за письмами на адрес.
 *
 * Все числа — ЗА ОКНО ЖУРНАЛА, а не за всё время: postfix.log
 * проворачивается, и обещать «всего писем за год» мы не можем. Окно
 * названо в `windowDays`, и интерфейс обязан его показать — иначе ноль
 * будет прочитан как «на адрес никто не писал», хотя он значит «в том
 * куске журнала, который сохранился, писем нет».
 */
export interface DisposableTraffic {
  /** Сколько писем принято за окно. */
  received: number;
  /** Сколько попыток отклонено (адрес выключен, а на него всё пишут). */
  rejected: number;
  /** Когда пришло последнее письмо; null — не было. */
  lastAt: string | null;
  /** Кто писал: адреса отправителей, свежие первыми. */
  senders: DisposableSender[];
  /** Глубина окна в сутках — ровно столько, сколько покрывает журнал. */
  windowDays: number;
}

export interface DisposableSender {
  address: string;
  count: number;
  lastAt: string;
}

/** Ответ списка. */
export interface DisposableState {
  available: boolean;
  reason: string | null;
  items: DisposableAlias[];
  /** Домен, в котором заводятся адреса, — свой домен ящика. */
  domain: string;
  /** Предел на число адресов у ящика (считая выключенные). */
  limit: number;
  /** Сколько уже занято. */
  used: number;
}

/** Пустое состояние с причиной — им отвечают, пока возможности нет. */
export const DISPOSABLE_UNAVAILABLE: Omit<DisposableState, 'reason'> = {
  available: false,
  items: [],
  domain: '',
  limit: 0,
  used: 0,
};
