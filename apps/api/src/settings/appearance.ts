/**
 * Оформление ящика: чтение и сохранение выбранной темы и фона.
 *
 * Требование заказчика дословно: «тема оформления должна запоминаться для
 * каждого юзера». До этого выбор лежал в localStorage браузера, то есть был
 * привязан к устройству: за другим компьютером тема сбрасывалась, а два
 * человека за одним браузером делили одну. Теперь она лежит в настройках
 * ящика (mail_user_settings.theme / .wallpaper, миграция 0009).
 *
 * Отдельный маршрут, а не поле в общих настройках, — по трём причинам:
 *
 *   1. Тема меняется ОДНИМ щелчком в шапке, а PUT /general — это вся форма
 *      настроек целиком, вместе с подписями и автоответчиком. Класть туда
 *      тему значило бы при каждом щелчке по палитре переписывать подписи
 *      и пересобирать файл Sieve.
 *   2. Контракт /general повторяет форму интерфейса и им же правит админка
 *      (apps/api/src/admin/user-settings.ts) — расширять его ради темы
 *      нельзя, не задев админку.
 *   3. Ответ несёт АДРЕС ящика. Почта по нему решает, её ли это кэш:
 *      вход другим пользователем на том же компьютере обязан показать ЕГО
 *      тему, а не предыдущую.
 *
 * Байты пользовательской картинки сюда не попадают — здесь только короткий
 * выбор ('preset:<id>' | 'custom'); почему так, объяснено в шапке
 * packages/shared/src/appearance.ts.
 */
import {
  normalizeThemeSetting,
  normalizeWallpaperChoice,
  type AppearanceSettings,
} from '@mail-true/shared';
import type { SettingsDb } from './db.js';
import type { MailSettings, MailSettingsPatch } from './types.js';

/** Настройки ящика -> ответ маршрута оформления. */
export function toWebAppearance(settings: MailSettings): AppearanceSettings {
  return {
    email: settings.accountEmail,
    theme: normalizeThemeSetting(settings.theme),
    wallpaper: normalizeWallpaperChoice(settings.wallpaper),
  };
}

/**
 * Тело запроса -> заплатка настроек.
 *
 * Переданы могут быть оба поля или одно: тему меняют из шапки, фон — со
 * страницы оформления, и второе поле в этот момент трогать нельзя.
 * Нераспознанное значение не отвергается ошибкой, а приводится к
 * умолчанию: тема — вещь, из-за которой пользователь не должен видеть
 * отказ; худшее, что тут может случиться, — оформление по умолчанию.
 */
export function fromWebAppearance(body: unknown): MailSettingsPatch {
  const patch: MailSettingsPatch = {};
  if (!body || typeof body !== 'object') return patch;
  const rec = body as Record<string, unknown>;
  if (rec['theme'] !== undefined) patch.theme = normalizeThemeSetting(rec['theme']);
  if (rec['wallpaper'] !== undefined) patch.wallpaper = normalizeWallpaperChoice(rec['wallpaper']);
  return patch;
}

/** Оформление ящика из базы. */
export async function getAppearance(db: SettingsDb, email: string): Promise<AppearanceSettings> {
  return toWebAppearance(await db.getSettings(email));
}

/**
 * Сохраняет оформление и возвращает то, что реально записалось.
 *
 * Пустая заплатка (в теле не было ни одного знакомого поля) до базы не
 * доходит: смысла в записи нет, а `updated_at` она бы обновила.
 */
export async function saveAppearance(
  db: SettingsDb,
  email: string,
  body: unknown,
): Promise<AppearanceSettings> {
  const patch = fromWebAppearance(body);
  if (patch.theme === undefined && patch.wallpaper === undefined) {
    return getAppearance(db, email);
  }
  return toWebAppearance(await db.saveSettings(email, patch));
}
