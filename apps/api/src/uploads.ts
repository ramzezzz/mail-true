/**
 * Временное хранилище загруженных вложений (до отправки письма).
 * Файлы лежат в UPLOAD_DIR: <id>.bin + <id>.json (метаданные).
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { FileTooLargeError } from './errors.js';

export interface UploadMeta {
  id: string;
  /**
   * Ящик, который эту загрузку сделал.
   *
   * Раньше владельца не было вовсе: файл лежал под случайным именем, и
   * любой вошедший, назвав чужой идентификатор, прикладывал чужое
   * вложение к своему письму. Идентификатор — не секрет: он уходит в
   * ответ, живёт в черновике и в журналах.
   */
  owner: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: number;
  /**
   * Когда загрузку в последний раз пустили в дело (см. `touch`).
   *
   * Уборщик считает срок от НЕЁ, а не от createdAt. Иначе картинка
   * дописываемого черновика умирала ровно через сутки после первого
   * открытия — а веб-почту держат открытой сутками. Дальше следующее
   * автосохранение клало в ящик письмо уже без картинки, исходный
   * черновик с MIME-частью к тому моменту был удалён предыдущим
   * сохранением, и восстановить её было неоткуда.
   */
  usedAt?: number;
}

/** Загрузки этого ящика больше не помещаются в отведённое место. */
export class UploadQuotaError extends FileTooLargeError {
  constructor(message: string) {
    super(message);
  }
}

const ID_RE = /^[0-9a-f-]{36}$/i;

export class UploadStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private binPath(id: string): string {
    return join(this.dir, `${id}.bin`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Сохраняет поток в файл, возвращает метаданные.
   *
   * Отклонённая загрузка не должна оставлять на диске ничего. Раньше файл
   * писался до тех пор, пока не срабатывало ограничение размера, а дальше
   * поток падал с ошибкой — и недописанный `.bin` оставался лежать навсегда:
   * уборщик `sweep()` обходил только `.json`, которых у отклонённой загрузки
   * не бывает. Три отклонённых запроса по 27 МБ добавляли 78 МБ мусора; при
   * 300 запросах в минуту это простой способ забить диск.
   */
  async save(
    owner: string,
    filename: string,
    mimeType: string,
    content: Readable,
  ): Promise<UploadMeta> {
    const id = randomUUID();
    const path = this.binPath(id);
    try {
      await pipeline(content, createWriteStream(path));
      // Ограничение размера могло сработать и без ошибки потока —
      // тогда файл просто обрезан, и принимать его нельзя
      if ((content as Readable & { truncated?: boolean }).truncated) {
        throw new FileTooLargeError();
      }
    } catch (err) {
      await unlink(path).catch(() => undefined);
      throw err;
    }
    const { size } = await stat(path);
    const meta: UploadMeta = {
      id,
      owner,
      filename: filename || 'attachment',
      mimeType: mimeType || 'application/octet-stream',
      size,
      createdAt: Date.now(),
    };
    await writeFile(this.metaPath(id), JSON.stringify(meta), 'utf8');
    return meta;
  }

  /**
   * Метаданные и путь к файлу по id (null, если нет).
   *
   * `owner` обязателен: чужая загрузка для этого ящика — то же самое, что
   * несуществующая. Отвечать «не найдено», а не «нельзя», здесь правильно:
   * иначе по разнице ответов можно перебором узнавать чужие
   * идентификаторы.
   *
   * Загрузки, сделанные до появления владельца (в метаданных его нет),
   * достаются любому вошедшему — как и раньше. Ломать письмо, которое
   * человек пишет прямо сейчас, ради суточных файлов не стоит: уборщик
   * унесёт их сам.
   */
  async get(id: string, owner: string): Promise<{ meta: UploadMeta; path: string } | null> {
    const found = await this.read(id);
    if (!found) return null;
    if (found.meta.owner !== undefined && found.meta.owner !== owner) return null;
    return found;
  }

  /** Метаданные без сверки владельца — для своих же нужд (уборка). */
  private async read(id: string): Promise<{ meta: UploadMeta; path: string } | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const raw = await readFile(this.metaPath(id), 'utf8');
      const meta = JSON.parse(raw) as UploadMeta;
      return { meta, path: this.binPath(id) };
    } catch {
      return null;
    }
  }

  /**
   * Сколько байт этот ящик уже занял незавершёнными загрузками.
   *
   * Считается по метаданным, а не по диску: файл без `.json` — это
   * оборванная загрузка, её унесёт уборщик, и держать из-за неё место
   * занятым нельзя.
   */
  async usedBy(owner: string): Promise<number> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let used = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as UploadMeta;
        if (meta.owner === owner) used += meta.size;
      } catch {
        /* битые метаданные считать нечем */
      }
    }
    return used;
  }

  /**
   * Отмечает, что загрузка пущена в дело: срок жизни считается заново.
   *
   * Зовётся при каждой сборке письма из тела, где на неё есть ссылка
   * (mail/inline-uploads.ts), — то есть при каждом автосохранении
   * черновика с картинкой. Пока человек пишет письмо, картинка не
   * умрёт под ним, сколько бы суток окно ни было открыто.
   *
   * Ошибки намеренно проглатываются: не продлить срок — мелочь, а
   * уронить из-за этого сохранение письма нельзя.
   */
  async touch(id: string): Promise<void> {
    const found = await this.read(id);
    if (!found) return;
    const meta: UploadMeta = { ...found.meta, usedAt: Date.now() };
    await writeFile(this.metaPath(id), JSON.stringify(meta), 'utf8').catch(() => undefined);
  }

  async delete(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await unlink(this.binPath(id)).catch(() => undefined);
    await unlink(this.metaPath(id)).catch(() => undefined);
  }

  /**
   * Удаляет файлы старше maxAgeMs (по умолчанию сутки).
   * Отдельно подчищает `.bin` без метаданных — следы прерванных загрузок:
   * раньше уборщик их не видел вовсе и они лежали вечно.
   */
  async sweep(maxAgeMs = 24 * 3600 * 1000): Promise<number> {
    let removed = 0;
    const now = Date.now();
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }

    const withMeta = new Set<string>();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      withMeta.add(id);
      const found = await this.read(id);
      // Срок считается от последнего использования, а не от создания:
      // иначе картинка открытого черновика умирает под пишущим человеком
      const since = found ? Math.max(found.meta.createdAt, found.meta.usedAt ?? 0) : 0;
      if (found && now - since > maxAgeMs) {
        await this.delete(id);
        removed += 1;
      }
    }

    // Загрузка занимает секунды: `.bin` без `.json` старше часа — точно мусор
    const orphanAgeMs = Math.min(maxAgeMs, 3600 * 1000);
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      const id = name.slice(0, -4);
      if (withMeta.has(id)) continue;
      const path = join(this.dir, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs <= orphanAgeMs) continue;
        await unlink(path);
        removed += 1;
      } catch {
        /* файл уже удалён */
      }
    }
    return removed;
  }
}
