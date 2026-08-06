/**
 * Расчёты нижней строки состояния (src/layout/FooterStatus.ts).
 *
 * На старом коде падает каждая проверка этого файла: ни строки состояния,
 * ни модуля расчётов не существовало вовсе (`import` не разрешается).
 *
 * Главное, что здесь проверяется, — отказ показывать неизвестное. Сервер
 * отдаёт `quotaLimitBytes: 0`, когда плагин quota в Dovecot выключен, и
 * «занято 0 из 0» было бы не пустяком, а прямой неправдой о ящике.
 */

import { describe, expect, it } from 'vitest';
import {
  JUST_NOW_MS,
  countsText,
  folderIdFromPath,
  formatBytes,
  SILENCE_MS,
  isSilent,
  isUnreachableError,
  mailStatus,
  nextTickDelay,
  plural,
  quotaView,
  resolveLink,
  updatedText,
  type QuerySnapshot,
} from '../src/layout/FooterStatus';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('занятое место', () => {
  it('единицы и разделитель русские, дробь — только когда что-то добавляет', () => {
    expect(formatBytes(27_648)).toBe('27 КБ');
    expect(formatBytes(1024 ** 3)).toBe('1 ГБ');
    expect(formatBytes(3.24 * 1024 ** 3)).toBe('3,2 ГБ');
    // Больше десяти единиц дробь не читается
    expect(formatBytes(15.7 * 1024 ** 3)).toBe('16 ГБ');
    expect(formatBytes(400 * 1024 ** 2)).toBe('400 МБ');
    expect(formatBytes(512)).toBe('512 Б');
  });

  it('формулировка как в карточке хранилища mail.ru', () => {
    // «Занято 400 МБ из 8 ГБ» — research/mailru/04-settings.png
    const view = quotaView(400 * 1024 ** 2, 8 * 1024 ** 3);
    expect(view?.text).toBe('Занято 400 МБ из 8 ГБ');
  });

  it('без предела квоты не показывается НИЧЕГО, а не «0 из 0»', () => {
    // Ровно то, что отдаёт GET /api/account без плагина quota в Dovecot
    expect(quotaView(0, 0)).toBeNull();
    expect(quotaView(1024, 0)).toBeNull();
    expect(quotaView(1024, -1)).toBeNull();
    expect(quotaView(1024, Number.NaN)).toBeNull();
  });

  it('доля не выходит за единицу, порог «место кончается» — девять десятых', () => {
    expect(quotaView(1024, 1024)?.fraction).toBe(1);
    expect(quotaView(2048, 1024)?.fraction).toBe(1);
    expect(quotaView(89, 100)?.nearlyFull).toBe(false);
    expect(quotaView(90, 100)?.nearlyFull).toBe(true);
  });
});

describe('счётчики папки', () => {
  it('склонения русские', () => {
    expect(countsText({ totalCount: 1, unreadCount: 0 })).toBe('1 письмо');
    expect(countsText({ totalCount: 2, unreadCount: 0 })).toBe('2 письма');
    expect(countsText({ totalCount: 9, unreadCount: 0 })).toBe('9 писем');
    expect(countsText({ totalCount: 11, unreadCount: 0 })).toBe('11 писем');
    expect(countsText({ totalCount: 21, unreadCount: 0 })).toBe('21 письмо');
    expect(plural(1, ['минуту', 'минуты', 'минут'])).toBe('минуту');
    expect(plural(3, ['минуту', 'минуты', 'минут'])).toBe('минуты');
    expect(plural(14, ['минуту', 'минуты', 'минут'])).toBe('минут');
  });

  it('непрочитанные упоминаются, только когда они есть', () => {
    expect(countsText({ totalCount: 9, unreadCount: 7 })).toBe('9 писем, 7 непрочитанных');
    expect(countsText({ totalCount: 9, unreadCount: 1 })).toBe('9 писем, 1 непрочитанное');
    // «0 непрочитанных» — шум, а не сведения
    expect(countsText({ totalCount: 9, unreadCount: 0 })).toBe('9 писем');
  });

  it('неизвестная папка не даёт выдуманного нуля', () => {
    expect(countsText(undefined)).toBeNull();
  });

  it('папка берётся из адреса, а постоянные адреса папками не считаются', () => {
    expect(folderIdFromPath('/inbox/')).toBe('inbox');
    expect(folderIdFromPath('/inbox/12345')).toBe('inbox');
    expect(folderIdFromPath('/custom-7/')).toBe('custom-7');
    expect(folderIdFromPath('/search/')).toBeNull();
    expect(folderIdFromPath('/compose')).toBeNull();
    expect(folderIdFromPath('/settings/general')).toBeNull();
    expect(folderIdFromPath('/')).toBeNull();
  });
});

