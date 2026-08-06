/**
 * Перенос почты с чужого сервера: разбор списка ящиков и хранение паролей.
 *
 * Здесь только то, что можно проверить без сети и без базы: разбор списка,
 * упаковка секретов и сборка заданий для packages/migrate. Сам перенос —
 * в migrate-runner.ts, логика переноса — в packages/migrate (её тут никто
 * не повторяет).
 *
 * ------------------------------------------------------------------
 * РЕШЕНИЕ ПО ПАРОЛЯМ — главное в этом файле.
 *
 * Задача противоречивая: пароль исходного ящика нужен серверу ВСЁ время
 * переноса (часами, с переподключениями после обрывов, в том числе ночью,
 * когда спросить не у кого), но храниться дольше задания он не должен.
 *
 * Решение из трёх частей.
 *
 * 1. Пароли ПРИЁМНИКА не спрашиваются вообще. У нас в Dovecot есть
 *    служебный пользователь (DOVECOT_MASTER_USER), которым панель и так
 *    входит в чужие ящики. Перенос входит им же. Ни один пароль наших
 *    ящиков не вводится, не передаётся и не хранится — их просто нет
 *    в обороте. Это половина всех паролей, которых требовал перенос
 *    из командной строки.
 *
 * 2. Для ИСТОЧНИКА основной режим — тоже служебный доступ. Kerio Connect,
 *    Zimbra, Dovecot, Exchange умеют вход в чужой ящик по служебному
 *    паролю. Тогда на весь перенос — ОДИН секрет вместо сотни. Режим
 *    «пароль каждого ящика» остаётся для серверов без такого доступа.
 *
 * 3. То, что всё-таки нужно хранить, лежит одним зашифрованным свёртком
 *    (SecretBox из src/crypto.ts — тот же, которым зашифрован пароль
 *    в почтовой сессии и в очереди отложенной отправки; ключ выводится
 *    из ADMIN_SESSION_SECRET/SESSION_SECRET и в базе не лежит). Свёрток
 *    стирается той же командой, которая переводит задание в конечное
 *    состояние, — то есть пароль исчезает вместе с заданием, а не «когда
 *    дойдут руки».
 *
 * Наружу пароли не отдаются ни в каком виде: в ответах API их нет ни
 * открытыми, ни шифротекстом (шифротекст — тоже утечка: его можно унести
 * и ждать компрометации ключа). В журнал аудита уходят только числа.
 */

import {
  parseCsvWithHeader,
  parseKerioUsersCsv,
  parseKerioUsersCfg,
  type ImapEndpoint,
} from '@mail-true/migrate';
import { SecretBox } from '../crypto.js';

/* ------------------------------------------------------------------ */
/*  Секреты задания                                                    */
/* ------------------------------------------------------------------ */

/**
 * Всё, что задание обязано помнить и чего не должно быть видно.
 *
 * Ровно один из двух путей:
 *   masterPassword — служебный доступ, один пароль на весь перенос;
 *   mailboxPasswords — пароль каждого ящика по его номеру в задании.
 */
export interface MigrationSecrets {
  /** Пароль служебного пользователя источника. */
  masterPassword?: string;
  /** Пароли ящиков источника: номер строки задания → пароль. */
  mailboxPasswords?: Record<string, string>;
}

/** Шифрует свёрток секретов. null — секретов нет (служебный доступ без пароля не бывает). */
export function packSecrets(box: SecretBox, secrets: MigrationSecrets): string {
  return box.encrypt(JSON.stringify(secrets));
}

/**
 * Разбирает свёрток обратно.
 *
 * null означает «пароля больше нет»: свёрток стёрт по завершении задания
 * или ключ сменился. Это не авария — работник обязан сказать словами, что
 * продолжить нельзя, а не упасть.
 */
