/**
 * Перенос почты: разбор списка ящиков и обращение с паролями.
 *
 * Половина проверок здесь — про пароли, и это соразмерно: перенос
 * забирает пароли от ЧУЖОГО почтового сервера (иногда все пароли
 * организации разом — выгрузка Kerio отдаёт их открытым текстом),
 * держит их часами и обязан избавиться от них по завершении.
 * Утечка тут дороже любого дефекта в счётчиках.
 *
 * На старом коде падают все проверки: раздела переноса не существовало.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretBox } from '../crypto.js';
import {
  collectErrors,
  destEndpointFor,
  packSecrets,
  parseMigrationList,
  rowsForApi,
  sourceEndpointFor,
  unpackSecrets,
  type DestSettings,
  type SourceSettings,
} from './migrate-jobs.js';

const SECRET = 'sekret-dlya-proverki-perenosa-pochty';

/* ------------------------------------------------------------------ */
/* Разбор списка                                                       */
/* ------------------------------------------------------------------ */

test('выгрузка Kerio: адреса и пароли разбираются', () => {
  const csv = [
    'Name;Password;FullName;Description;MailAddress;Groups',
    'abird;VbD66op1;Alexandra Bird;Development;abird@staraya.ru;read,all',
    'ivanov;Qq112233;Иван Иванов;;ivanov@staraya.ru;',
  ].join('\n');

  const parsed = parseMigrationList(csv, { destDomain: 'novaya.ru' });

  assert.equal(parsed.format, 'kerio-csv');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]?.sourceUser, 'abird@staraya.ru');
  assert.equal(parsed.rows[0]?.destUser, 'abird@novaya.ru');
  assert.equal(parsed.withPassword, 2, 'пароли из выгрузки должны быть распознаны');
});

test('логин без домена дополняется доменом исходного сервера', () => {
  // Kerio выгружает MailAddress без домена сплошь и рядом. Без подстановки
  // вход шёл бы под именем «abird», и сервер отвечал бы отказом.
  const csv = ['Name;MailAddress', 'abird;abird', 'ivanov;ivanov'].join('\n');
  const parsed = parseMigrationList(csv, { sourceDomain: 'staraya.ru', destDomain: 'novaya.ru' });
  assert.equal(parsed.rows[0]?.sourceUser, 'abird@staraya.ru');
  assert.equal(parsed.rows[0]?.destUser, 'abird@novaya.ru');
});

test('CSV с парами «откуда → куда»', () => {
  const csv = [
    'source_user,dest_user',
    'ivan@staraya.ru,i.petrov@novaya.ru',
    'sekretar@staraya.ru,office@novaya.ru',
  ].join('\n');
  const parsed = parseMigrationList(csv);
  assert.equal(parsed.format, 'pairs-csv');
  assert.equal(parsed.rows[1]?.sourceUser, 'sekretar@staraya.ru');
  assert.equal(parsed.rows[1]?.destUser, 'office@novaya.ru');
  assert.equal(parsed.withPassword, 0, 'паролей в этом файле нет — и не должно померещиться');
});

test('пустая правая колонка пары означает «тот же адрес»', () => {
  // При переезде домена целиком заполнять правую колонку вручную для
  // каждой из трёхсот строк — работа, которую делать незачем.
  const csv = ['source_user,dest_user', 'ivan@staraya.ru,'].join('\n');
  const parsed = parseMigrationList(csv, { destDomain: 'novaya.ru' });
  assert.equal(parsed.rows[0]?.destUser, 'ivan@novaya.ru');
});

test('просто список адресов, по одному в строке', () => {
  const parsed = parseMigrationList('ivan@staraya.ru\n\n# коммент\npetr@staraya.ru\n', {
    destDomain: 'novaya.ru',
  });
  assert.equal(parsed.format, 'plain');
  assert.equal(parsed.rows.length, 2, 'пустые строки и комментарии не ящики');
  assert.equal(parsed.rows[1]?.destUser, 'petr@novaya.ru');
});

test('пары стрелкой в свободном списке', () => {
  const parsed = parseMigrationList('ivan@staraya.ru -> i.petrov@novaya.ru');
  assert.equal(parsed.rows[0]?.sourceUser, 'ivan@staraya.ru');
  assert.equal(parsed.rows[0]?.destUser, 'i.petrov@novaya.ru');
});

test('повтор в списке отбрасывается и объясняется', () => {
  // Иначе один ящик переносился бы дважды одновременно: два потока пишут
  // в одну папку, дедупликация работает по разным соединениям, и часть
  // писем уезжает в двух экземплярах.
  const parsed = parseMigrationList('ivan@staraya.ru\nivan@staraya.ru');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0] ?? '', /повтор/i);
});

test('пустой текст — ноль ящиков, а не одна пустая строка', () => {
  const parsed = parseMigrationList('   \n  ');
  assert.equal(parsed.rows.length, 0);
});

/* ------------------------------------------------------------------ */
/* Пароли наружу не выходят                                            */
/* ------------------------------------------------------------------ */