describe('состояние связи', () => {
  const snapshot = (over: Partial<QuerySnapshot>): QuerySnapshot => ({
    key: ['folders'],
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    error: null,
    hasData: false,
    failureCount: 0,
    failureReason: null,
    ...over,
  });

  it('ответ сервера «нельзя» — это не потеря связи', () => {
    // 4xx значит, что сервер ЖИВ и ответил. Красить строку в «нет связи»
    // из-за чужого письма или истёкшей сессии было бы враньём.
    expect(isUnreachableError({ status: 401 })).toBe(false);
    expect(isUnreachableError({ status: 404 })).toBe(false);
    expect(isUnreachableError({ status: 429 })).toBe(false);
    // 502/503/504 отдаёт nginx, когда контейнер api остановлен
    expect(isUnreachableError({ status: 502 })).toBe(true);
    expect(isUnreachableError({ status: 503 })).toBe(true);
    // fetch бросает TypeError, когда соединения не случилось вовсе
    expect(isUnreachableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnreachableError(null)).toBe(false);
  });

  it('свежесть — время последнего УДАВШЕГОСЯ ответа по почтовым запросам', () => {
    const status = mailStatus(
      [
        snapshot({ key: ['folders'], dataUpdatedAt: 1000, hasData: true }),
        snapshot({ key: ['messages', 'list', 'inbox'], dataUpdatedAt: 5000, hasData: true }),
        // Чужие запросы на свежесть почты не влияют
        snapshot({ key: ['ai', 'state'], dataUpdatedAt: 9000, hasData: true }),
      ],
      true,
    );
    expect(status.updatedAt).toBe(5000);
    expect(status.link).toBe('ok');
  });

  it('ни одного ответа — обновляться нечему, времени нет', () => {
    expect(mailStatus([], true).updatedAt).toBeNull();
    expect(
      mailStatus([snapshot({ dataUpdatedAt: 7000, hasData: false })], true).updatedAt,
    ).toBeNull();
  });

  it('сравниваются времена, а не флаги: удача после отказа снимает тревогу', () => {
    const failed = mailStatus(
      [
        snapshot({ key: ['folders'], dataUpdatedAt: 1000, hasData: true }),
        snapshot({ key: ['folders'], errorUpdatedAt: 2000, error: { status: 502 } }),
      ],
      true,
    );
    expect(failed.link).toBe('unreachable');

    const recovered = mailStatus(
      [
        snapshot({ key: ['folders'], dataUpdatedAt: 3000, hasData: true }),
        snapshot({ key: ['folders'], errorUpdatedAt: 2000, error: { status: 502 } }),
      ],
      true,
    );
    expect(recovered.link).toBe('ok');
    expect(recovered.updatedAt).toBe(3000);
  });

  it('о неудавшейся попытке говорим сразу, не дожидаясь конца повторов', () => {
    /*
     * Найдено на живом стенде. Контейнер api остановлен, nginx отвечает
     * 502 — а react-query держит запрос «идущим» и не оседает в ошибку:
     * ни errorUpdatedAt, ни error не появляются. Двадцать четыре секунды
     * строка писала «Обновление…», то есть то же самое, что и при
     * исправном сервере. Признак неудавшейся попытки виден сразу.
     */
    const status = mailStatus(
      [
        snapshot({
          key: ['folders'],
          dataUpdatedAt: 1000,
          hasData: true,
          // ошибка ещё НЕ осела: errorUpdatedAt = 0, error = null
          failureCount: 1,
          failureReason: { status: 502 },
        }),
      ],
      true,
    );
    expect(status.link).toBe('unreachable');
    // Возраст данных при этом остаётся известным — он и нужен человеку
    expect(status.updatedAt).toBe(1000);
  });

  it('неудавшаяся попытка с ответом сервера тревоги не поднимает', () => {
    const status = mailStatus(
      [
        snapshot({
          key: ['messages'],
          dataUpdatedAt: 1000,
          hasData: true,
          failureCount: 1,
          failureReason: { status: 404 },
        }),
      ],
      true,
    );
    expect(status.link).toBe('ok');
  });

  it('успех обнуляет счётчик попыток — тревога снимается сама', () => {
    const status = mailStatus(
      [
        snapshot({
          key: ['folders'],
          dataUpdatedAt: 5000,
          hasData: true,
          failureCount: 0,
          failureReason: { status: 502 },
        }),
      ],
      true,
    );
    expect(status.link).toBe('ok');
  });

  it('истёкшая сессия не выдаётся за потерю связи', () => {
    const status = mailStatus(
      [
        snapshot({ key: ['folders'], dataUpdatedAt: 1000, hasData: true }),
        snapshot({ key: ['messages'], errorUpdatedAt: 2000, error: { status: 401 } }),
      ],
      true,
    );
    expect(status.link).toBe('ok');
  });

  it('молчание сервера — тоже отказ, даже когда ошибки нет вовсе', () => {
    /*
     * Проверено на живом стенде: при остановленном контейнере api запрос
     * из браузера НЕ ОТКАЗЫВАЕТ, а висит. `fetch('/api/folders')` не
     * разрешился и не отверг обещание за восемь секунд; состояние запроса
     * в react-query осталось нетронутым (fetchStatus "fetching",
     * fetchFailureCount 0, error null) двадцать четыре секунды и дальше.
     * Показ состояния связи не имеет права зависеть от отказов: их может
     * не быть.
     */
    expect(isSilent(null, 1_000_000)).toBe(false);
    expect(isSilent(1000, 1000 + SILENCE_MS - 1)).toBe(false);
    expect(isSilent(1000, 1000 + SILENCE_MS)).toBe(true);

    // Молчание превращает благополучное состояние в отказ
    expect(resolveLink('ok', true)).toBe('unreachable');
    expect(resolveLink('ok', false)).toBe('ok');
    // Уже известная причина точнее молчания и не подменяется им
    expect(resolveLink('offline', true)).toBe('offline');
    expect(resolveLink('unreachable', false)).toBe('unreachable');
  });

  it('порог молчания с запасом к настоящему долгому ответу', () => {
    // Меньше — пугали бы людей на медленной сети; больше — человек успел
    // бы решить, что сломан интерфейс
    expect(SILENCE_MS).toBeGreaterThanOrEqual(8_000);
    expect(SILENCE_MS).toBeLessThanOrEqual(20_000);
  });

  it('выключенная сеть важнее наших догадок о сервере', () => {
    const status = mailStatus(
      [snapshot({ key: ['folders'], errorUpdatedAt: 2000, error: { status: 502 } })],
      false,
    );
    expect(status.link).toBe('offline');
  });
});

