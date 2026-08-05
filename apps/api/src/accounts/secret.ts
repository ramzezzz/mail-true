/**
 * Шифрование паролей чужих ящиков.
 *
 * Требование docs/plan.md (этап 9): «Пароли внешних ящиков шифруются
 * в базе, ключ отдельно от неё». Поэтому:
 *
 *   - в таблицах external_accounts и linked_accounts лежит только
 *     шифротекст (password_enc); столбца с открытым паролем нет вовсе;
 *   - ключ шифрования берётся из переменной окружения
 *     EXTERNAL_ACCOUNTS_KEY и в базу не попадает никогда;
 *   - дамп базы без этой переменной окружения бесполезен;
 *   - SESSION_SECRET и AI_ENCRYPTION_KEY намеренно НЕ переиспользуются:
 *     смена секрета сессий не должна обрывать сбор почты, а компрометация
 *     ключа ИИ не должна открывать чужие почтовые ящики.
 *
 * Алгоритм — AES-256-GCM, тот же, что у сессий (src/crypto.ts) и у ключей
 * ИИ (src/ai/secret.ts): он даёт не только скрытие, но и проверку
 * целостности, поэтому подменённая строка не расшифруется в мусор,
 * а честно приведёт к ошибке. Пароль от чужого сервера — не то, что
 * можно «примерно» восстановить: неверный пароль означает блокировку
 * ящика на чужой стороне после нескольких попыток.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Метка формата: позволит сменить схему без миграции данных. */
const PREFIX = 'v1.';

/** Минимальная длина секрета. Короче — не даём включить, а не «предупреждаем». */
export const MIN_SECRET_LENGTH = 32;

export class ExternalSecretError extends Error {}

export class ExternalSecretBox {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new ExternalSecretError(
        `EXTERNAL_ACCOUNTS_KEY должен быть длиной не менее ${String(MIN_SECRET_LENGTH)} символов`,
      );
    }
    // Отдельная «соль»: ключ шифрования паролей чужих ящиков не совпадает
    // ни с ключом сессий, ни с ключом ИИ, даже если секреты задали одинаковые.
    this.#key = scryptSync(secret, 'mail-true-external-accounts-v1', 32);
  }

  /** Шифрует пароль. Результат: 'v1.' + base64url(iv | tag | шифротекст). */
  encrypt(plain: string): string {
    if (plain.length === 0) {
      throw new ExternalSecretError('Пустой пароль шифровать нечего');
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, data]).toString('base64url');
  }

  /**
   * Расшифровывает строку, созданную {@link encrypt}.
   * Бросает {@link ExternalSecretError} при неверном формате, чужом ключе
   * или повреждении данных: молча вернуть мусор нельзя — им попытаются
   * войти на чужой сервер.
   */
  decrypt(boxed: string): string {
    if (!boxed.startsWith(PREFIX)) {
      throw new ExternalSecretError('Неизвестный формат зашифрованного пароля');
    }
    const raw = Buffer.from(boxed.slice(PREFIX.length), 'base64url');
    if (raw.length <= IV_LENGTH + TAG_LENGTH) {
      throw new ExternalSecretError('Зашифрованный пароль повреждён: слишком короткий');
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = raw.subarray(IV_LENGTH + TAG_LENGTH);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new ExternalSecretError(
        'Не удалось расшифровать пароль: задан другой EXTERNAL_ACCOUNTS_KEY или запись повреждена',
      );
    }
  }
}

export interface SecretBoxResult {
  box: ExternalSecretBox | null;
  /** Почему шифровальщика нет. null — он есть. */
  reason: string | null;
}

/**
 * Создаёт шифровальщик из переменной окружения.
 *
 * Отсутствие ключа — не авария для почты, но подключить чужой ящик без
 * него нельзя: класть пароль в базу открытым текстом мы не станем ни при
 * каких условиях. Маршрут в этом случае честно откажет.
 */
export function createSecretBox(secret: string | undefined): SecretBoxResult {
  if (!secret || secret.length === 0) {
    return {
      box: null,
      reason:
        'Не задана переменная окружения EXTERNAL_ACCOUNTS_KEY — пароли чужих ящиков хранить негде. ' +
        'Подключение внешних ящиков и переключение между своими будет недоступно.',
    };
  }
  try {
    return { box: new ExternalSecretBox(secret), reason: null };
  } catch (err) {
    return { box: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Хвост пароля не показываем вообще — в отличие от ключа доступа к ИИ,
 * пароль от чужого ящика опознавать не нужно: он один на подключение,
 * и подсказка только помогает подбору.
 */
export function passwordMask(): string {
  return '••••••••';
}
