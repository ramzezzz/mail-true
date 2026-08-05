/**
 * Задание импорта ящиков из CSV: результат переживает обрыв связи.
 *
 * ЧТО БЫЛО. Импорт выполнялся прямо в обработчике запроса и отдавал
 * результат единственный раз — в теле ответа. По замеру 300 строк
 * занимают 5.2 с, то есть 5000 строк — около 87 секунд при пределе
 * ожидания nginx в 120 секунд: запаса почти нет. А главное, в теле ответа
 * лежали СГЕНЕРИРОВАННЫЕ ПАРОЛИ, и больше нигде: оборвалась связь,
 * закрылась вкладка, кончилось терпение у прокси — ящики созданы,
 * паролей нет ни у кого и восстановить их нельзя, в базе только хэш.
 *
 * КАК СДЕЛАНО. Импорт стал заданием: строка создаётся до начала работы,
 * результат дописывается ПО ХОДУ создания ящиков (каждые несколько строк
 * и в конце), и его можно забрать отдельным запросом сколько угодно раз.
 * Обрыв связи теперь не значит ничего: задание доработает, а результат
 * будет лежать и ждать.
 *
 * Пароли шифруются (AES-256-GCM, ключ выводится из ADMIN_SESSION_SECRET
 * или SESSION_SECRET и в базе не лежит) и живут ограниченный срок —
 * просроченные задания удаляет уборщик. Если секрета нет вовсе,
 * пароли не сохраняются: лучше отдать одни счётчики, чем положить
 * пароль в базу открытым.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Что импорт создал и чего не создал. Именно это лежит в шифротексте. */
export interface ImportJobResult {
  created: Array<{ email: string; generatedPassword: string | null }>;
  failed: Array<{ line: number; email: string; error: string }>;
}

/**
 * Шифровальщик результата импорта. Отдельная соль от почтовой сессии:
 * из одного и того же секрета получаются разные ключи, и утечка одного
 * не открывает другое.
 */
export class ImportSecretBox {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (secret.length === 0) throw new Error('Пустой секрет: шифровать результат импорта нечем');
    this.#key = scryptSync(secret, 'mail-true-admin-import-v1', 32);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  decrypt(boxed: string): string {
    const raw = Buffer.from(boxed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, IV_LENGTH));
    decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** null, если секрета нет: тогда пароли не сохраняются вовсе. */
export function createImportBox(secret: string): ImportSecretBox | null {
  return secret.length > 0 ? new ImportSecretBox(secret) : null;
}

export function packResult(box: ImportSecretBox | null, result: ImportJobResult): string | null {
  if (!box) return null;
  return box.encrypt(JSON.stringify(result));
}

/** Разбирает шифротекст обратно. Непрочитанный результат — не авария. */
export function unpackResult(box: ImportSecretBox | null, boxed: string | null): ImportJobResult | null {
  if (!box || !boxed) return null;
  try {
    const parsed = JSON.parse(box.decrypt(boxed)) as ImportJobResult;
    if (!Array.isArray(parsed.created) || !Array.isArray(parsed.failed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