export function unpackSecrets(box: SecretBox, boxed: string | null): MigrationSecrets | null {
  if (boxed === null || boxed === '') return null;
  try {
    const parsed = JSON.parse(box.decrypt(boxed)) as MigrationSecrets;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Разбор списка ящиков                                               */
/* ------------------------------------------------------------------ */

/** Одна строка списка переноса. */
export interface MigrationRow {
  /** Ящик (или логин) на исходном сервере. */
  sourceUser: string;
  /** Ящик у нас. */
  destUser: string;
  /**
   * Пароль исходного ящика из выгрузки. Существует ТОЛЬКО в памяти между
   * разбором и шифрованием: ни в предпросмотр, ни в ответ API не попадает
   * (см. rowsForApi).
   */
  password?: string;
}

/** Итог разбора списка. */
export interface MigrationListParse {
  format: 'kerio-csv' | 'kerio-cfg' | 'pairs-csv' | 'plain';
  rows: MigrationRow[];
  /** Строки, которые пришлось отбросить, и почему. */
  problems: string[];
  /** Сколько строк принесли пароль (число, а не сами пароли). */
  withPassword: number;
}

/** Похоже ли на XML users.cfg из каталога данных Kerio. */
function looksLikeKerioCfg(text: string): boolean {
  return /<list\b/i.test(text) && /<variable\s+name=/i.test(text);
}

/** Дополнить адрес доменом, если домена нет. Уже написанный домен не трогаем. */
function withDomain(address: string, domain: string): string {
  const trimmed = address.trim();
  if (trimmed === '' || domain === '') return trimmed;
  return trimmed.includes('@') ? trimmed : `${trimmed}@${domain}`;
}

/**
 * Адрес у НАС, когда правая половина пары не задана явно.
 *
 * Переезд почти всегда меняет домен: ящики уезжают со staraya.ru на
 * novaya.ru. Если просто оставить исходный адрес, задание попыталось бы
 * писать в несуществующий ivan@staraya.ru и отказало бы на каждом ящике.
 * Поэтому при заданном домене приёмника берётся местная часть адреса,
 * а домен подставляется наш. Домен не задан — адрес остаётся прежним
 * (перенос внутрь того же домена, например при смене сервера).
 */
function destAddress(sourceAddress: string, destDomain: string): string {
  const trimmed = sourceAddress.trim();
  if (trimmed === '') return trimmed;
  if (destDomain === '') return trimmed;
  const at = trimmed.lastIndexOf('@');
  const local = at === -1 ? trimmed : trimmed.slice(0, at);
  return `${local}@${destDomain}`;
}

/**
 * Разобрать список ящиков для переноса.
 *
 * Форматы намеренно три, и все три взяты из жизни:
 *
 *  - выгрузка Kerio Connect (CSV или users.cfg) — то, что администратор
 *    получает на исходном сервере одной кнопкой, вместе с паролями;
 *  - CSV с парами «откуда → куда» — когда адреса при переезде меняются
 *    (ivan@staraya.ru → i.petrov@novaya.ru), а такое бывает почти всегда;
 *  - просто список адресов — самый частый случай при служебном доступе:
 *    адреса не меняются, пароли не нужны, и требовать ради этого CSV
 *    с двумя одинаковыми колонками было бы издевательством.
 *
 * @param sourceDomain домен исходного сервера — для логинов без «@»
 * @param destDomain   наш домен — для правой части без «@»
 */
export function parseMigrationList(
  text: string,
  options: { sourceDomain?: string; destDomain?: string } = {},
): MigrationListParse {
  const sourceDomain = options.sourceDomain?.trim() ?? '';
  const destDomain = options.destDomain?.trim() ?? '';
  const problems: string[] = [];
  const rows: MigrationRow[] = [];
  const trimmed = text.trim();

  if (trimmed === '') return { format: 'plain', rows, problems, withPassword: 0 };

  // 1. users.cfg (XML)
  if (looksLikeKerioCfg(trimmed)) {
    for (const user of parseKerioUsersCfg(trimmed)) {
      const source = withDomain(user.email ?? user.login, sourceDomain);
      if (source === '') continue;
      rows.push({
        sourceUser: source,
        destUser: destAddress(source, destDomain),
        ...(user.password !== null && user.password !== '' ? { password: user.password } : {}),
      });
    }
    return finish('kerio-cfg', rows, problems);
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  const hasHeader = /[,;]/.test(firstLine);

  // 2. CSV. Какой именно — решает заголовок.
  if (hasHeader) {
    const header = firstLine.toLowerCase();
    const isPairs = /source_user|source|откуда|from/.test(header) && !/mailaddress/.test(header);

    if (isPairs) {
      let parsed: Array<Record<string, string>>;
      try {
        parsed = parseCsvWithHeader(trimmed);
      } catch (err) {
        problems.push(
          `Не удалось разобрать CSV: ${err instanceof Error ? err.message : String(err)}`,
        );
        return finish('pairs-csv', rows, problems);
      }
      parsed.forEach((row, index) => {
        const source = row['source_user'] ?? row['source'] ?? row['откуда'] ?? row['from'] ?? '';
        const dest = row['dest_user'] ?? row['dest'] ?? row['куда'] ?? row['to'] ?? '';
        const password = row['source_pass'] ?? row['password'] ?? row['пароль'] ?? '';
        if (source.trim() === '') {
          problems.push(`строка ${String(index + 2)}: пустой адрес источника — пропущена`);
          return;
        }
        const sourceUser = withDomain(source, sourceDomain);
        rows.push({
          sourceUser,
          // Пустая правая колонка — «тот же адрес»: при переезде домена
          // целиком заполнять её вручную для каждой строки бессмысленно.
          destUser:
            dest.trim() === '' ? destAddress(sourceUser, destDomain) : withDomain(dest, destDomain),
          ...(password.trim() !== '' ? { password } : {}),
        });
      });
      return finish('pairs-csv', rows, problems);
    }

    // 3. Выгрузка Kerio Connect
    try {
      for (const user of parseKerioUsersCsv(trimmed)) {
        const address = user.email ?? user.login;
        if (address.trim() === '') continue;
        const sourceUser = withDomain(address, sourceDomain);
        rows.push({
          sourceUser,
          destUser: destAddress(sourceUser, destDomain),
          ...(user.password !== null && user.password !== '' ? { password: user.password } : {}),
        });
      }
      return finish('kerio-csv', rows, problems);
    } catch (err) {
      problems.push(
        `Не удалось разобрать выгрузку Kerio: ${err instanceof Error ? err.message : String(err)}`,
      );
      return finish('kerio-csv', rows, problems);
    }
  }

  // 4. Просто список адресов. Допускается «откуда -> куда» в строке:
  //    так пары пишут руками, когда их пять штук и заводить CSV незачем.
  for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
    const value = line.trim();
    if (value === '' || value.startsWith('#')) continue;
    const arrow = /\s*(?:->|→|=>)\s*/.exec(value);
    if (arrow) {
      const left = value.slice(0, arrow.index);
      const right = value.slice(arrow.index + arrow[0].length);
      if (left.trim() === '' || right.trim() === '') {
        problems.push(`строка ${String(index + 1)}: половина пары пуста — пропущена`);
        continue;
      }
      rows.push({
        sourceUser: withDomain(left, sourceDomain),
        destUser: withDomain(right, destDomain),
      });
      continue;
    }
    const sourceUser = withDomain(value, sourceDomain);
    rows.push({ sourceUser, destUser: destAddress(sourceUser, destDomain) });
  }
  return finish('plain', rows, problems);
}

/** Убрать повторы и посчитать пароли. Повторный ящик — это двойной перенос. */
function finish(
  format: MigrationListParse['format'],
  rows: MigrationRow[],
  problems: string[],
): MigrationListParse {
  const seen = new Set<string>();
  const unique: MigrationRow[] = [];
  for (const row of rows) {
    const key = `${row.sourceUser.toLowerCase()} -> ${row.destUser.toLowerCase()}`;
    if (seen.has(key)) {
      problems.push(`${row.sourceUser} → ${row.destUser}: повтор в списке, оставлена одна строка`);
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return {
    format,
    rows: unique,
    problems,
    withPassword: unique.filter((r) => r.password !== undefined).length,
  };
}

/**
 * Что из разобранного списка можно показывать.
 *
 * Отдельная функция, а не «не забыть удалить поле в маршруте»: забыть
 * можно ровно один раз, и тогда пароли всех сотрудников уедут в браузер
 * и в журнал прокси. Поле password здесь ОТСУТСТВУЕТ, а не пустое, —
 * пустая строка в ответе выглядела бы как «пароля не было».
 */
export function rowsForApi(rows: readonly MigrationRow[]): Array<{
  sourceUser: string;
  destUser: string;
  hasPassword: boolean;
}> {
  return rows.map((r) => ({
    sourceUser: r.sourceUser,
    destUser: r.destUser,
    hasPassword: r.password !== undefined,
  }));
}

/* ------------------------------------------------------------------ */
/*  Сборка подключений                                                 */
/* ------------------------------------------------------------------ */

/** Настройки исходного сервера без секретов (то, что лежит в строке задания). */
export interface SourceSettings {
  host: string;
  port: number;
  secure: boolean;
  allowInsecureTls: boolean;
  masterUser: string | null;
  masterSeparator: string | null;
}

/** Служебный доступ к НАШЕМУ серверу — пароли ящиков-приёмников не нужны вовсе. */
export interface DestSettings {
  host: string;
  port: number;
  secure: boolean;
  allowInsecureTls: boolean;
  masterUser: string;
  masterPassword: string;
  masterSeparator: string;
}

/**
 * Подключение к исходному ящику.
 *
 * @returns null, если пароля для этого ящика нет: продолжать нельзя, и
 *          отчёт должен сказать про пароль, а не выдать отказ IMAP.
 */
export function sourceEndpointFor(
  settings: SourceSettings,
  secrets: MigrationSecrets,
  row: { sourceUser: string; position: number },
): ImapEndpoint | null {
  const master = settings.masterUser ?? '';
  const pass =
    master !== ''
      ? (secrets.masterPassword ?? '')
      : (secrets.mailboxPasswords?.[String(row.position)] ?? '');
  if (pass === '') return null;
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: row.sourceUser,
    pass,
    ...(master !== '' ? { masterUser: master } : {}),
    ...(master !== '' && settings.masterSeparator
      ? { masterSeparator: settings.masterSeparator }
      : {}),
    ...(settings.allowInsecureTls ? { allowInsecureTls: true } : {}),
  };
}

/**
 * Подключение к ящику-приёмнику — всегда служебным доступом.
 *
 * Пароля владельца здесь нет и быть не может: панель его не знает (в базе
 * лежит хэш) и знать не должна. Служебный доступ тем и хорош, что не
 * требует менять пароль ящика ради переноса — иначе владелец в понедельник
 * обнаружил бы, что не может войти в почту.
 */
export function destEndpointFor(settings: DestSettings, destUser: string): ImapEndpoint {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: destUser,
    pass: settings.masterPassword,
    masterUser: settings.masterUser,
    masterSeparator: settings.masterSeparator,
    ...(settings.allowInsecureTls ? { allowInsecureTls: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Состояние ящика-приёмника                                          */
/* ------------------------------------------------------------------ */

/** Что известно о ящике-приёмнике на нашей стороне. */
export interface DestMailboxState {
  /** Ящика нет в базе вовсе (или его удалили после начала задания). */
  exists: boolean;
  /** Включён ли ящик. Осмысленно только при exists. */
  active: boolean;
}

/**
 * Почему в этот ящик нельзя писать. null — можно.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТОТ ТЕКСТ ВООБЩЕ СУЩЕСТВУЕТ
 * ------------------------------------------------------------------
 * Dovecot отбирает ящики запросом `... WHERE email = '%u' AND active`
 * (infra/dovecot/conf/dovecot-sql.conf.ext.template). Значит, отключённый
 * ящик и НЕСУЩЕСТВУЮЩИЙ ящик для него — одно и то же: ни того, ни другого
 * нет в выборке, и вход отклоняется одинаково. Служебный доступ здесь не
 * помогает: он даёт право войти за владельца, а не право войти в то, чего
 * для сервера нет.
 *
 * Разбор ответа IMAP честно переводит этот отказ как «сервер не принял
 * логин или пароль» — и это правда про протокол, но ложь про причину:
 * пароль служебного доступа верен, неверен сам ящик. Поймано на живом
 * стенде: восстановление настроек из копии выключило ящик посреди
 * переноса, а раздел переноса позвал проверять пароль Dovecot.
 *
 * Поэтому причину называет тот, кто её ЗНАЕТ, — наша же база, а не разбор
 * чужого ответа. Отдельный текст на «нет» и «отключён» тоже не прихоть:
 * действия разные (завести ящик против включить его).
 */
export function destMailboxProblem(state: DestMailboxState | undefined): string | null {
  if (state === undefined || !state.exists) {
    return 'Ящика-приёмника нет на сервере — переносить некуда. Заведите ящик или уберите его из списка.';
  }
  if (!state.active) {
    return (
      'Ящик-приёмник отключён: Dovecot не пускает в отключённый ящик даже служебным доступом, ' +
      'поэтому положить в него письма нельзя. Включите ящик и повторите перенос — ' +
      'уже перенесённые письма повторно не поедут.'
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Итоги                                                              */
/* ------------------------------------------------------------------ */

/** Ошибки ящика в том виде, в каком они попадают в базу и в отчёт. */
export function collectErrors(folders: ReadonlyArray<{ errors: readonly string[] }>): string[] {
  const out: string[] = [];
  for (const folder of folders) out.push(...folder.errors);
  // Отчёт читает человек. Тысяча одинаковых строк «квота» его не
  // информирует, а прячет остальные девять причин.
  return out.slice(0, 50);
}
