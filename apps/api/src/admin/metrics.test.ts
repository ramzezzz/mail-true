/**
 * Показатели сервера: разбор /proc и cgroup, учёт места, сроки сертификатов.
 *
 * Проверяется не «читается ли файл», а то, из-за чего дашборд начал бы
 * врать, будучи при этом зелёным:
 *
 *   1. ЗАГРУЗКА ПРОЦЕССОРА — ЭТО РАЗНОСТЬ. Одного замера не хватает
 *      в принципе, и первый снимок обязан давать «не измеряли», а не ноль.
 *   2. iowait — ЭТО ПРОСТОЙ. Засчитав его в занятость, панель показала бы
 *      «процессор загружен на 90 %» на сервере, упёршемся в диск, и
 *      администратор пошёл бы менять не то железо.
 *   3. ПАМЯТЬ СЧИТАЕТСЯ ПО MemAvailable. По MemFree исправный сервер
 *      с горячим кэшем выглядит как сервер на грани нехватки памяти.
 *   4. ЗАНЯТОСТЬ ЯЩИКА — ЭТО СУММА ПРИРАЩЕНИЙ maildirsize, а не последняя
 *      строка файла. По последней строке ящик на гигабайт показывал бы
 *      «занято 240 байт», и близость к квоте не всплыла бы никогда.
 *   5. «max» В CGROUP ОЗНАЧАЕТ «ПРЕДЕЛА НЕТ», а не число.
 *
 * На старом коде падают все проверки этого файла: модулей metrics-* не
 * существовало, показателей сервера в админке не было вовсе.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  directorySize,
  parseMaildirsize,
  readMailboxDiskUsage,
  volumeUsage,
} from './metrics-disk.js';
import {
  cpuPercent,
  HostMetricsReader,
  parseCgroupCpuUsage,
  parseCgroupNumber,
  parseCpuMax,
  parseLoadavg,
  parseMeminfo,
  parseProcStat,
} from './metrics-host.js';
import { bucketSeconds, isUserTrafficSort, TARGET_POINTS } from './metrics-store.js';
import { describeCertificate, readCertificate } from './metrics-tls.js';

/* ------------------------------------------------------------------ */
/* Процессор                                                           */
/* ------------------------------------------------------------------ */

const STAT = [
  'cpu  735275 328 622148 236368458 160296 0 147771 0 0 0',
  'cpu0 20365 0 70850 7303543 5221 0 110646 0 0 0',
  'cpu1 20365 0 70850 7303543 5221 0 110646 0 0 0',
  'intr 12345',
].join('\n');

test('строка cpu разбирается, а iowait считается простоем', () => {
  const totals = parseProcStat(STAT);
  assert.ok(totals);
  // total — сумма всех полей; busy — всё, кроме idle (4-е) и iowait (5-е).
  const all = 735275 + 328 + 622148 + 236368458 + 160296 + 0 + 147771;
  assert.equal(totals.total, all);
  assert.equal(totals.busy, all - 236368458 - 160296);
});

test('ожидание диска не выдаётся за работу процессора', () => {
  // Тот же занятый объём, но простоя нет вовсе, а iowait огромный.
  const busyDisk = parseProcStat('cpu  100 0 0 0 900 0 0')!;
  const idle = parseProcStat('cpu  100 0 0 900 0 0 0')!;
  // Оба должны давать одинаковую занятость: iowait — это простой.
  assert.equal(busyDisk.busy, idle.busy);
  assert.equal(busyDisk.total, idle.total);
});

test('без строки cpu показателя нет, а не ноль', () => {
  assert.equal(parseProcStat('intr 1\nctxt 2'), null);
  assert.equal(parseProcStat(''), null);
});

test('загрузка процессора — это разность двух замеров', () => {
  const before = { total: 1000, busy: 200 };
  const after = { total: 2000, busy: 700 };
  // За отрезок прошло 1000 тактов, из них 500 заняты — половина.
  assert.equal(cpuPercent(before, after), 50);
});

test('поехавшие назад счётчики не дают отрицательной загрузки', () => {
  // Перезагрузка узла обнуляет счётчики. Отрицательная «загрузка» —
  // это ошибка, которую видно; тихий ноль — ошибка, которую не видно.
  assert.equal(cpuPercent({ total: 5000, busy: 3000 }, { total: 10, busy: 5 }), null);
});

