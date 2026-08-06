/**
 * Пароли админки.
 *
 * Две независимые схемы, и путать их нельзя:
 *
 * 1. Пароли ПОЧТОВЫХ ящиков — формат Dovecot `{SHA512-CRYPT}$6$<соль>$<хэш>`.
 *    Ровно то же, что делает `infra/scripts/create-mailbox.sh` через
 *    `doveadm pw -s SHA512-CRYPT`. Здесь алгоритм реализован на чистом Node,
 *    чтобы API не зависел от наличия docker/doveadm рядом с собой.
 *    Алгоритм — спецификация Ульриха Дреппера «SHA-crypt»
 *    (https://www.akkadia.org/drepper/SHA-crypt.txt), проверен на её же
 *    контрольных примерах в passwords.test.ts и живым входом по IMAP.
 *
 * 2. Пароли АДМИНИСТРАТОРОВ — scrypt из node:crypto. Dovecot их не читает,
 *    поэтому нет смысла тащить туда crypt(3); scrypt современнее и медленнее
 *    подбирается.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* SHA512-CRYPT (формат Dovecot / crypt(3) $6$)                         */
/* ------------------------------------------------------------------ */

/** Алфавит crypt(3) — порядок символов отличается от обычного base64. */
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Число раундов по умолчанию в $6$ (значение из спецификации). */
export const SHA512_CRYPT_DEFAULT_ROUNDS = 5000;

const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 999_999_999;
/** Соль длиннее 16 символов crypt(3) обрезает. */
const SALT_MAX = 16;

/**
 * Порядок байтов при кодировании результата (b64_from_24bit из glibc):
 * тройки индексов итогового 64-байтового дайджеста.
 */
const B64_ORDER: ReadonlyArray<readonly [number, number, number]> = [
  [0, 21, 42],
  [22, 43, 1],
  [44, 2, 23],
  [3, 24, 45],
  [25, 46, 4],
  [47, 5, 26],
  [6, 27, 48],
  [28, 49, 7],
  [50, 8, 29],
  [9, 30, 51],
  [31, 52, 10],
  [53, 11, 32],
  [12, 33, 54],
  [34, 55, 13],
  [56, 14, 35],
  [15, 36, 57],
  [37, 58, 16],
  [59, 17, 38],
  [18, 39, 60],
  [40, 61, 19],
  [62, 20, 41],
];

