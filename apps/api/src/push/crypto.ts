/**
 * Криптография Web Push: ключи VAPID, подпись обращения к службе доставки
 * и шифрование самого сообщения.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СВОЯ РЕАЛИЗАЦИЯ, А НЕ ГОТОВЫЙ ПАКЕТ
 * ------------------------------------------------------------------
 * Обычно берут `web-push` из npm. Здесь этого не сделано по двум причинам,
 * и обе практические, а не вкусовые.
 *
 *   1. Пакет тянет за собой зависимости ради вещей, которые у нас уже есть:
 *      HTTP-клиент (в Node 20 есть встроенный fetch) и подпись JWT (в
 *      apps/api уже стоит `jose`). Ради двухсот строк математики мы бы
 *      добавили в почтовый сервер чужое дерево зависимостей — в продукт,
 *      который ставят как раз ради того, чтобы ничего лишнего не было.
 *   2. Здесь работают с ключами, которыми шифруется содержимое уведомлений.
 *      Это ровно то место, где стоит понимать каждую строку, а не
 *      надеяться на неё.
 *
 * Всё, что ниже, — прямая запись RFC:
 *   RFC 8188 — «Encrypted Content-Encoding for HTTP» (формат тела aes128gcm);
 *   RFC 8291 — «Message Encryption for Web Push» (как выводятся ключи);
 *   RFC 8292 — «Voluntary Application Server Identification» (VAPID).
 *
 * Правильность проверяется контрольным примером из RFC 8291 §5 (те же
 * входные данные — тот же байт в байт результат) и обратным ходом:
 * зашифрованное здесь расшифровывается независимой реализацией в тесте.
 */
import {
  createECDH,
  createCipheriv,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { SignJWT } from 'jose';

/* ------------------------------------------------------------------ */
/* Кодирование                                                          */
/* ------------------------------------------------------------------ */

/** base64url без выравнивающих знаков «=» — так требуют все три RFC. */
export function toBase64Url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Разбор base64url. Принимает и обычный base64 с «+/=»: браузеры отдают
 * ключи подписки строго в base64url, но ключ VAPID человек может вставить
 * в настройки руками из любого источника, и падать на этом незачем.
 */
export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
}

/* ------------------------------------------------------------------ */
/* Ключи VAPID                                                          */
/* ------------------------------------------------------------------ */

export interface VapidKeys {
  /** Открытый ключ: несжатая точка P-256 (65 байт, 0x04||X||Y) в base64url. */
  publicKey: string;
  /** Закрытый ключ: скаляр 32 байта в base64url. */
  privateKey: string;
}

/**
 * Новая пара ключей VAPID.
 *
 * Пара привязана к подпискам: открытый ключ вшивается в подписку браузером
 * в момент её создания, и сменить его — значит разом обесценить все
 * подписки. Поэтому ключи создаются ОДИН раз и хранятся (см. db.ts).
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string; y?: string };
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error('Не удалось создать ключи VAPID');
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    fromBase64Url(jwk.x),
    fromBase64Url(jwk.y),
  ]);
  // Публичный ключ берём из JWK, а не из export('spki'): наружу нужен
  // именно голый вид точки, а не обёртка ASN.1 — его ждёт браузер.
  void publicKey;
  return { publicKey: toBase64Url(raw), privateKey: jwk.d };
}

/** Проверяет, что пара ключей VAPID пригодна к работе. */
export function vapidKeysValid(keys: VapidKeys): boolean {
  try {
    const pub = fromBase64Url(keys.publicKey);
    const priv = fromBase64Url(keys.privateKey);
    if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) return false;
    // Сходятся ли они между собой: открытый ключ обязан выводиться
    // из закрытого, иначе служба доставки отвергнет подпись, а понять
    // почему будет негде.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

/** Закрытый ключ в виде объекта Node — для подписи JWT. */
function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const pub = fromBase64Url(keys.publicKey);
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: toBase64Url(pub.subarray(1, 33)),
      y: toBase64Url(pub.subarray(33, 65)),
    },
  });
}

/**
 * Происхождение адреса службы доставки — то, что кладётся в поле `aud`.
 *
 * Именно происхождение, без пути: путь подписки — это, по сути, секрет
 * (кто его знает, тот может слать уведомления), и в подписанном токене
 * ему не место. Так же требует RFC 8292 §2.
 */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

export interface VapidHeaderOptions {
  endpoint: string;
  keys: VapidKeys;
  /** Контакт администратора: mailto: или https://. Требование RFC 8292 §2.1. */
  subject: string;
  /** Срок жизни токена. RFC ограничивает сутками; берём двенадцать часов. */
  ttlSeconds?: number;
  /** Точка отсчёта — только для проверяемости. */
  now?: number;
}