test('два одинаковых замера не дают загрузки: делить не на что', () => {
  assert.equal(cpuPercent({ total: 1000, busy: 200 }, { total: 1000, busy: 200 }), null);
});

test('загрузка не выходит за 0..100 при округлении счётчиков', () => {
  const value = cpuPercent({ total: 0, busy: 0 }, { total: 100, busy: 120 });
  assert.ok(value === null || (value >= 0 && value <= 100));
});

/* ------------------------------------------------------------------ */
/* Память                                                              */
/* ------------------------------------------------------------------ */

test('память узла считается по MemAvailable, а не по MemFree', () => {
  const info = parseMeminfo(
    [
      'MemTotal:       32751720 kB',
      'MemFree:          301400 kB',
      'MemAvailable:   30444348 kB',
      'Buffers:           60272 kB',
      'Cached:          1061364 kB',
    ].join('\n'),
  );
  assert.ok(info);
  assert.equal(info.total, 32751720 * 1024);
  // По MemFree занятость вышла бы 99 %, по MemAvailable — 7 %.
  assert.equal(info.available, 30444348 * 1024);
});

test('ядро без MemAvailable не оставляет панель без числа', () => {
  const info = parseMeminfo(
    ['MemTotal: 1000 kB', 'MemFree: 100 kB', 'Buffers: 50 kB', 'Cached: 200 kB'].join('\n'),
  );
  assert.ok(info);
  assert.equal(info.available, 350 * 1024);
});

test('без MemTotal показателя нет', () => {
  assert.equal(parseMeminfo('MemFree: 100 kB'), null);
});

/* ------------------------------------------------------------------ */
/* cgroup                                                              */
/* ------------------------------------------------------------------ */

test('usage_usec читается из cpu.stat', () => {
  assert.equal(parseCgroupCpuUsage('usage_usec 2862331\nuser_usec 2165264'), 2862331);
  assert.equal(parseCgroupCpuUsage('nr_periods 0'), null);
});

test('«max» в cgroup означает «предела нет», а не число', () => {
  // Подставив сюда число, панель показала бы выдуманный предел памяти
  // и «занято 3 % от максимума», которого не существует.
  assert.equal(parseCgroupNumber('max\n'), null);
  assert.equal(parseCgroupNumber('146989056\n'), 146989056);
  assert.equal(parseCgroupNumber(''), null);
  assert.equal(parseCgroupNumber('мусор'), null);
});

test('cpu.max переводится в число ядер', () => {
  assert.equal(parseCpuMax('max 100000'), null);
  assert.equal(parseCpuMax('200000 100000'), 2);
  assert.equal(parseCpuMax('50000 100000'), 0.5);
  assert.equal(parseCpuMax('битая строка'), null);
});

test('средняя нагрузка читается тремя числами', () => {
  assert.deepEqual(parseLoadavg('0.56 0.50 0.48 1/982 103'), [0.56, 0.5, 0.48]);
  assert.equal(parseLoadavg('пусто'), null);
});

/* ------------------------------------------------------------------ */
/* Читатель показателей целиком                                        */
/* ------------------------------------------------------------------ */

async function fakeProc(): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-metrics-'));
  const files: Record<string, string> = {
    procStat: path.join(dir, 'stat'),
    meminfo: path.join(dir, 'meminfo'),
    loadavg: path.join(dir, 'loadavg'),
    cgCpuStat: path.join(dir, 'cpu.stat'),
    cgCpuMax: path.join(dir, 'cpu.max'),
    cgMemCurrent: path.join(dir, 'memory.current'),
    cgMemMax: path.join(dir, 'memory.max'),
  };
  await writeFile(files.procStat!, STAT);
  await writeFile(files.meminfo!, 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n');
  await writeFile(files.loadavg!, '0.56 0.50 0.48 1/982 103\n');
  await writeFile(files.cgCpuStat!, 'usage_usec 1000000\n');
  await writeFile(files.cgCpuMax!, 'max 100000\n');
  await writeFile(files.cgMemCurrent!, '146989056\n');
  await writeFile(files.cgMemMax!, 'max\n');
  return files;
}

