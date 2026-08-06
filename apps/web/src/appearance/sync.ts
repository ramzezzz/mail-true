/**
 * Согласование оформления с сервером.
 *
 * Требование заказчика дословно: «тема оформления должна запоминаться для
 * каждого юзера». Раньше выбор лежал только в localStorage, то есть был
 * привязан к БРАУЗЕРУ: за другим компьютером тема сбрасывалась, а два
 * человека за одним браузером делили одну.
 *
 * Порядок применения — тот, что описан в требовании, и каждый шаг здесь
 * лечит свой дефект:
 *
 *   1. Кэш применён ещё до этого модуля — в main.tsx, из localStorage.
 *      Без него почта мигала бы светлой темой при каждой загрузке.
 *   2. `adoptAccount` сверяет, ЧЕЙ это кэш. Если вошёл другой человек,
 *      кэш стирается СРАЗУ, до запроса к серверу: иначе вошедший вторым
 *      секунду-другую смотрел бы на тему первого — ровно тот случай,
 *      ради которого всё и затевалось.
 *   3. Пришёл ответ сервера — применяем его и обновляем кэш.
 *
 * Отказ сервера ошибкой на экран не выносится. Оформление — не то, из-за
 * чего человеку показывают красную плашку: в худшем случае он видит тему
 * по умолчанию (чистый браузер) или ту, что уже была в кэше.
 */

import { normalizeThemeSetting, type AppearanceSettings } from '@mail-true/shared';
import { useMocks } from '../api/mockFlag';
import { apiFetch } from '../api/http';
import { cachedAccount, clearAppearanceCache, writeCachedAccount, writeCachedTheme } from './cache';
import { setAppearanceSink, type AppearancePatch } from './persist';
import { adoptWallpaperChoice, applyWallpaper, readWallpaperSelection } from './wallpapers';
import { applyTheme, resolveTheme, useUiStore } from '../app/store';

const ROUTE = '/api/settings/appearance';

/** Оформление ящика с сервера; null — сервер не ответил. */
async function fetchAppearance(): Promise<AppearanceSettings | null> {
  /*
   * На заглушках сервера нет, и хранить оформление негде — остаётся кэш
   * браузера, который к этому времени уже применён (main.tsx). Раньше
   * запрос всё-таки уходил, получал 404 и молча отбрасывался: работе это
   * не мешало, но каждая загрузка почты писала в консоль две ошибки —
   * ровно те, среди которых потом ищут настоящую.
   */
  if (useMocks) return null;
  try {
    return await apiFetch<AppearanceSettings>(ROUTE);
  } catch {
    // Сервер недоступен, миграция не применена, сессия кончилась —
    // для оформления это один и тот же случай: остаёмся на том, что есть.
    return null;
  }
}

/**
 * Применить тему, ПРИШЕДШУЮ С СЕРВЕРА.
 *
 * Не `setTheme`: тот отправляет выбор обратно на сервер, и каждая загрузка
 * почты писала бы в базу то, что только что оттуда прочитала.
 */
function adoptTheme(setting: AppearanceSettings['theme']): void {
  const theme = resolveTheme(setting);
  writeCachedTheme(setting);
  applyTheme(theme);
  useUiStore.setState({ themeSetting: setting, theme });
}

/**
 * Признать кэш своим или стереть чужой.
 *
 * Кэш без владельца (первый вход в этом браузере или обновление почты
 * с версии, где владельца не записывали) чужим НЕ считается: там лежит
 * либо пусто, либо собственный выбор того же человека, и отбирать его
 * ради строгости незачем — через мгновение всё равно приедет серверное.
 *
 * Возвращает true, если кэш был чужим и оформление сброшено к умолчанию.
 */
function adoptAccount(email: string): boolean {
  const owner = cachedAccount();
  const foreign = owner !== null && owner !== email.toLowerCase();
  // Порядок важен: сброс стирает и запись о владельце, поэтому имя
  // нового владельца пишется после него.
  if (foreign) resetAppearance();
  writeCachedAccount(email);
  return foreign;
}

/** Оформление по умолчанию: системная тема, первый готовый фон. */
function resetAppearance(): void {
  clearAppearanceCache();
  const theme = resolveTheme('system');
  applyTheme(theme);
  useUiStore.setState({ themeSetting: 'system', theme });
  void applyWallpaper(readWallpaperSelection());
}

/**
 * Согласовать оформление с сервером для вошедшего ящика.
 *
 * Вызывается из провайдера сессии при каждом её обновлении — то есть при
 * старте, входе, смене ящика. Ошибок наружу не выбрасывает.
 */
export async function syncAppearance(email: string): Promise<void> {
  adoptAccount(email);
  const remote = await fetchAppearance();
  if (!remote) return;
  // Ответ мог прийти от ПРОШЛОЙ сессии: между запросом и ответом человек
  // успевает выйти и войти другим. Применять такой ответ — значит снова
  // показать чужую тему, поэтому сверяем адрес.
  if (remote.email.toLowerCase() !== email.toLowerCase()) return;
  writeCachedAccount(email);

  const setting = normalizeThemeSetting(remote.theme);
  if (setting !== useUiStore.getState().themeSetting) adoptTheme(setting);
  // Фон применяем всегда: в кэше могла лежать та же строка, а картинка
  // на <html> — ещё нет (чистый браузер, первый кадр).
  await adoptWallpaperChoice(remote.wallpaper);
}

/**
 * Выход: оформление предыдущего не должно достаться следующему.
 *
 * Кэш стирается, а не остаётся «до входа»: на общем компьютере иначе
 * получилось бы то же, от чего уходили, — следующий видит чужую тему.
 */
export function forgetAppearance(): void {
  resetAppearance();
}

/**
 * Подключить отправку выбора на сервер.
 *
 * Вызывается один раз при загрузке модуля: приёмник глобальный, как и
 * само оформление. Запросы не ждутся и об ошибках не сообщают — выбор
 * уже применён на экране, а недоступный сервер не повод мешать работе;
 * при следующем входе просто приедет прежнее значение.
 */
setAppearanceSink((patch: AppearancePatch) => {
  // На заглушках отправлять некуда: выбор уже применён и лежит в кэше.
  if (useMocks) return;
  void apiFetch(ROUTE, { method: 'PUT', body: JSON.stringify(patch) }).catch(() => undefined);
});