function sha512(parts: readonly Buffer[]): Buffer {
  const hash = createHash('sha512');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Повторяет src до нужной длины (последний кусок обрезается). */
function repeatTo(src: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  if (src.length === 0) return out;
  for (let offset = 0; offset < length; offset += src.length) {
    src.copy(out, offset, 0, Math.min(src.length, length - offset));
  }
  return out;
}

/** Байт дайджеста по индексу; Buffer с noUncheckedIndexedAccess даёт number|undefined. */
function byteAt(buf: Buffer, index: number): number {
  return buf[index] ?? 0;
}

/** Случайная соль из алфавита crypt(3). */
export function generateCryptSalt(length = SALT_MAX): string {
  const bytes = randomBytes(length);
  let salt = '';
  for (let i = 0; i < length; i += 1) {
    salt += ITOA64[byteAt(bytes, i) % ITOA64.length];
  }
  return salt;
}

/**
 * Считает crypt(3) SHA-512 и возвращает строку `$6$соль$хэш`
 * (или `$6$rounds=N$соль$хэш`, если раундов не 5000).
 */
export function sha512Crypt(
  password: string,
  salt: string = generateCryptSalt(),
  rounds: number = SHA512_CRYPT_DEFAULT_ROUNDS,
): string {
  const effectiveRounds = Math.min(Math.max(Math.trunc(rounds), ROUNDS_MIN), ROUNDS_MAX);
  const saltStr = salt.slice(0, SALT_MAX);
  const pw = Buffer.from(password, 'utf8');
  const sb = Buffer.from(saltStr, 'utf8');

  // Шаги 4-8: дайджест B = SHA512(пароль | соль | пароль)
  const digestB = sha512([pw, sb, pw]);

  // Шаги 1-12: дайджест A
  const aParts: Buffer[] = [pw, sb, repeatTo(digestB, pw.length)];
  for (let cnt = pw.length; cnt > 0; cnt >>= 1) {
    aParts.push((cnt & 1) !== 0 ? digestB : pw);
  }
  const digestA = sha512(aParts);

  // Шаги 13-16: последовательность P (длиной с пароль)
  const dpParts: Buffer[] = [];
  for (let i = 0; i < pw.length; i += 1) dpParts.push(pw);
  const seqP = repeatTo(sha512(dpParts), pw.length);

  // Шаги 17-20: последовательность S (длиной с соль)
  const dsParts: Buffer[] = [];
  const dsRepeats = 16 + byteAt(digestA, 0);
  for (let i = 0; i < dsRepeats; i += 1) dsParts.push(sb);
  const seqS = repeatTo(sha512(dsParts), sb.length);

  // Шаг 21: основной цикл растяжения
  let digestC = digestA;
  for (let round = 0; round < effectiveRounds; round += 1) {
    const parts: Buffer[] = [];
    const odd = (round & 1) !== 0;
    parts.push(odd ? seqP : digestC);
    if (round % 3 !== 0) parts.push(seqS);
    if (round % 7 !== 0) parts.push(seqP);
    parts.push(odd ? digestC : seqP);
    digestC = sha512(parts);
  }

  // Шаг 22: вывод в алфавите crypt(3) с перестановкой байтов
  let encoded = '';
  for (const [b2, b1, b0] of B64_ORDER) {
    let word = (byteAt(digestC, b2) << 16) | (byteAt(digestC, b1) << 8) | byteAt(digestC, b0);
    for (let i = 0; i < 4; i += 1) {
      encoded += ITOA64[word & 0x3f];
      word >>= 6;
    }
  }
  let tail = byteAt(digestC, 63);
  for (let i = 0; i < 2; i += 1) {
    encoded += ITOA64[tail & 0x3f];
    tail >>= 6;
  }

  const prefix =
    effectiveRounds === SHA512_CRYPT_DEFAULT_ROUNDS ? '$6$' : `$6$rounds=${effectiveRounds}$`;
  return `${prefix}${saltStr}$${encoded}`;
}

/**
 * Хэш пароля почтового ящика в том виде, в каком его кладёт в
 * `virtual_users.password` скрипт create-mailbox.sh: с префиксом схемы.
 */
export function dovecotHash(password: string, salt?: string): string {
  return `{SHA512-CRYPT}${sha512Crypt(password, salt ?? generateCryptSalt())}`;
}

/** Разбирает `$6$[rounds=N$]соль$хэш`; null, если формат чужой. */
export function parseCryptHash(
  hash: string,
): { rounds: number; salt: string; digest: string } | null {
  const value = hash.startsWith('{SHA512-CRYPT}') ? hash.slice('{SHA512-CRYPT}'.length) : hash;
  if (!value.startsWith('$6$')) return null;
  const parts = value.slice(3).split('$');
  let rounds = SHA512_CRYPT_DEFAULT_ROUNDS;
  let index = 0;
  const first = parts[0];
  if (first !== undefined && first.startsWith('rounds=')) {
    const parsed = Number.parseInt(first.slice('rounds='.length), 10);
    if (!Number.isFinite(parsed)) return null;
    rounds = parsed;
    index = 1;
  }
  const salt = parts[index];
  const digest = parts[index + 1];
  if (salt === undefined || digest === undefined) return null;
  return { rounds, salt, digest };
}

/** Проверяет пароль против хэша Dovecot (`{SHA512-CRYPT}$6$...` или голого `$6$...`). */
export function verifyDovecotHash(password: string, hash: string): boolean {
  const parsed = parseCryptHash(hash);
  if (!parsed) return false;
  const expected = sha512Crypt(password, parsed.salt, parsed.rounds);
  const actual =
    parsed.rounds === SHA512_CRYPT_DEFAULT_ROUNDS
      ? `$6$${parsed.salt}$${parsed.digest}`
      : `$6$rounds=${parsed.rounds}$${parsed.salt}$${parsed.digest}`;
  return constantTimeEquals(expected, actual);
}

/* ------------------------------------------------------------------ */
/* Пароли администраторов (scrypt)                                      */
/* ------------------------------------------------------------------ */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/** Хэширует пароль администратора: `scrypt$N$r$p$<соль>$<ключ>` (base64url). */
export function hashAdminPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** Проверяет пароль администратора. Никогда не бросает — только true/false. */
export function verifyAdminPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;
    const N = Number.parseInt(nRaw ?? '', 10);
    const r = Number.parseInt(rRaw ?? '', 10);
    const p = Number.parseInt(pRaw ?? '', 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(saltRaw ?? '', 'base64url');
    const key = Buffer.from(keyRaw ?? '', 'base64url');
    if (salt.length === 0 || key.length === 0) return false;
    const candidate = scryptSync(password.normalize('NFKC'), salt, key.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
    return candidate.length === key.length && timingSafeEqual(candidate, key);
  } catch {
    return false;
  }
}

/** Сравнение строк за постоянное время (длины могут отличаться). */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Всё равно тратим время, чтобы длина не утекала по таймингу
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Генератор случайного пароля для новых ящиков (когда админ не задал свой). */
export function generatePassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[byteAt(bytes, i) % alphabet.length];
  return out;
}