test('первый снимок честно не даёт загрузки процессора', async () => {
  const files = await fakeProc();
  const reader = new HostMetricsReader(files);
  const first = await reader.read(1_000_000);
  assert.equal(first.cpuNodePercent.value, null);
  // И объясняет почему — иначе прочерк выглядит как поломка панели.
  assert.match(first.cpuNodePercent.source, /первый замер/u);
  assert.equal(first.cpuApiPercent.value, null);
});

test('второй снимок даёт загрузку, память и число ядер', async () => {
  const files = await fakeProc();
  const reader = new HostMetricsReader(files);
  await reader.read(1_000_000);
  // За секунду счётчики выросли: 400 занятых тактов из 1000 — 40 %.
  await writeFile(
    files.procStat!,
    ['cpu  735675 328 622148 236368858 160496 0 147771 0 0 0', 'cpu0 1', 'cpu1 1'].join('\n'),
  );
  // Контейнер за ту же секунду занял четверть ядра.
  await writeFile(files.cgCpuStat!, 'usage_usec 1250000\n');
  const second = await reader.read(1_001_000);
  assert.equal(second.cpuNodePercent.value, 40);
  assert.equal(second.cpuApiPercent.value, 25);
  assert.equal(second.cpuCount.value, 2);
  assert.equal(second.memNodeTotal.value, 1000 * 1024);
  // Занято = total − available.
  assert.equal(second.memNodeUsed.value, 600 * 1024);
  assert.equal(second.memApiBytes.value, 146989056);
  assert.equal(second.load1.value, 0.56);
});

test('простоявший без работы узел даёт «не измеряли», а не ноль процентов', async () => {
  // Счётчики /proc/stat не растут только тогда, когда ядро вообще не
  // тикало (остановленная виртуальная машина, подставленный файл).
  // Ноль занятости здесь означал бы «процессор простаивает», хотя на
  // самом деле измерения не было.
  const files = await fakeProc();
  const reader = new HostMetricsReader(files);
  await reader.read(1_000_000);
  const second = await reader.read(1_002_000);
  assert.equal(second.cpuNodePercent.value, null);
});

test('замеры вплотную друг к другу не выдают шум за загрузку', async () => {
  const files = await fakeProc();
  const reader = new HostMetricsReader(files);
  await reader.read(1_000_000);
  // Десять миллисекунд — деление на крошечную разность даёт шум.
  const tooSoon = await reader.read(1_000_010);
  assert.equal(tooSoon.cpuNodePercent.value, null);
});

test('отсутствующие файлы дают объяснение, а не падение', async () => {
  const reader = new HostMetricsReader({
    procStat: '/нет/такого/stat',
    meminfo: '/нет/такого/meminfo',
    loadavg: '/нет/такого/loadavg',
    cgCpuStat: '/нет/такого/cpu.stat',
    cgCpuMax: '/нет/такого/cpu.max',
    cgMemCurrent: '/нет/такого/memory.current',
    cgMemMax: '/нет/такого/memory.max',
  });
  const snapshot = await reader.read();
  assert.equal(snapshot.cpuNodePercent.value, null);
  assert.equal(snapshot.memNodeTotal.value, null);
  assert.ok(snapshot.unavailable.length >= 4);
  assert.ok(snapshot.unavailable.some((note) => note.includes('/proc/stat')));
});

test('про невидимые чужие службы сказано ВСЕГДА, а не только при отказе', async () => {
  // Иначе показанное читалось бы как «загрузка почтового сервера целиком»,
  // хотя это загрузка узла и одного контейнера из десяти.
  const files = await fakeProc();
  const snapshot = await new HostMetricsReader(files).read();
  const note = snapshot.unavailable.find((n) => n.includes('dovecot'));
  assert.ok(note, 'нет предупреждения о невидимых службах');
  assert.match(note, /сокет Docker/u);
  assert.match(note, /root/u);
});

/* ------------------------------------------------------------------ */
/* Учёт места в ящиках                                                 */
/* ------------------------------------------------------------------ */

