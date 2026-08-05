/**
 * Шифрование ключа доступа к сервису ИИ.
 *
 * Требование docs/ai-spec.md: «ключ доступа (шифруется, ключ шифрования —
 * отдельно от базы)». Поэтому:
 *
 *   - в таблице ai_domain_settings лежит только шифротекст (api_key_enc);
 *   - ключ шифрования берётся из переменной окружения AI_ENCRYPTION_KEY
 *     и в базу не попадает никогда;
 *   - дамп базы без этой переменной окружения бесполезен;
 *   - SESSION_SECRET намеренно НЕ переиспользуется: смена секрета сессий
 *     не должна обесценивать ключи ИИ, и наоборот.
 *
 * Алгоритм — AES-256-GCM: он даёт не только скрытие, но и проверку
 * целостности, поэтому подменённая строка не расшифруется, а честно
 * приведёт к ошибке.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Метка формата в начале строки: позволит сменить схему без миграции данных. */
const PREFIX = 'v1.';

/** Минимальная длина секрета. Короче — не даём включить, а не «предупреждаем». */
export const MIN_SECRET_LENGTH = 32;

export class AiKeyBoxError extends Error {}

/**
 * Шифровальщик ключей доступа. Создаётся один раз при старте,
 * если задана переменная окружения; иначе его просто нет
 * (см. {@link createKeyBox}) и ключи хранить нельзя.
 */
export class AiKeyBox {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new AiKeyBoxError(
        `AI_ENCRYPTION_KEY должен быть длиной не менее ${String(MIN_SECRET_LENGTH)} символов`,
      );
    }
    // Отдельная «соль»: ключ шифрования ИИ не совпадает с ключом сессий,
    // даже если кто-то задаст одинаковые секреты.
    this.#key = scryptSync(secret, 'mail-true-ai-key-v1', 32);
  }

  /** Шифрует ключ доступа. Результат: 'v1.' + base64url(iv | tag | шифротекст). */
  encrypt(plain: string): string {
    if (plain.length === 0) {
      throw new AiKeyBoxError('Пустой ключ доступа шифровать нечего');
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, data]).toString('base64url');
  }

  /**
   * Расшифровывает строку, созданную {@link encrypt}.
   * Бросает {@link AiKeyBoxError} при неверном формате, чужом ключе
   * шифрования или повреждении данных — молча вернуть мусор нельзя,
   * иначе наружу уйдёт неверный заголовок авторизации.
   */
  decrypt(boxed: string): string {
    if (!boxed.startsWith(PREFIX)) {
      throw new AiKeyBoxError('Неизвестный формат зашифрованного ключа доступа');
    }
    const raw = Buffer.from(boxed.slice(PREFIX.length), 'base64url');
    if (raw.length <= IV_LENGTH + TAG_LENGTH) {
      throw new AiKeyBoxError('Зашифрованный ключ доступа повреждён: слишком короткий');
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = raw.subarray(IV_LENGTH + TAG_LENGTH);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new AiKeyBoxError(
        'Не удалось расшифровать ключ доступа: задан другой AI_ENCRYPTION_KEY или запись повреждена',
      );
    }
  }
}

/**
 * Хвост ключа для опознания в админке: '…a3f9'.
 * Показывать целиком нельзя, а отличать один ключ от другого нужно.
 */
export function keyHint(plain: string): string {
  const tail = plain.slice(-4);
  return tail.length > 0 ? `…${tail}` : '';
}

export interface KeyBoxResult {
  box: AiKeyBox | null;
  /** Почему шифровальщика нет. null — он есть. */
  reason: string | null;
}

/**
 * Создаёт шифровальщик из переменной окружения.
 *
 * Отсутствие AI_ENCRYPTION_KEY — не авария: локальной модели ключ доступа
 * не нужен, и помощник прекрасно работает без него. Авария наступает
 * только при попытке СОХРАНИТЬ ключ — тогда маршрут честно откажет.
 */
export function createKeyBox(secret: string | undefined): KeyBoxResult {
  if (!secret || secret.length === 0) {
    return {
      box: null,
      reason:
        'Не задана переменная окружения AI_ENCRYPTION_KEY — ключ доступа к сервису ИИ хранить негде. ' +
        'Для локальной модели ключ не нужен, для внешнего сервиса задайте переменную.',
    };
  }
  try {
    return { box: new AiKeyBox(secret), reason: null };
  } catch (err) {
    return { box: null, reason: err instanceof Error ? err.message : String(err) };
  }
}
