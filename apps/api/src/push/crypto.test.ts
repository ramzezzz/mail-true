/**
 * Криптография Web Push: проверка контрольным примером и обратным ходом.
 *
 * Здесь важна не «работает ли код», а «совпадает ли он с тем, что ждёт
 * браузер». Ошибка в выводе ключа не проявляется ничем: служба доставки
 * примет сообщение, вернёт 201, а браузер молча выбросит его — уведомления
 * просто не будет, и искать причину будет негде. Поэтому проверки такие:
 *
 *   1. Контрольный пример из RFC 8291 §5: те же входные данные обязаны
 *      дать тот же результат ДО БАЙТА. Это единственный способ убедиться,
 *      что мы шифруем именно так, как читает браузер.
 *   2. Обратный ход: написанная здесь независимая расшифровка (по тому же
 *      RFC, но отдельно от рабочего кода) обязана вернуть исходный текст.
 *   3. Подпись VAPID проверяется её же открытым ключом — то есть тем,
 *      чем её будет проверять служба доставки.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { importJWK, jwtVerify } from 'jose';
import {
  MAX_PUSH_PAYLOAD_BYTES,
  audienceOf,
  encryptPushPayload,
  fromBase64Url,
  generateVapidKeys,
  toBase64Url,
  vapidAuthorization,
  vapidKeysValid,
} from './crypto.js';

/* ------------------------------------------------------------------ */
/* Контрольный пример RFC 8291 §5                                       */
/* ------------------------------------------------------------------ */

const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  /** Тело из RFC, склеенное из трёх строк переноса. */
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('шифрование совпадает с контрольным примером RFC 8291 до байта', () => {
  const expected = fromBase64Url(RFC.body);
  // Соль в примере не приведена отдельной строкой — она и есть первые
  // шестнадцать байт тела (RFC 8188 §2.1). Берём её оттуда, а не
  // переписываем константой: так проверка не разойдётся с примером.
  const salt = expected.subarray(0, 16);

  const actual = encryptPushPayload({
    keys: { p256dh: RFC.receiverPublic, auth: RFC.authSecret },
    payload: RFC.plaintext,
    senderPrivateKey: fromBase64Url(RFC.senderPrivate),
    salt,
  });

  assert.equal(toBase64Url(actual), RFC.body);
  // Длина складывается из заголовка (21), эфемерного ключа (65), текста
  // (41), признака записи (1) и метки целостности (16) — и ни из чего ещё
  assert.equal(actual.length, 21 + 65 + RFC.plaintext.length + 1 + 16);
  assert.equal(actual.length, fromBase64Url(RFC.body).length);
});

/* ------------------------------------------------------------------ */
/* Обратный ход: независимая расшифровка                                */
/* ------------------------------------------------------------------ */

/**
 * Расшифровка тела aes128gcm — написана здесь отдельно от рабочего кода
 * и по тем же RFC. Смысл: если в выводе ключа ошибка, она должна поймать
 * нас на несовпадении, а не «сойтись сама с собой».
 */