test('занятость ящика — это СУММА приращений, а не последняя строка', () => {
  const usage = parseMaildirsize(
    ['1073741824S', '985355 656', '2310 1', '1157 1', '1346 1'].join('\n'),
  );
  assert.ok(usage);
  // По последней строке вышло бы 1346 байт вместо гигабайта занятого.
  assert.equal(usage.bytes, 985355 + 2310 + 1157 + 1346);
  assert.equal(usage.messages, 659);
  assert.equal(usage.limitBytes, 1073741824);
});

test('удаление письма записано отрицательным приращением и вычитается', () => {
  const usage = parseMaildirsize(['1073741824S', '0 0', '76 1', '-76 -1'].join('\n'));
  assert.ok(usage);
  assert.equal(usage.bytes, 0);
  assert.equal(usage.messages, 0);
});

test('рассогласованный учёт не даёт отрицательного размера', () => {
  // Так бывает после ручного удаления писем мимо Dovecot. «Меньше нуля
  // байт» не бывает, и на графике это была бы дыра.
  const usage = parseMaildirsize(['1000S', '-500 -1'].join('\n'));
  assert.ok(usage);
  assert.equal(usage.bytes, 0);
});

test('предел по числу писем тоже читается', () => {
  const usage = parseMaildirsize('1073741824S,1000C\n100 1\n');
  assert.equal(usage?.limitMessages, 1000);
});

test('пустой файл учёта не притворяется нулевой занятостью', () => {
  assert.equal(parseMaildirsize(''), null);
});

test('занятость всех ящиков собирается из каталога хранилища', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-vmail-'));
  await mkdir(path.join(root, 'mail.local', 'ivan'), { recursive: true });
  await mkdir(path.join(root, 'mail.local', 'petr'), { recursive: true });
  await mkdir(path.join(root, 'mail.local', 'nobody'), { recursive: true });
  await mkdir(path.join(root, 'mail.local', '.deleted-20260101-old'), { recursive: true });
  await writeFile(path.join(root, 'mail.local', 'ivan', 'maildirsize'), '1000S\n600 3\n');
  await writeFile(path.join(root, 'mail.local', 'petr', 'maildirsize'), '1000S\n100 1\n');
  await writeFile(
    path.join(root, 'mail.local', '.deleted-20260101-old', 'maildirsize'),
    '1000S\n999999 99\n',
  );

  const report = await readMailboxDiskUsage(root);
  assert.equal(report.available, true);
  assert.deepEqual(
    report.items.map((i) => i.email),
    ['ivan@mail.local', 'petr@mail.local'],
  );
  // Крупнейший первым: список читают сверху.
  assert.equal(report.items[0]!.bytes, 600);
  assert.equal(report.totalBytes, 700);
  // Ящик без файла учёта посчитан отдельно, а не как «занято 0»: разница
  // между «пустой» и «неизвестно» на дашборде принципиальная.
  assert.equal(report.withoutAccounting, 1);
  // Карантин удалённого ящика в сумму не входит: он уже ничей.
  assert.ok(!report.items.some((i) => i.email.includes('deleted')));
});

test('недоступный каталог писем объясняется словами', async () => {
  const report = await readMailboxDiskUsage('/нет/такого/каталога');
  assert.equal(report.available, false);
  assert.equal(report.totalBytes, 0);
  assert.match(report.note, /не читается/u);
});

test('размер каталога считается обходом и знает, дошёл ли он до конца', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-walk-'));
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await writeFile(path.join(root, 'a.bin'), Buffer.alloc(4096));
  await writeFile(path.join(root, 'sub', 'b.bin'), Buffer.alloc(4096));
  const size = await directorySize(root, 5000);
  assert.equal(size.complete, true);
  assert.equal(size.files, 2);
  assert.ok(size.bytes >= 8192);
});

test('нулевой запас времени даёт «не успели», а не половину как целое', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mt-walk2-'));
  await writeFile(path.join(root, 'a.bin'), Buffer.alloc(1024));
  const size = await directorySize(root, -1);
  assert.equal(size.complete, false);
});

test('несуществующий каталог не роняет обход', async () => {
  const size = await directorySize('/нет/такого/каталога', 1000);
  assert.equal(size.files, 0);
  assert.equal(size.complete, true);
});

