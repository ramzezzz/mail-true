/**
 * Раздел «Сертификат»: блок «Автопродление».
 *
 * Проверки закрывают ровно те обещания, которыми этот блок может соврать:
 *
 *   1. Кнопки «Продлить сейчас» НЕТ, а вместо неё — команда и объяснение,
 *      почему кнопки быть не может. Кнопка, которая молча ничего не
 *      делает, хуже её отсутствия, и вернуть её однажды «для удобства»
 *      будет тем легче, чем меньше про это написано.
 *   2. Блок стоит ВЫШЕ формы «Поставить свой сертификат»: за форму
 *      берутся тогда, когда автопродление уже подвело.
 *   3. Незнакомый итог попытки показывается как есть, а не пропадает:
 *      хост и контейнер обновляются порознь.
 *   4. Тревога живёт не только здесь: «Наблюдение» получает ту же
 *      проверку с сервера, иначе раздел пришлось бы открывать нарочно.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attemptOutcome, attemptTone, attemptTrigger } from '../src/pages/TlsPage';

const file = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

const page = file('src/pages/TlsPage.tsx');

describe('кнопки «продлить сейчас» нет, и это объяснено', () => {
  it('в разделе не заводится ни одного вызова продления', () => {
    // Ни в клиенте API, ни на странице. Появись такой вызов — сервер
    // ответил бы 404, а человек ушёл бы уверенным, что продление пошло.
    const client = file('src/api/client.ts');
    expect(client).not.toMatch(/renewNow|\/tls\/renew/u);
    expect(page).not.toMatch(/renewNow/u);
  });

  it('причина названа: порт 80 хоста, скрипт на хосте, закрытый список посредника', () => {
    expect(page).toContain('80-й порт');
    expect(page).toContain('service-agent');
    expect(page).toContain('restart');
    expect(page).toContain('recreate');
  });

  it('вместо кнопки — команда для консоли, которую можно скопировать', () => {
    expect(page).toContain('CommandLine');
    expect(page).toContain('commands.renew');
    expect(page).toContain('commands.force');
    expect(page).toContain('commands.installTimer');
    expect(page).toContain('Копировать');
  });

  it('команды приходят с сервера, а не зашиты в интерфейс', () => {
    // Путь к скрипту знает сервер. Зашитая строка однажды разошлась бы с
    // настоящим расположением, и подсказка вела бы в никуда.
    expect(page).not.toContain("'sudo bash install/renew-certs.sh'");
  });
});

describe('место блока на странице', () => {
  it('автопродление показано выше формы «Поставить свой сертификат»', () => {
    const renewal = page.indexOf('<RenewalPanel');
    const form = page.indexOf('Поставить свой сертификат"');
    expect(renewal).toBeGreaterThan(0);
    expect(form).toBeGreaterThan(0);
    expect(renewal).toBeLessThan(form);
  });
});

describe('итоги попыток читаются человеком', () => {
  it('известные значения переведены', () => {
    expect(attemptOutcome('renewed')).toBe('продлён');
    expect(attemptOutcome('failed')).toBe('отказ');
    expect(attemptOutcome('skipped-custom')).toBe('пропущено: свой сертификат');
    expect(attemptTrigger('timer')).toBe('по таймеру');
    expect(attemptTrigger('manual')).toBe('вручную');
    expect(attemptTrigger('install')).toBe('при установке');
  });

  it('незнакомое значение показывается как есть, а не исчезает', () => {
    expect(attemptOutcome('что-то-новое')).toBe('что-то-новое');
    expect(attemptTrigger('cron')).toBe('cron');
  });

  it('отказ красный, намеренный пропуск — серый', () => {
    expect(attemptTone('failed')).toBe('fail');
    expect(attemptTone('skipped-custom')).toBe('muted');
    expect(attemptTone('renewed')).toBe('ok');
  });
});

describe('тревога уезжает в «Наблюдение», а не остаётся здесь', () => {
  it('сервер добавляет проверку автопродления к срокам сертификатов', () => {
    const monitoring = file('../api/src/admin/routes/monitoring.ts');
    expect(monitoring).toContain('renewalHealthCheck');
    expect(monitoring).toContain('certificateChecks.push');
  });
});