/**
 * Заголовок `Authorization` для обращения к службе доставки.
 *
 * Схема `vapid` (RFC 8292 §3.1): токен и открытый ключ в одном заголовке.
 * Устаревшую пару «Authorization: WebPush …» + «Crypto-Key: p256ecdsa=…»
 * не поддерживаем намеренно: её принимают ради старых клиентов, а мы
 * новые, и лишний путь — это лишний способ ошибиться.
 */
export async function vapidAuthorization(options: VapidHeaderOptions): Promise<string> {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ typ: 'JWT', alg: 'ES256' })
    .setAudience(audienceOf(options.endpoint))
    .setExpirationTime(now + (options.ttlSeconds ?? 12 * 3600))
    .setSubject(options.subject)
    .sign(vapidPrivateKeyObject(options.keys));
  return `vapid t=${token}, k=${options.keys.publicKey}`;
}

/* ------------------------------------------------------------------ */
/* Шифрование сообщения (RFC 8291 поверх RFC 8188)                      */
/* ------------------------------------------------------------------ */

/** Вывод ключа по HKDF (RFC 5869) — ровно на один блок, больше не нужно. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const okm = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return okm.subarray(0, length);
}

export interface PushSubscriptionKeys {
  /** Открытый ключ браузера: несжатая точка P-256 в base64url. */
  p256dh: string;
  /** Общий секрет подписки (16 байт) в base64url. */
  auth: string;
}

export interface EncryptOptions {
  keys: PushSubscriptionKeys;
  payload: Buffer | string;
  /** Эфемерная пара и соль. Задаются только в тестах — иначе случайные. */
  senderPrivateKey?: Buffer;
  salt?: Buffer;
  /** Размер записи. Всегда одна запись, поэтому это просто предел тела. */
  recordSize?: number;
}

/**
 * Шифрует тело push-сообщения в кодировке `aes128gcm`.
 *
 * Ключ выводится из пары «наш эфемерный ключ ↔ ключ браузера» и общего
 * секрета подписки. Служба доставки (Google, Mozilla, Apple) не участвует
 * в выводе ключа НИКАК и прочитать тело не может — это и есть смысл
 * RFC 8291. Что она видит всё равно: адрес подписки, время, размер и
 * частоту. Именно поэтому содержимое письма мы туда не кладём — см.
 * пояснение в service.ts.
 */
export function encryptPushPayload(options: EncryptOptions): Buffer {
  const userPublicKey = fromBase64Url(options.keys.p256dh);
  const authSecret = fromBase64Url(options.keys.auth);
  if (userPublicKey.length !== 65 || userPublicKey[0] !== 0x04) {
    throw new Error('Ключ подписки p256dh должен быть несжатой точкой P-256 (65 байт)');
  }
  if (authSecret.length !== 16) {
    throw new Error('Секрет подписки auth должен быть длиной 16 байт');
  }

  const ecdh = createECDH('prime256v1');
  if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey);
  else ecdh.generateKeys();
  const senderPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userPublicKey);

  // RFC 8291 §3.4: сначала из общего секрета ECDH и секрета подписки
  // выводится «входной ключевой материал», и только потом — ключ записи.
  // Порядок ключей в key_info (сначала браузер, потом мы) задан RFC
  // и перестановке не подлежит: с обратным порядком получится другой
  // ключ, и браузер молча выбросит уведомление.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    userPublicKey,
    senderPublicKey,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = options.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('Соль должна быть длиной 16 байт');

  const contentKey = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const plaintext = Buffer.isBuffer(options.payload)
    ? options.payload
    : Buffer.from(options.payload, 'utf8');
  // 0x02 — признак последней записи (RFC 8188 §2). Запись у нас всегда
  // одна: тело push ограничено четырьмя килобайтами, дробить нечего.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = options.recordSize ?? 4096;
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(senderPublicKey.length, 20);

  return Buffer.concat([header, senderPublicKey, ciphertext]);
}

/**
 * Предел тела push-сообщения.
 *
 * Четыре килобайта гарантирует спецификация Push API; службы доставки
 * принимают и больше, но полагаться на это нельзя. Из них вычитается
 * запас на служебные байты формата: заголовок 21 байт, эфемерный ключ
 * 65 байт, метка проверки целостности 16 байт, признак записи 1 байт.
 * Считаем с запасом — превысить предел молча дороже, чем недобрать.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 4096 - 21 - 65 - 16 - 1 - 16;
