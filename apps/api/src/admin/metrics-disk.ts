/**
 * Место на диске в разрезе того, что важно почтовику.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ «ЗАНЯТО 60 ГБ» НЕ ГОДИТСЯ
 * ------------------------------------------------------------------
 * Общая цифра не отвечает ни на один вопрос, который возникает у человека,
 * увидевшего заполненный диск. Ему нужно знать, ЧТО именно съело место:
 * письма, база, поисковые индексы или журналы. Это четыре разных решения
 * (докупить том, почистить историю, перестроить индексы, укоротить срок
 * хранения журналов), и по одному числу выбрать между ними нельзя.
 *
 * ------------------------------------------------------------------
 * ОТКУДА БЕРЁТСЯ КАЖДОЕ ЧИСЛО
 * ------------------------------------------------------------------
 *   том целиком      — statfs по смонтированному пути (то же, что df);
 *   письма           — сумма учёта квоты Dovecot (файлы maildirsize);
 *   поисковые индексы — обход каталога /var/mail/index;
 *   журналы          — обход каталога /var/log/mail;
 *   база и её индексы — pg_database_size / pg_indexes_size (см. metrics-store).
 *
 * ПОЧЕМУ ПИСЬМА СЧИТАЮТСЯ ПО maildirsize, А НЕ ОБХОДОМ КАТАЛОГА.
 * Обход /var/mail/vhosts — это stat на каждое письмо. На ящике с сотней
 * тысяч писем это сотни тысяч обращений к диску РАДИ ОДНОГО ЧИСЛА, и делать
 * это раз в минуту нельзя: снятие показателей само станет нагрузкой, ради
 * измерения которой оно затевалось. Dovecot же ведёт учёт сам — в каждом
 * ящике лежит maildirsize, по которому он и применяет квоту. Один маленький
 * файл на ящик вместо обхода всего хранилища, и число ровно то, по которому
 * ящик будет отбит при переполнении, — то есть именно то, что нужно
 * администратору.
 *
 * Каталоги индексов и журналов обходятся честно: они на порядки меньше и
 * своего учёта не ведут. Обход ограничен временем — на непредвиденно
 * большом каталоге лучше сказать «не успели», чем задержать весь дашборд.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Очередь Postfix (/var/spool/postfix) в контейнер api не
 * смонтирована, и её объём на диске отсюда не виден. Число писем в очереди
 * и возраст самого старого берутся у посредника в контейнере postfix
 * (queue-agent.ts) — а вот занятые ею байты пришлось бы спрашивать у сокета
 * Docker, то есть покупать за права root на машине. Не покупаем и говорим
 * об этом на экране.
 */
import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/** Свободное и занятое на смонтированном томе. */
export interface VolumeUsage {
  path: string;
  /** Номер устройства: по нему видно, что «разные тома» на самом деле один. */
  device: number | null;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

/**
 * Занятость тома по statfs.
 *
 * Свободное берём из bavail (доступно обычному пользователю), а не bfree:
 * файловые системы держат резерв для root, и по bfree человек увидел бы
 * несколько процентов места, которых почтовому демону всё равно не дадут.
 * Занятое считаем как blocks − bfree, то есть настоящую занятость, — иначе
 * резерв root оказался бы записан в «занято» и цифры не сходились бы с df.
 */
export async function volumeUsage(path: string): Promise<VolumeUsage | null> {
  try {
    const fs = await statfs(path);
    const bsize = Number(fs.bsize);
    const total = Number(fs.blocks) * bsize;
    const free = Number(fs.bavail) * bsize;
    const used = (Number(fs.blocks) - Number(fs.bfree)) * bsize;
    let device: number | null = null;
    try {
      device = Number((await stat(path)).dev);
    } catch {
      device = null;
    }
    return { path, device, totalBytes: total, freeBytes: free, usedBytes: used };
  } catch {
    return null;
  }
}

/** Занятое и предел одного ящика по учёту Dovecot. */
export interface MaildirUsage {
  bytes: number;
  messages: number;
  /** Предел из первой строки файла; null — квота в maildirsize не записана. */
  limitBytes: number | null;
  limitMessages: number | null;
}

/**
 * Разбор maildirsize.
 *
 * Формат простой и оттого коварный: первая строка — ПРЕДЕЛЫ («1073741824S»
 * — байты, «1000C» — письма, через запятую), все последующие — приращения
 * вида «байты письма». Текущая занятость это СУММА приращений, а не
 * последняя строка: Dovecot дописывает строку на каждое изменение и
 * периодически схлопывает файл. Приращения бывают ОТРИЦАТЕЛЬНЫМИ — так
 * записывается удаление письма.
 *
 * Ошибочно взятая последняя строка давала бы «занято 240 байт» у ящика на
 * гигабайт, и близость к квоте не показалась бы никогда.
 */
export function parseMaildirsize(text: string): MaildirUsage | null {
  const lines = text.split('\n');
  if (lines.length === 0) return null;
  let limitBytes: number | null = null;
  let limitMessages: number | null = null;
  for (const part of (lines[0] ?? '').trim().split(',')) {
    const match = /^(\d+)([SC])$/u.exec(part.trim());
    if (!match) continue;
    if (match[2] === 'S') limitBytes = Number(match[1]);
    if (match[2] === 'C') limitMessages = Number(match[1]);
  }
  let bytes = 0;
  let messages = 0;
  let seen = false;
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 2) continue;
    const b = Number(parts[0]);
    const c = Number(parts[1]);
    if (!Number.isFinite(b) || !Number.isFinite(c)) continue;
    bytes += b;
    messages += c;
    seen = true;
  }
  if (!seen && limitBytes === null && limitMessages === null) return null;
  // Отрицательная сумма означает рассогласованный учёт (так бывает после
  // ручного удаления писем мимо Dovecot). Ноль честнее отрицательного
  // размера: «меньше нуля байт» не бывает, и на графике это была бы дыра.
  return {
    bytes: Math.max(0, bytes),
    messages: Math.max(0, messages),
    limitBytes,
    limitMessages,
  };
}