function decryptPushPayload(body: Buffer, receiverPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const shared = ecdh.computeSecret(senderPublic);
  const receiverPublic = ecdh.getPublicKey();

  const derive = (key: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer => {
    const prk = createHmac('sha256', key).update(ikm).digest();
    return createHmac('sha256', prk)
      .update(Buffer.concat([info, Buffer.from([0x01])]))
      .digest()
      .subarray(0, length);
  };

  const ikm = derive(
    authSecret,
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), receiverPublic, senderPublic]),
    32,
  );
  const key = derive(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = derive(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // Последний байт — признак записи (0x02 у последней записи)
  assert.equal(padded[padded.length - 1], 0x02);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

test('зашифрованное расшифровывается обратно ключом получателя', () => {
  const body = encryptPushPayload({
    keys: { p256dh: RFC.receiverPublic, auth: RFC.authSecret },
    payload: RFC.plaintext,
    senderPrivateKey: fromBase64Url(RFC.senderPrivate),
    salt: fromBase64Url(RFC.body).subarray(0, 16),
  });
  assert.equal(
    decryptPushPayload(body, fromBase64Url(RFC.receiverPrivate), fromBase64Url(RFC.authSecret)),
    RFC.plaintext,
  );
});

test('со случайными ключами и солью текст тоже возвращается целым', () => {
  // Полный круг: делаем подписку так же, как её делает браузер.
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const auth = randomBytes(16);
  const payload = JSON.stringify({ v: 1, ids: ['inbox:296'], тема: 'кириллица и эмодзи ✉' });

  const body = encryptPushPayload({
    keys: { p256dh: toBase64Url(browser.getPublicKey()), auth: toBase64Url(auth) },
    payload,
  });

  assert.equal(decryptPushPayload(body, browser.getPrivateKey(), auth), payload);
});

test('два вызова с одним и тем же текстом дают разные тела', () => {
  // Соль и эфемерный ключ случайны при каждом вызове. Совпадение тел
  // означало бы, что случайность где-то потерялась, и одинаковые
  // уведомления стали бы различимы по одному только виду шифротекста.
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const keys = { p256dh: toBase64Url(browser.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
  const a = encryptPushPayload({ keys, payload: 'одно и то же' });
  const b = encryptPushPayload({ keys, payload: 'одно и то же' });
  assert.notEqual(toBase64Url(a), toBase64Url(b));
});

test('битые ключи подписки отвергаются до отправки, а не после', () => {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const good = toBase64Url(browser.getPublicKey());
  const auth = toBase64Url(randomBytes(16));

  assert.throws(
    () => encryptPushPayload({ keys: { p256dh: 'слишком-коротко', auth }, payload: 'x' }),
    /p256dh/u,
  );
  assert.throws(
    () =>
      encryptPushPayload({
        keys: { p256dh: good, auth: toBase64Url(randomBytes(8)) },
        payload: 'x',
      }),
    /auth/u,
  );
});

test('заголовок тела разобран по RFC 8188: соль, размер записи, длина ключа', () => {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const body = encryptPushPayload({
    keys: { p256dh: toBase64Url(browser.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
    payload: 'проверка',
  });
  assert.equal(body.readUInt32BE(16), 4096, 'размер записи');
  assert.equal(body.readUInt8(20), 65, 'длина открытого ключа отправителя');
  assert.equal(body[21], 0x04, 'ключ отправителя — несжатая точка');
});

/* ------------------------------------------------------------------ */
/* VAPID                                                                */
/* ------------------------------------------------------------------ */

test('созданная пара ключей VAPID сходится сама с собой', () => {
  const keys = generateVapidKeys();
  assert.ok(vapidKeysValid(keys));
  assert.equal(fromBase64Url(keys.publicKey).length, 65);
  assert.equal(fromBase64Url(keys.privateKey).length, 32);
});

test('чужой открытый ключ в паре не проходит проверку', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  // Ровно этот случай — «ключи перепутали местами при переносе» —
  // иначе выяснился бы только по молчащим уведомлениям на живом стенде.
  assert.equal(vapidKeysValid({ publicKey: a.publicKey, privateKey: b.privateKey }), false);
});

test('подпись VAPID проверяется её же открытым ключом', async () => {
  const keys = generateVapidKeys();
  const now = Date.UTC(2026, 7, 6, 12, 0, 0);
  const header = await vapidAuthorization({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123?xyz=1',
    keys,
    subject: 'mailto:postmaster@mail.local',
    now,
  });

  const match = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
  assert.ok(match, `неожиданный вид заголовка: ${header}`);
  const [, token, publicKey] = match;
  assert.equal(publicKey, keys.publicKey);

  const raw = fromBase64Url(keys.publicKey);
  const jwk = await importJWK(
    {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(raw.subarray(1, 33)),
      y: toBase64Url(raw.subarray(33, 65)),
    },
    'ES256',
  );
  // Часы проверки — те же, что часы подписи. Без этого проверка была
  // бомбой с часовым механизмом: токен подписывался замороженным временем
  // (6 августа 2026), а jwtVerify сверял срок с настоящими часами — и
  // ровно через двенадцать часов после этой даты проверка начала падать
  // с «exp claim timestamp check failed», ничего не сказав о том, что
  // сломалось не в коде, а в ней самой.
  const { payload, protectedHeader } = await jwtVerify(token!, jwk, {
    currentDate: new Date(now),
  });
  assert.equal(protectedHeader.alg, 'ES256');
  // Слушатель — только происхождение: путь подписки в токен не попадает,
  // потому что путь и есть секрет подписки.
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:postmaster@mail.local');
  assert.equal(payload.exp, Math.floor(now / 1000) + 12 * 3600);
});

test('слушатель токена — происхождение адреса, без пути подписки', () => {
  assert.equal(
    audienceOf('https://updates.push.services.mozilla.com/wpush/v2/gAAAA…длинный-секрет'),
    'https://updates.push.services.mozilla.com',
  );
});

test('предел тела оставляет запас на служебные байты формата', () => {
  // Число должно быть заметно меньше четырёх килобайт, иначе служебные
  // байты выведут сообщение за предел уже после шифрования — то есть
  // тогда, когда проверять поздно.
  assert.ok(MAX_PUSH_PAYLOAD_BYTES < 4096 - 100);
  assert.ok(MAX_PUSH_PAYLOAD_BYTES > 3000);

  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const body = encryptPushPayload({
    keys: { p256dh: toBase64Url(browser.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
    payload: Buffer.alloc(MAX_PUSH_PAYLOAD_BYTES, 0x61),
  });
  assert.ok(body.length <= 4096, `тело выросло до ${String(body.length)} байт`);
});
