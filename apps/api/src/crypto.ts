/**
 * Шифрование пароля пользователя для хранения в сессии (AES-256-GCM).
 * Пароль нужен серверу, чтобы открывать IMAP/SMTP-соединения от имени пользователя.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Ключ детерминированно выводится из SESSION_SECRET
    this.key = scryptSync(secret, 'mail-true-session-v1', 32);
  }

  /** Шифрует строку; результат — base64url(iv | tag | ciphertext). */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, data]).toString('base64url');
  }

  /** Расшифровывает строку, созданную encrypt(). Бросает при повреждении данных. */
  decrypt(boxed: string): string {
    const raw = Buffer.from(boxed, 'base64url');
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

/** Криптостойкий идентификатор сессии. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}
