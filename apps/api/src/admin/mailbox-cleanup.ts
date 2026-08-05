/**
 * Уборка почтового хранилища после удаления ящика.
 *
 * ЧТО БЫЛО. Удаление ящика убирало ровно одну строку — из virtual_users.
 * На диске оставался Maildir целиком (на стенде это 18 МБ на ящик),
 * оставались каталоги индексов Dovecot и сотни строк в служебных таблицах
 * переноса. Мусор копился: к моменту разбора на стенде лежало десять
 * осиротевших каталогов от прежних прогонов. Но хуже места на диске другое:
 * при повторном создании ящика с тем же адресом Dovecot открывал уцелевший
 * каталог, и новый владелец видел ЧУЖУЮ старую переписку.
 *
 * КАК СДЕЛАНО И ПОЧЕМУ ИМЕННО ТАК.
 *
 * Два очевидных пути — «удалять сразу в обработчике запроса» и «помечать
 * к удалению, убирать потом» — оба неполны, поэтому взяты обе половины:
 *
 *   1. Карантин — СРАЗУ и синхронно. Каталог ящика переименовывается
 *      в `<домен>/.deleted/<ящик>.<id>`. Переименование внутри одной
 *      файловой системы атомарно и не зависит от размера ящика, поэтому
 *      в обработчике запроса оно уместно. С этого мгновения по старому
 *      пути ничего нет: воскресший ящик с тем же адресом гарантированно
 *      пуст — а это и есть самое опасное последствие дефекта, и откладывать
 *      его устранение «на потом» нельзя.
 *
 *   2. Физическое удаление — фоновым уборщиком. `rm -rf` на 18 МБ внутри
 *      HTTP-запроса это ожидание на ровном месте, а на ящике в несколько
 *      гигабайт — ещё и таймаут nginx посреди удаления, после которого
 *      администратор не знает, удалилось ли. Уборщик же может позволить
 *      себе не спешить, повторить попытку и записать результат.
 *
 *   3. Строка в mailbox_deletions остаётся навсегда: это учётная запись
 *      о том, что было удалено, кем, когда и сколько места освободилось.
 *      Отсрочка настраивается (ADMIN_MAILBOX_PURGE_DELAY_MINUTES): нулевая
 *      означает «убрать при ближайшем проходе», ненулевая даёт время
 *      передумать. Доступ к почте отсрочка не возвращает — каталог уже
 *      в карантине.
 *
 * Индексы полнотекстового поиска лежат в отдельном томе Dovecot, куда у API
 * доступа нет и быть не должно. Поэтому перед удалением ящик очищается
 * средствами самого Dovecot (см. MailboxMasterAccess.purgeMail): удаление
 * папок и очистка INBOX убирают и индексы, и данные Xapian — это делает
 * тот, кому они принадлежат.
 */
import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Куда Dovecot кладёт почту: mail_location = maildir:/var/mail/vhosts/%d/%n */
export function maildirPathOf(root: string, email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  // Ни одна часть пути не должна уметь выйти за пределы корня: адрес
  // приходит из базы, но проверка стоит дёшево, а стоимость ошибки — rm -rf
  // не там, где надо.
  if (!isSafeSegment(local) || !isSafeSegment(domain)) return null;
  return path.posix.join(root, domain, local);
}

/** Имя каталога карантина внутри домена. Точка — чтобы Dovecot его не видел. */
export const QUARANTINE_DIR = '.deleted';

function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[/\\]/.test(value);
}

export interface QuarantineResult {
  /** Исходный путь каталога ящика. */
  maildirPath: string | null;
  /** Куда переименован каталог; null — каталога не было или не смогли. */
  quarantinePath: string | null;
  /** Каталог существовал до удаления. */
  existed: boolean;
  /** Почему не получилось (если не получилось). */
  error: string | null;
}

/**
 * Уводит каталог ящика из-под нового ящика с тем же адресом.
 * Ошибка не бросается: удаление ящика не должно падать из-за файловой
 * системы, но и молчать о неудаче нельзя — она возвращается наружу
 * и попадает в mailbox_deletions.error.
 */
export async function quarantineMaildir(
  root: string,
  email: string,
  tag: string,
): Promise<QuarantineResult> {
  const source = maildirPathOf(root, email);
  if (!source) {
    return {
      maildirPath: null,
      quarantinePath: null,
      existed: false,
      error: `Не удалось построить путь каталога для адреса «${email}»`,
    };
  }
  try {
    await access(source, constants.F_OK);
  } catch {
    // Каталога нет — ящик ни разу не открывали. Это нормальный случай.
    return { maildirPath: source, quarantinePath: null, existed: false, error: null };
  }

  const domainDir = path.posix.dirname(source);
  const base = path.posix.basename(source);
  const target = path.posix.join(domainDir, QUARANTINE_DIR, `${base}.${tag}`);
  try {
    await mkdir(path.posix.join(domainDir, QUARANTINE_DIR), { recursive: true });
    await rename(source, target);
    return { maildirPath: source, quarantinePath: target, existed: true, error: null };
  } catch (err) {
    return {
      maildirPath: source,
      quarantinePath: null,
      existed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Размер дерева каталогов в байтах. Ошибки чтения пропускаются. */
export async function treeSize(target: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          total += (await stat(full)).size;
        } catch {
          /* файл исчез между чтением каталога и stat — не беда */
        }
      }
    }
  };
  await walk(target);
  return total;
}

/** Удаляет дерево целиком. Возвращает освобождённые байты. */
export async function removeTree(target: string): Promise<number> {
  const bytes = await treeSize(target);
  await rm(target, { recursive: true, force: true });
  return bytes;
}

/**
 * Каталоги в хранилище, которым не соответствует ни один ящик из базы.
 *
 * Сами не удаляем: каталог мог появиться до появления админки или быть
 * заведён вручную, и молча стирать чужую почту недопустимо. Уборщик о них
 * пишет в журнал сервера, а решение принимает человек.
 */
export async function findOrphanMaildirs(
  root: string,
  knownEmails: readonly string[],
): Promise<string[]> {
  const known = new Set(knownEmails.map((e) => e.toLowerCase()));
  const orphans: string[] = [];
  let domains;
  try {
    domains = await readdir(root, { withFileTypes: true });
  } catch {
    return orphans;
  }
  for (const domain of domains) {
    if (!domain.isDirectory()) continue;
    let boxes;
    try {
      boxes = await readdir(path.posix.join(root, domain.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const box of boxes) {
      if (!box.isDirectory() || box.name === QUARANTINE_DIR) continue;
      const email = `${box.name}@${domain.name}`.toLowerCase();
      if (!known.has(email)) orphans.push(email);
    }
  }
  return orphans;
}