test('statfs отвечает по существующему пути и молчит по выдуманному', async () => {
  const usage = await volumeUsage(tmpdir());
  assert.ok(usage);
  assert.ok(usage.totalBytes > 0);
  assert.ok(usage.freeBytes >= 0);
  assert.equal(await volumeUsage('/нет/такого/пути'), null);
});

/* ------------------------------------------------------------------ */
/* Корзины времени                                                     */
/* ------------------------------------------------------------------ */

test('шаг корзины держит число точек около сотни при любом окне', () => {
  for (const hours of [1, 6, 24, 24 * 7, 24 * 30]) {
    const seconds = hours * 3600;
    const points = seconds / bucketSeconds(seconds);
    assert.ok(
      points <= TARGET_POINTS + 1,
      `окно ${hours} ч даёт ${Math.round(points)} точек — линия из тысяч узлов`,
    );
  }
});

test('шаг корзины не мельче шага съёмки: усреднять неизмеренное бессмысленно', () => {
  assert.equal(bucketSeconds(600, 60), 60);
  assert.ok(bucketSeconds(3600, 300) >= 300);
});

test('чужое имя сортировки не подставляется в SQL', () => {
  // Имя колонки попадает в ORDER BY подстановкой, параметром его не
  // передать. Единственная защита — белый список.
  assert.equal(isUserTrafficSort('sentBytes'), true);
  assert.equal(isUserTrafficSort('email; DROP TABLE virtual_users'), false);
  assert.equal(isUserTrafficSort(undefined), false);
});

/* ------------------------------------------------------------------ */
/* Сертификаты                                                         */
/* ------------------------------------------------------------------ */

const TARGET = { title: 'Отправка (SMTPS)', host: 'postfix', port: 465 };

test('срок сертификата считается до истечения и округляется вниз', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const cert = describeCertificate(
    TARGET,
    {
      subject: { CN: 'mail.local' },
      issuer: { CN: 'Let’s Encrypt' },
      valid_from: 'Jul  1 00:00:00 2026 GMT',
      valid_to: 'Aug 20 20:00:00 2026 GMT',
      subjectaltname: 'DNS:mail.local, DNS:imap.mail.local',
    } as never,
    now,
  );
  // До истечения 14 суток и 20 часов. «Осталось 14», а не бодрое «15»:
  // округление вверх у сертификата — это лишние сутки уверенности,
  // которых нет.
  assert.equal(cert.daysLeft, 14);
  assert.equal(cert.selfSigned, false);
  assert.deepEqual(cert.names, ['mail.local', 'imap.mail.local']);
});

test('истёкший сертификат даёт отрицательный остаток, а не ноль', () => {
  const cert = describeCertificate(
    TARGET,
    { subject: { CN: 'a' }, issuer: { CN: 'b' }, valid_to: 'Aug  1 00:00:00 2026 GMT' } as never,
    Date.parse('2026-08-06T00:00:00Z'),
  );
  assert.equal(cert.daysLeft, -5);
});

test('самоподписанный сертификат опознаётся', () => {
  const cert = describeCertificate(TARGET, {
    subject: { CN: 'mail.local' },
    issuer: { CN: 'mail.local' },
    valid_to: '',
  } as never);
  assert.equal(cert.selfSigned, true);
  assert.equal(cert.validTo, null);
});

test('два поля CN не превращаются в «[object Array]»', () => {
  const cert = describeCertificate(TARGET, {
    subject: { CN: ['mail.local', 'second'] },
    issuer: { CN: 'CA' },
    valid_to: '',
  } as never);
  assert.equal(cert.subject, 'mail.local');
});

test('порт со STARTTLS не опрашивается: рукопожатие там висело бы до таймаута', async () => {
  const result = await readCertificate({
    title: 'Отправка (submission)',
    host: 'postfix',
    port: 587,
    implicitTls: false,
  });
  assert.equal(result.available, false);
  assert.match(result.error ?? '', /STARTTLS/u);
});

test('закрытый порт даёт объяснение, а не зависание', async () => {
  const result = await readCertificate(
    { title: 'Проверка', host: '127.0.0.1', port: 1, implicitTls: true },
    500,
  );
  assert.equal(result.available, false);
  assert.ok((result.error ?? '').length > 0);
  assert.equal(result.daysLeft, null);
});
