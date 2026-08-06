/**
 * Своё оформление входа (OEM): логотип и название на страницах входа
 * в почту и в панель управления.
 *
 * Где лежит и почему не в базе. Логотип — файл, и живёт он файлом в
 * отдельном томе (BRANDING_DIR, том `api-branding` в docker-compose.yml).
 * Причины две:
 *
 *   1. Требование «переживает перезапуск контейнеров». Память отпадает
 *      сразу, каталог внутри образа — тоже: он исчезает при каждом
 *      обновлении продукта, а обновление делают чаще, чем меняют логотип.
 *   2. Отдача. Страница входа открыта всем, логотип запрашивается на
 *      каждый её показ. Файл читается с диска и отдаётся с отпечатком в
 *      адресе, поэтому браузер после первого раза его не перезапрашивает;
 *      картинка в базе означала бы запрос к Postgres на каждый вход.
 *
 * Имена файлов на диске задаём МЫ, а не тот, кто загружает: `logo.<ext>`,
 * где расширение выведено из содержимого (см. branding-image.ts). Ни одна
 * часть пути не приходит из запроса — перебирать чужие файлы через этот
 * маршрут нечем.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../errors.js';
import { inspectLogo, LOGO_FORMATS, type LogoFormat } from './branding-image.js';

/** Описание загруженного логотипа. Сам файл лежит рядом. */
export interface BrandingLogo {
  format: LogoFormat;
  mime: string;
  ext: string;
  width: number;
  height: number;
  size: number;
  /**
   * Отпечаток содержимого (12 знаков sha256). Уходит в адрес картинки
   * параметром `v`: браузер кэширует логотип надолго, а смена файла
   * меняет адрес — иначе после замены логотипа половина людей ещё сутки
   * видела бы старый и считала, что загрузка не сработала.
   */
  version: string;
  updatedAt: string;
}

/** Всё оформление разом. Пустые значения — «как у продукта по умолчанию». */
export interface BrandingState {
  /** Название компании: показывается под логотипом на входе. */
  companyName: string | null;
  /** Название сервиса: заменяет «Mail.True» в подписях, если задано. */
  productName: string | null;
  logo: BrandingLogo | null;
}

/** То же для резервной копии настроек: логотип едет байтами внутри JSON. */
export interface BrandingSnapshot extends BrandingState {
  /** Содержимое файла логотипа в base64. null — логотип стандартный. */
  logoBase64: string | null;
}

/**
 * Что нужно, чтобы восстановить оформление из копии.
 *
 * Описание логотипа (формат, размеры, отпечаток) сюда НЕ входит намеренно:
 * оно выводится заново из самих байтов при проверке. Верить описанию из
 * чужого файла — значит позволить ему объявить SVG «картинкой PNG 100×40».
 */
export interface BrandingRestoreInput {
  companyName: string | null;
  productName: string | null;
  logoBase64: string | null;
}

export const EMPTY_BRANDING: BrandingState = {
  companyName: null,
  productName: null,
  logo: null,
};

const META_FILE = 'branding.json';
const LOGO_BASE = 'logo';

/** Пределы на подписи. Длинное название ломает вёрстку карточки входа. */
export const BRANDING_NAME_MAX = 64;