test('предпросмотр списка не содержит паролей ни в одном поле', () => {
  const csv = ['Name;Password;MailAddress', 'abird;OchenSekretno1;abird@staraya.ru'].join('\n');
  const parsed = parseMigrationList(csv);
  // Обратный ход: пароль в разобранных строках ЕСТЬ — значит, проверка
  // ниже показывает работу rowsForApi, а не отсутствие пароля в файле.
  assert.equal(parsed.rows[0]?.password, 'OchenSekretno1');

  const shown = rowsForApi(parsed.rows);
  const asText = JSON.stringify(shown);
  assert.doesNotMatch(asText, /OchenSekretno1/, `пароль уехал бы в браузер: ${asText}`);
  assert.equal(shown[0]?.hasPassword, true, 'признак наличия пароля показать надо');
  assert.equal(
    Object.prototype.hasOwnProperty.call(shown[0] ?? {}, 'password'),
    false,
    'поле password должно отсутствовать, а не быть пустым: пустое читается как «пароля не было»',
  );
});

test('свёрток паролей не содержит пароля в открытом виде', () => {
  const box = new SecretBox(SECRET);
  const packed = packSecrets(box, { masterPassword: 'OchenSekretno1' });
  assert.doesNotMatch(packed, /OchenSekretno1/);
  assert.deepEqual(unpackSecrets(box, packed), { masterPassword: 'OchenSekretno1' });
});

test('чужим ключом свёрток не открывается', () => {
  const packed = packSecrets(new SecretBox(SECRET), { masterPassword: 'OchenSekretno1' });
  assert.equal(
    unpackSecrets(new SecretBox('sovsem-drugoj-sekret-tozhe-dlinnyj'), packed),
    null,
    'подбор ключа не должен давать «частично разобранный» результат',
  );
});

test('стёртый свёрток — это null, а не падение', () => {
  // Так выглядит завершённое задание: пароли стёрты вместе с завершением.
  // Работник обязан сказать об этом словами, а не упасть с исключением.
  const box = new SecretBox(SECRET);
  assert.equal(unpackSecrets(box, null), null);
  assert.equal(unpackSecrets(box, ''), null);
  assert.equal(unpackSecrets(box, 'ne-shifrotekst-a-musor'), null);
});

/* ------------------------------------------------------------------ */
/* Сборка подключений                                                  */
/* ------------------------------------------------------------------ */

const source: SourceSettings = {
  host: 'kerio.staraya.ru',
  port: 993,
  secure: true,
  allowInsecureTls: true,
  masterUser: null,
  masterSeparator: null,
};

const dest: DestSettings = {
  host: 'dovecot',
  port: 993,
  secure: true,
  allowInsecureTls: true,
  masterUser: 'sluzhebnyj',
  masterPassword: 'parol-sluzhebnogo',
  masterSeparator: '*',
};

test('служебный доступ: один пароль на все ящики', () => {
  const withMaster: SourceSettings = { ...source, masterUser: 'admin', masterSeparator: '*' };
  const secrets = { masterPassword: 'odin-parol' };

  const first = sourceEndpointFor(withMaster, secrets, { sourceUser: 'a@staraya.ru', position: 0 });
  const second = sourceEndpointFor(withMaster, secrets, { sourceUser: 'b@staraya.ru', position: 1 });

  assert.equal(first?.pass, 'odin-parol');
  assert.equal(second?.pass, 'odin-parol', 'второму ящику отдельный пароль не нужен');
  assert.equal(first?.masterUser, 'admin');
  assert.equal(first?.user, 'a@staraya.ru', 'ящик остаётся ящиком, склейка — дело пакета переноса');
});

test('без служебного доступа пароль берётся по номеру строки', () => {
  const secrets = { mailboxPasswords: { '0': 'parol-a', '1': 'parol-b' } };
  assert.equal(
    sourceEndpointFor(source, secrets, { sourceUser: 'a@staraya.ru', position: 0 })?.pass,
    'parol-a',
  );
  assert.equal(
    sourceEndpointFor(source, secrets, { sourceUser: 'b@staraya.ru', position: 1 })?.pass,
    'parol-b',
  );
  assert.equal(
    sourceEndpointFor(source, secrets, { sourceUser: 'b@staraya.ru', position: 1 })?.masterUser,
    undefined,
    'служебного имени быть не должно: сервер отверг бы «ящик*undefined»',
  );
});

test('нет пароля — нет подключения, а не пустой пароль', () => {
  // Пустой пароль ушёл бы на чужой сервер и вернулся отказом «неверный
  // пароль» — человек пошёл бы проверять чужой сервер вместо своего списка.
  assert.equal(
    sourceEndpointFor(source, { mailboxPasswords: {} }, { sourceUser: 'a@staraya.ru', position: 0 }),
    null,
  );
  assert.equal(
    sourceEndpointFor({ ...source, masterUser: 'admin' }, {}, { sourceUser: 'a@x', position: 0 }),
    null,
  );
});

test('в приёмник входим служебным доступом, пароля владельца не существует', () => {
  const endpoint = destEndpointFor(dest, 'ivan@novaya.ru');
  assert.equal(endpoint.user, 'ivan@novaya.ru');
  assert.equal(endpoint.masterUser, 'sluzhebnyj');
  assert.equal(
    endpoint.pass,
    'parol-sluzhebnogo',
    'пароль владельца ящика панель не знает и знать не должна — в базе только хэш',
  );
});

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */

test('ошибки папок собираются, но не заваливают отчёт', () => {
  const many = Array.from({ length: 200 }, (_, i) => `UID ${String(i)}: квота`);
  const collected = collectErrors([{ errors: many }, { errors: ['ещё одна причина'] }]);
  assert.equal(collected.length, 50, 'тысяча одинаковых строк прячет остальные причины');
  assert.equal(collected[0], 'UID 0: квота');
});
