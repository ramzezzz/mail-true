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
  filename: string;
  mimeType: string;
  size: number;
  createdAt: number;
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
  async save(filename: string, mimeType: string, content: Readable): Promise<UploadMeta> {
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
      filename: filename || 'attachment',
      mimeType: mimeType || 'application/octet-stream',
      size,
      createdAt: Date.now(),
    };
    await writeFile(this.metaPath(id), JSON.stringify(meta), 'utf8');
    return meta;
  }

  /** Метаданные и путь к файлу по id (null, если нет). */
  async get(id: string): Promise<{ meta: UploadMeta; path: string } | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const raw = await readFile(this.metaPath(id), 'utf8');
      const meta = JSON.parse(raw) as UploadMeta;
      return { meta, path: this.binPath(id) };
    } catch {
      return null;
    }
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
      const found = await this.get(id);
      if (found && now - found.meta.createdAt > maxAgeMs) {
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