/** Занятость одного ящика с его адресом. */
export interface MailboxDiskUsage {
  email: string;
  bytes: number;
  messages: number;
  limitBytes: number | null;
}

export interface MailboxDiskReport {
  items: MailboxDiskUsage[];
  totalBytes: number;
  /** Сколько каталогов ящиков не имели maildirsize (учёт ещё не заведён). */
  withoutAccounting: number;
  /** Корень хранилища; пусто, если каталог недоступен вовсе. */
  root: string;
  available: boolean;
  note: string;
}

/**
 * Занятость всех ящиков по учёту Dovecot.
 *
 * Раскладка каталогов та же, что в mail_location Dovecot:
 * `/var/mail/vhosts/<домен>/<ящик>`. Ходим ровно на два уровня: глубже
 * лежат уже папки IMAP, и спускаться туда незачем.
 */
export async function readMailboxDiskUsage(root: string): Promise<MailboxDiskReport> {
  const empty = (note: string): MailboxDiskReport => ({
    items: [],
    totalBytes: 0,
    withoutAccounting: 0,
    root,
    available: false,
    note,
  });
  let domains: string[];
  try {
    domains = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return empty(
      `Каталог писем ${root} не читается из контейнера api — занятость ящиков не посчитать`,
    );
  }
  const items: MailboxDiskUsage[] = [];
  let withoutAccounting = 0;
  for (const domain of domains) {
    let boxes: string[];
    try {
      boxes = (await readdir(join(root, domain), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const box of boxes) {
      // Каталог, отправленный в карантин при удалении ящика, к живым
      // ящикам не относится: он уже не занят никем и скоро исчезнет.
      if (box.startsWith('.deleted-')) continue;
      let usage: MaildirUsage | null = null;
      try {
        usage = parseMaildirsize(await readFile(join(root, domain, box, 'maildirsize'), 'utf8'));
      } catch {
        usage = null;
      }
      if (!usage) {
        withoutAccounting += 1;
        continue;
      }
      items.push({
        email: `${box}@${domain}`,
        bytes: usage.bytes,
        messages: usage.messages,
        limitBytes: usage.limitBytes,
      });
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return {
    items,
    totalBytes: items.reduce((sum, i) => sum + i.bytes, 0),
    withoutAccounting,
    root,
    available: true,
    note:
      'Учёт квоты Dovecot (maildirsize). Ящик, в который ещё ни разу не клали письмо, ' +
      'файла учёта не имеет и в сумму не попадает',
  };
}

/** Результат обхода каталога. */
export interface DirectorySize {
  bytes: number;
  files: number;
  /** Обход дошёл до конца. false — упёрлись в отведённое время. */
  complete: boolean;
}

/**
 * Размер каталога обходом, с пределом по времени.
 *
 * Предел обязателен. Снятие показателей идёт по расписанию, и каталог,
 * который однажды вырастет до миллиона файлов, не должен превратить
 * сборщик в постоянно занятый процесс. Не успели — так и скажем
 * (`complete: false`), а не покажем половину как целое.
 *
 * Размер берём с диска (blocks × 512), а не st_size: разреженный или
 * маленький файл занимает целый блок, и по st_size сумма получается
 * заметно меньше того, что покажет df, — то есть две цифры на одном экране
 * противоречили бы друг другу.
 */
export async function directorySize(path: string, budgetMs = 3000): Promise<DirectorySize> {
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let files = 0;
  let complete = true;
  const stack: string[] = [path];
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      complete = false;
      break;
    }
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        bytes += Number(info.blocks) * 512;
        files += 1;
      } catch {
        /* файл исчез между чтением каталога и stat — обычное дело */
      }
    }
  }
  return { bytes, files, complete };
}