export class BrandingStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private metaPath(): string {
    return join(this.dir, META_FILE);
  }

  private logoPath(ext: string): string {
    return join(this.dir, `${LOGO_BASE}.${ext}`);
  }

  /**
   * Текущее оформление. Нет файла или он испорчен — отдаём стандартное:
   * страница входа обязана открыться в любом случае, отказ здесь означал бы
   * «логотип битый — никто не войдёт».
   */
  async read(): Promise<BrandingState> {
    try {
      const raw = await readFile(this.metaPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<BrandingState>;
      return {
        companyName: typeof parsed.companyName === 'string' ? parsed.companyName : null,
        productName: typeof parsed.productName === 'string' ? parsed.productName : null,
        logo: isLogo(parsed.logo) ? parsed.logo : null,
      };
    } catch {
      return { ...EMPTY_BRANDING };
    }
  }

  /** Запись через временный файл: недописанный JSON не должен стать текущим. */
  private async writeState(state: BrandingState): Promise<BrandingState> {
    await this.init();
    const tmp = `${this.metaPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, this.metaPath());
    return state;
  }

  /** Байты логотипа и его описание. null — логотип не загружали. */
  async readLogo(): Promise<{ bytes: Buffer; logo: BrandingLogo } | null> {
    const state = await this.read();
    if (!state.logo) return null;
    try {
      const bytes = await readFile(this.logoPath(state.logo.ext));
      return { bytes, logo: state.logo };
    } catch {
      // Описание есть, файла нет — считаем, что логотипа нет вовсе.
      // Тихо отдать 404 лучше, чем 500 на странице входа.
      return null;
    }
  }

  /**
   * Сохраняет новый логотип. Проверка содержимого — здесь, а не только в
   * маршруте: тем же путём логотип приезжает из резервной копии, а копию
   * приносит человек файлом, то есть доверять ей нельзя ровно так же.
   */
  async saveLogo(bytes: Buffer): Promise<BrandingState> {
    const info = inspectLogo(bytes);
    await this.init();

    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const tmp = join(this.dir, `${LOGO_BASE}.${info.ext}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, this.logoPath(info.ext));

    // Прежний логотип другого формата убираем: два файла logo.* означали бы,
    // что после отката к старому описанию всплывёт чужая картинка.
    await this.removeLogoFiles(info.ext);

    const state = await this.read();
    return this.writeState({
      ...state,
      logo: {
        format: info.format,
        mime: info.mime,
        ext: info.ext,
        width: info.width,
        height: info.height,
        size: info.size,
        version,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  /** «Вернуть стандартный»: файл убираем, подписи не трогаем. */
  async resetLogo(): Promise<BrandingState> {
    await this.removeLogoFiles(null);
    const state = await this.read();
    return this.writeState({ ...state, logo: null });
  }

  /** Названия компании и сервиса. undefined — «не менять», null — «убрать». */
  async saveTexts(patch: {
    companyName?: string | null;
    productName?: string | null;
  }): Promise<BrandingState> {
    const state = await this.read();
    const next = { ...state };
    if (patch.companyName !== undefined)
      next.companyName = normalizeName(patch.companyName, 'компании');
    if (patch.productName !== undefined)
      next.productName = normalizeName(patch.productName, 'сервиса');
    return this.writeState(next);
  }

  /** Всё оформление для резервной копии настроек, вместе с байтами логотипа. */
  async exportSnapshot(): Promise<BrandingSnapshot> {
    const state = await this.read();
    const file = await this.readLogo();
    return { ...state, logoBase64: file ? file.bytes.toString('base64') : null };
  }

  /**
   * Оформление из резервной копии.
   *
   * Байты логотипа проходят ту же проверку, что и загрузка из браузера:
   * файл копии человек приносит откуда угодно, и «внутри копии» — не повод
   * пропустить SVG со скриптом на страницу входа.
   */
  async importSnapshot(snapshot: BrandingRestoreInput): Promise<BrandingState> {
    if (snapshot.logoBase64) {
      const bytes = Buffer.from(snapshot.logoBase64, 'base64');
      await this.saveLogo(bytes);
    } else {
      await this.resetLogo();
    }
    return this.saveTexts({
      companyName: snapshot.companyName ?? null,
      productName: snapshot.productName ?? null,
    });
  }

  /** Удаляет файлы логотипа, кроме указанного расширения. */
  private async removeLogoFiles(keepExt: string | null): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const allowed = new Set<string>(Object.values(LOGO_FORMATS).map((f) => f.ext));
    for (const name of names) {
      const [base, ext] = splitName(name);
      if (base !== LOGO_BASE || ext === null || !allowed.has(ext)) continue;
      if (ext === keepExt) continue;
      await unlink(join(this.dir, name)).catch(() => undefined);
    }
  }
}

function splitName(name: string): [string, string | null] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, null];
  return [name.slice(0, dot), name.slice(dot + 1)];
}

function isLogo(value: unknown): value is BrandingLogo {
  if (typeof value !== 'object' || value === null) return false;
  const logo = value as Partial<BrandingLogo>;
  return (
    typeof logo.ext === 'string' &&
    typeof logo.mime === 'string' &&
    typeof logo.version === 'string' &&
    typeof logo.width === 'number' &&
    typeof logo.height === 'number'
  );
}

/**
 * Название компании/сервиса: пустая строка — это «убрать», а не «сохранить
 * пустоту». Управляющие символы вырезаем: они невидимы, но ломают вёрстку
 * и путают того, кто потом смотрит на настройку.
 */
function normalizeName(value: string | null, what: string): string | null {
  if (value === null) return null;
  // Управляющие символы здесь — сам предмет разговора: строка чистится
  // именно от них, поэтому запрет на них в регулярном выражении снят
  // осознанно, а не потому, что мешал.
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  if (clean === '') return null;
  if (clean.length > BRANDING_NAME_MAX) {
    throw new BadRequestError(
      `Название ${what} длиной ${clean.length} знаков не поместится в карточку входа: ` +
        `предел ${BRANDING_NAME_MAX}.`,
    );
  }
  return clean;
}