describe('«обновлено N назад»', () => {
  const at = (age: number): string => updatedText(0, age);

  it('пороги подписей', () => {
    expect(at(0)).toBe('Обновлено только что');
    expect(at(JUST_NOW_MS - 1)).toBe('Обновлено только что');
    expect(at(JUST_NOW_MS)).toBe('Обновлено минуту назад');
    expect(at(2 * MINUTE)).toBe('Обновлено 2 минуты назад');
    expect(at(7 * MINUTE)).toBe('Обновлено 7 минут назад');
    expect(at(21 * MINUTE)).toBe('Обновлено 21 минуту назад');
    // Округление к ближайшему подписало бы полчаса как «60 минут назад»
    expect(at(59 * MINUTE + 59 * SECOND)).toBe('Обновлено 59 минут назад');
    expect(at(HOUR)).toBe('Обновлено 1 час назад');
    expect(at(5 * HOUR)).toBe('Обновлено 5 часов назад');
  });

  it('дальше суток — дата, а не «37 часов назад»', () => {
    const text = updatedText(Date.UTC(2026, 6, 15, 12, 0), Date.UTC(2026, 6, 18, 12, 0));
    expect(text).toMatch(/^Обновлено \d+ [а-я]+ в \d{2}:\d{2}$/u);
    expect(text).not.toMatch(/назад/u);
  });

  it('время из будущего не даёт отрицательного возраста', () => {
    expect(updatedText(5000, 0)).toBe('Обновлено только что');
  });
});

describe('будильник подписи времени', () => {
  /*
   * Ради этого и заведён nextTickDelay. Перерисовывать раз в секунду —
   * 3600 пробуждений в час ради подписи, меняющейся 60 раз. Здесь
   * проверяется, что будильник заводится РОВНО на ближайшую границу.
   */
  it('спит до мига, когда подпись станет другой', () => {
    expect(nextTickDelay(0)).toBe(JUST_NOW_MS);
    expect(nextTickDelay(JUST_NOW_MS - SECOND)).toBe(SECOND);
    expect(nextTickDelay(JUST_NOW_MS)).toBe(2 * MINUTE - JUST_NOW_MS);
    expect(nextTickDelay(2 * MINUTE)).toBe(MINUTE);
    expect(nextTickDelay(2 * MINUTE + 20 * SECOND)).toBe(40 * SECOND);
    expect(nextTickDelay(HOUR)).toBe(HOUR);
    expect(nextTickDelay(HOUR + 10 * MINUTE)).toBe(50 * MINUTE);
    // Дальше суток показывается дата — просыпаться часто незачем
    expect(nextTickDelay(30 * HOUR)).toBe(HOUR);
  });

  it('в каждом пробуждении есть смысл: подпись после него другая', () => {
    // Перебор по возрастам: после сна ровно до границы текст обязан смениться
    for (const age of [0, 10 * SECOND, JUST_NOW_MS, 3 * MINUTE, 40 * MINUTE, 3 * HOUR]) {
      const delay = nextTickDelay(age);
      expect(delay, `возраст ${age}: пробуждение без нужды`).toBeGreaterThan(0);
      expect(updatedText(0, age + delay), `возраст ${age}`).not.toBe(updatedText(0, age));
      // И до границы текст ещё прежний — значит, спали не слишком мало
      expect(updatedText(0, age + delay - 1), `возраст ${age}`).toBe(updatedText(0, age));
    }
  });
});
