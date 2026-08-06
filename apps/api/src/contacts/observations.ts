/**
 * Что именно вынимается из письма в указатель переписки.
 *
 * Работает не с ImapFlow, а с описанием конверта — того минимума, который
 * возвращает FETCH ENVELOPE. Это не «ради красоты слоёв»: правила отбора
 * (кого брать, кого выбрасывать, чей адрес считать своим) иначе нечем
 * проверить, кроме как поднятым Dovecot с подготовленным ящиком, — и они
 * остались бы непроверенными.
 */
import { normalizeAddress, normalizeName } from './tokens.js';

/** Одно наблюдение: этот адрес встретился в письме такого-то направления. */
export interface ContactObservation {
  address: string;
  name: string | null;
  /** 'sent' — мы писали ему, 'received' — он писал нам. */
  direction: 'sent' | 'received';
  at: Date;
}

/** Свёрнутое наблюдение: то, что уходит в базу одной строкой. */
export interface FoldedContact {
  address: string;
  name: string | null;
  sentDelta: number;
  recvDelta: number;
  lastSeenAt: Date;
}

/** Адрес в конверте, как его отдаёт ImapFlow. */
export interface EnvelopeAddress {
  name?: string | undefined;
  address?: string | undefined;
}

/** Конверт письма — только те поля, которые нас касаются. */
export interface EnvelopeLike {
  from?: EnvelopeAddress[] | undefined;
  to?: EnvelopeAddress[] | undefined;
  cc?: EnvelopeAddress[] | undefined;
  bcc?: EnvelopeAddress[] | undefined;
  date?: Date | string | null | undefined;
}

/**
 * Дата письма.
 *
 * Заголовок Date пишет отправитель, и верить ему нельзя: письма с датой
 * «2037 год» приходят регулярно (сбитые часы, попытка застрять наверху
 * списка). Такая дата отравила бы порядок подсказок навсегда — множитель
 * свежести у неё максимальный и не спадёт никогда. Поэтому дата из
 * будущего заменяется временем разбора, а негодная — тоже.
 */
export function messageDate(raw: Date | string | null | undefined, now: Date): Date {
  if (!raw) return now;
  const value = raw instanceof Date ? raw : new Date(raw);
  const time = value.getTime();
  if (!Number.isFinite(time)) return now;
  // Небольшой допуск на расхождение часов между машинами — сутки.
  if (time > now.getTime() + 86_400_000) return now;
  return value;
}

/**
 * Наблюдения из одного письма.
 *
 * Из полученного письма берётся ОТПРАВИТЕЛЬ, из отправленного —
 * ПОЛУЧАТЕЛИ («Кому», «Копия», «Скрытая»). Так и просил разбор: источник
 * подсказки — сама переписка, а не всё, что мелькало в заголовках.
 *
 * Почему не берутся ещё и «Кому»/«Копия» полученного письма, хотя это
 * выглядело бы щедрее: там сидят адреса рассылок и все прочие подписчики,
 * с которыми человек не переписывался ни разу. Подсказка из таких адресов
 * — это ровно тот случай, когда письмо уходит не туда.
 *
 * Свой адрес выбрасывается: он стоит получателем в каждом письме, которое
 * человек отправил себе же копией, и всплывал бы первым пунктом всегда,
 * притом что подсказывать человеку его собственный адрес незачем.
 */
export function observationsFromEnvelope(
  envelope: EnvelopeLike,
  role: 'inbox' | 'sent',
  ownAddresses: ReadonlySet<string>,
  now: Date,
): ContactObservation[] {
  const at = messageDate(envelope.date, now);
  const direction = role === 'sent' ? 'sent' : 'received';
  const source =
    role === 'sent'
      ? [...(envelope.to ?? []), ...(envelope.cc ?? []), ...(envelope.bcc ?? [])]
      : [...(envelope.from ?? [])];

  const seen = new Set<string>();
  const result: ContactObservation[] = [];
  for (const item of source) {
    const address = normalizeAddress(item.address);
    if (!address) continue;
    if (ownAddresses.has(address)) continue;
    // Один и тот же адрес в «Кому» и «Копии» одного письма — это одно
    // письмо, а не два: иначе счётчик рос бы вдвое от опечатки отправителя.
    if (seen.has(address)) continue;
    seen.add(address);
    result.push({ address, name: normalizeName(item.name, address), direction, at });
  }
  return result;
}

/**
 * Сворачивает наблюдения к одной строке на адрес.
 *
 * Нужно не для скорости, а по устройству Postgres: `INSERT ... ON CONFLICT
 * DO UPDATE` отказывается менять одну и ту же строку дважды в одном
 * запросе («cannot affect row a second time»). Порция из тысячи писем почти
 * наверняка содержит один адрес много раз — то есть без свёртки запись
 * падала бы на любом реальном ящике, но проходила бы на тестовом с тремя
 * письмами от разных людей.
 *
 * Имя берётся от САМОГО СВЕЖЕГО письма, а не от первого попавшегося: люди
 * меняют подпись и фамилию, и в подсказке должно стоять нынешнее имя.
 * Пустое имя свежего письма при этом не затирает известное («no-reply»
 * рассылки часто приходят вовсе без имени).
 */
export function foldObservations(list: readonly ContactObservation[]): FoldedContact[] {
  const byAddress = new Map<string, FoldedContact & { nameAt: number }>();
  for (const item of list) {
    const current = byAddress.get(item.address);
    if (!current) {
      byAddress.set(item.address, {
        address: item.address,
        name: item.name,
        sentDelta: item.direction === 'sent' ? 1 : 0,
        recvDelta: item.direction === 'received' ? 1 : 0,
        lastSeenAt: item.at,
        nameAt: item.name ? item.at.getTime() : Number.NEGATIVE_INFINITY,
      });
      continue;
    }
    if (item.direction === 'sent') current.sentDelta += 1;
    else current.recvDelta += 1;
    if (item.at.getTime() > current.lastSeenAt.getTime()) current.lastSeenAt = item.at;
    if (item.name && item.at.getTime() >= current.nameAt) {
      current.name = item.name;
      current.nameAt = item.at.getTime();
    }
  }
  return [...byAddress.values()].map(({ nameAt: _nameAt, ...rest }) => rest);
}
