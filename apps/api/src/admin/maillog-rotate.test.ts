/**
 * Журнал почтового сервера обязан проворачиваться его же средством.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Цикл в entrypoint переименовывал файл сам: `mv postfix.log
 * postfix.log.1`. Этого НЕДОСТАТОЧНО и это не тонкость. Журнал пишет
 * postlogd, он держит файл открытым по дескриптору: после переименования
 * запись продолжается в `postfix.log.1`, а новый `postfix.log` остаётся
 * пустым навсегда. Состояние необратимо — оба цикла проворота смотрят на
 * размер `postfix.log`, а он нулевой.
 *
 * Ломалось при этом всё сразу: `postfix.log.1` рос без предела (ровно то,
 * ради чего проворот и заводили); разделы «Журналы почты» и «Почтовый
 * поток» вместе с историей входов владельца ящика навсегда пустели на
 * исправном сервере; камера fail2ban `mailtrue-postfix-sasl` читала тот
 * же файл и переставала банить подбор паролей молча, при зелёном
 * `fail2ban-client status`.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПРОВЕРЯЕТСЯ СКРИПТ, А НЕ ПОВЕДЕНИЕ
 * ------------------------------------------------------------------
 * Воспроизвести это на живом сервере — значит налить в журнал 32 МиБ и
 * ждать минуту, а увидеть последствие — ещё сутки. Ошибка же ровно в
 * одной строке скрипта, и она видна чтением: правильный проворот
 * называется `postfix logrotate`, у Dovecot ему соответствует
 * `doveadm log reopen`, у fail2ban — `fail2ban-client flushlogs`.
 * Проверяем, что ни один из трёх не подменён простым переименованием.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function script(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8');
}

/** Строки скрипта без комментариев: комментарии тут как раз про `mv`. */
function code(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

test('журнал Postfix проворачивается командой postfix logrotate', () => {
  const lines = code(script('infra/postfix/entrypoint.sh'));
  assert.ok(
    lines.some((line) => /postfix\s+logrotate/.test(line)),
    'в entrypoint нет проворота средствами Postfix — переименование не заставит postlogd открыть новый файл',
  );
});

test('журнал Postfix не переименовывается вручную', () => {
  const lines = code(script('infra/postfix/entrypoint.sh'));
  const renames = lines.filter((line) => /\bmv\b.*MAILLOG/.test(line));
  assert.deepEqual(
    renames,
    [],
    'файл журнала переименовывают вручную: postlogd продолжит писать в переименованный, а новый останется пустым навсегда',
  );
});

test('провёрнутые куски убираются, иначе диск съедят они', () => {
  const lines = code(script('infra/postfix/entrypoint.sh'));
  // Перечисление кусков и их удаление — разные строки (список идёт по
  // конвейеру), поэтому спрашиваем про обе.
  assert.ok(
    lines.some((line) => /MAILLOG["']?\.\*/.test(line)),
    'провёрнутые куски журнала никто не перечисляет — значит и не убирает',
  );
  assert.ok(
    lines.some((line) => /\brm\b/.test(line)),
    'лишние куски журнала никто не удаляет — накопление съедает диск так же, как один растущий файл',
  );
});

/*
 * У соседей та же схема сделана правильно, и это не должно разъехаться:
 * если завтра кто-то «упростит» их до `mv`, получится ровно тот же
 * молчаливый отказ, только в другом журнале.
 */
test('Dovecot и fail2ban переоткрывают журнал своими средствами', () => {
  const dovecot = code(script('infra/dovecot/entrypoint.sh'));
  assert.ok(
    dovecot.some((line) => /doveadm\s+log\s+reopen/.test(line)),
    'после проворота Dovecot обязан переоткрыть журнал',
  );

  const fail2ban = code(script('infra/fail2ban/entrypoint.sh'));
  assert.ok(
    fail2ban.some((line) => /fail2ban-client\s+flushlogs/.test(line)),
    'после проворота fail2ban обязан переоткрыть журнал',
  );
});

/*
 * Самопроверка обязана смотреть КАЖДЫЙ порт, который мы объявили
 * обязательным. Расхождение здесь особенно коварно: порт 465 в списке
 * обязательных был, публикуется он с самого начала, а самопроверка вместо
 * проверки печатала «стек его пока не поддерживает» и выходила с кодом 0.
 * Клиенты Apple и Outlook, которым автонастройка сама выдаёт 465, при
 * сломанной публикации не могли отправлять письма — и ни один прогон
 * самопроверки этого не показывал.
 */
test('самопроверка смотрит все обязательные порты', () => {
  const common = script('install/lib/common.sh');
  const listed = /MT_REQUIRED_PORTS=\(([^)]*)\)/.exec(common)?.[1] ?? '';
  const required = listed.split(/\s+/).filter((token) => /^\d+$/.test(token));
  assert.ok(required.length >= 8, 'список обязательных портов не разобрался');

  const selfcheck = script('install/selfcheck.sh');
  const checked = new Set(
    [...selfcheck.matchAll(/^\s*check_port\s+(\d+)/gm)].map((match) => match[1] ?? ''),
  );
  const missing = required.filter((port) => !checked.has(port));
  assert.deepEqual(
    missing,
    [],
    `самопроверка не смотрит обязательные порты: ${missing.join(', ')} — поломка их публикации останется незамеченной`,
  );
});
