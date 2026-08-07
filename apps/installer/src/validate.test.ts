/**
 * Проверки разбора ответов мастера.
 *
 * Смотрим на то, что ломается тихо: значение проходит, установка идёт, а
 * узнаётся об ошибке через неделю. Пароль-заглушка, вложение больше письма,
 * два одинаковых порта, адрес не из своей подсети — каждый из этих случаев
 * уже стоил кому-то рабочего дня.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_PORTS,
  isPlaceholderPassword,
  subnetContains,
  validateAnswers,
  type Answers,
} from './validate.js';

function goodAnswers(): Answers {
  return {
    domain: 'example.ru',
    hostname: 'mail.example.ru',
    adminEmail: 'admin@example.ru',
    adminLogin: 'admin',
    adminPassword: 'Xy7#kq2Lm9pR',
    adminPasswordRepeat: 'Xy7#kq2Lm9pR',
    tls: 'selfsigned',
    leEmail: '',
    customCert: '',
    customChain: '',
    customKey: '',
    bindAddress: '0.0.0.0',
    clamav: false,
    aiEnabled: true,
    ports: { ...DEFAULT_PORTS },
    subnet: '172.28.0.0/16',
    resolverIp: '172.28.0.53',
    dovecotIp: '172.28.0.54',
    messageMaxBytes: 26_214_400,
    uploadMaxBytes: 26_214_400,
    composeBodyMaxBytes: 12_582_912,
    defaultQuotaBytes: 1_073_741_824,
  };
}

function fieldsWithErrors(answers: Answers): string[] {
  return validateAnswers(answers).map((e) => e.field);
}

test('обычные ответы проходят целиком', () => {
  assert.deepEqual(validateAnswers(goodAnswers()), []);
});

test('пароль-заглушка из примеров не принимается', () => {
  // Значение длиннее десяти символов: проверку длины оно проходило, и
  // боевые серверы уезжали с общеизвестным паролем администратора.
  assert.equal(isPlaceholderPassword('смените-этот-пароль'), true);
  assert.equal(isPlaceholderPassword('change-me-postgres'), true);
  assert.equal(isPlaceholderPassword('Xy7#kq2Lm9pR'), false);

  const answers = goodAnswers();
  answers.adminPassword = 'смените-этот-пароль';
  answers.adminPasswordRepeat = 'смените-этот-пароль';
  assert.ok(fieldsWithErrors(answers).includes('adminPassword'));
});

test('адрес администратора обязан быть в своём домене', () => {
  const answers = goodAnswers();
  answers.adminEmail = 'admin@gmail.com';
  assert.ok(fieldsWithErrors(answers).includes('adminEmail'));
});

test('вложение не может быть больше письма', () => {
  // Иначе интерфейс примет файл, а собственный же Postfix отобьёт готовое
  // письмо: человек получит отбойник на то, что у него только что приняли.
  const answers = goodAnswers();
  answers.uploadMaxBytes = 50 * 1024 * 1024;
  assert.ok(fieldsWithErrors(answers).includes('uploadMaxBytes'));
});

test('один и тот же порт дважды — это отказ docker при подъёме стека', () => {
  const answers = goodAnswers();
  answers.ports = { ...DEFAULT_PORTS, imaps: 587 };
  const errors = validateAnswers(answers);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /587/);
});

test('подсеть и адреса внутри неё меняются только вместе', () => {
  assert.equal(subnetContains('172.28.0.0/16', '172.28.0.54'), true);
  assert.equal(subnetContains('172.29.0.0/16', '172.28.0.54'), false);
  assert.equal(subnetContains('', '172.28.0.54'), false);

  const answers = goodAnswers();
  answers.subnet = '172.29.0.0/16';
  const fields = fieldsWithErrors(answers);
  assert.ok(fields.includes('resolverIp'));
  assert.ok(fields.includes('dovecotIp'));
});

test('Let’s Encrypt без адреса для уведомлений не принимается', () => {
  const answers = goodAnswers();
  answers.tls = 'letsencrypt';
  answers.leEmail = '';
  assert.ok(fieldsWithErrors(answers).includes('leEmail'));
});

test('отказ называет причину, а не код поля', () => {
  const answers = goodAnswers();
  answers.domain = 'не домен';
  const message = validateAnswers(answers).find((e) => e.field === 'domain')?.message ?? '';
  assert.ok(message.length > 40, 'сообщение должно объяснять, а не называть поле');
  assert.ok(message.includes('@'), 'человеку нужно узнать себя в объяснении');
});
