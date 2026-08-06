/**
 * Настройки оформления: выбор темы (крупные карточки-предпросмотры)
 * и фоновая картинка «обойной» темы — готовые фоны, нарисованные кодом,
 * плюс своя картинка с устройства.
 *
 * Выбор темы и выбор фона хранятся ЗА УЧЁТНОЙ ЗАПИСЬЮ на сервере
 * (требование заказчика: «тема оформления должна запоминаться для каждого
 * юзера»), поэтому страница ничего не сохраняет сама — она вызывает те же
 * функции, что и панель тем в шапке, а отправкой занимается
 * src/appearance/sync.ts. Отдельной кнопки «Сохранить» здесь нет и не
 * должно быть: оформление применяется щелчком.
 *
 * Своя КАРТИНКА при этом остаётся в IndexedDB браузера — почему именно
 * там, объяснено в src/appearance/wallpapers.ts. Пользователю об этом
 * сказано подсказкой под загрузкой: за ящиком ездит выбор, а не файл.
 */

import { useEffect, useRef, useState } from 'react';
import { onWallpaperChange } from '../../appearance/cache';
import {
  clearCustomWallpaper,
  loadCustomWallpaperUrl,
  readWallpaperSelection,
  selectWallpaper,
  setCustomWallpaper,
  setWallpaperPreset,
  validateWallpaperFile,
  WALLPAPER_GROUPS,
  WALLPAPER_PRESETS,
  type WallpaperSelection,
} from '../../appearance/wallpapers';
import { THEMES, type ThemeMeta } from '../../appearance/themes';
import { useUiStore, type ThemeSetting } from '../../app/store';
import { Button } from '../../components';
import { cx } from '../../lib/cx';
import {
  SettingsError,
  SettingsHint,
  SettingsSection,
  SettingsTitle,
} from '../../settings/ui';
import styles from './AppearancePage.module.css';

/** Мини-окно почты в цветах темы: шапка, левое меню, карточка с текстом. */
function ThemePreview({ meta }: { meta: ThemeMeta | 'system' }) {
  if (meta === 'system') {
    // Системная — наполовину светлая, наполовину тёмная
    return (
      <span className={styles.preview} aria-hidden="true">
        <span className={styles.previewHalf}>
          <ThemePreview meta={THEMES[0]!} />
        </span>
        <span className={cx(styles.previewHalf, styles.previewHalfRight)}>
          <ThemePreview meta={THEMES[1]!} />
        </span>
      </span>
    );
  }
  const wallpaper = meta.kind === 'wallpaper';
  const pageBg = wallpaper
    ? 'linear-gradient(160deg, #1e3c72 0%, #2a5298 45%, #6a85b6 100%)'
    : meta.appBg;
  const headerBg = wallpaper ? 'rgba(0, 0, 0, 0.4)' : meta.contentBg;
  const lineColor = wallpaper ? 'rgba(255, 255, 255, 0.85)' : meta.textPrimary;
  return (
    <span className={styles.preview} style={{ background: pageBg }} aria-hidden="true">
      <span className={styles.previewHeader} style={{ background: headerBg }}>
        <span className={styles.previewDot} style={{ background: meta.accent }} />
      </span>
      <span className={styles.previewBody}>
        <span className={styles.previewNav}>
          <span className={styles.previewNavLine} style={{ background: lineColor }} />
          <span className={styles.previewNavLine} style={{ background: lineColor }} />
        </span>
        <span className={styles.previewCard} style={{ background: meta.contentBg }}>
          <span className={styles.previewLine} style={{ background: meta.accent, width: '52%' }} />
          <span className={styles.previewLine} style={{ background: meta.textPrimary, width: '80%' }} />
          <span className={styles.previewLine} style={{ background: meta.textPrimary, width: '64%' }} />
        </span>
      </span>
    </span>
  );
}

export function AppearancePage() {
  const themeSetting = useUiStore((s) => s.themeSetting);
  const setTheme = useUiStore((s) => s.setTheme);

  const [wallpaper, setWallpaper] = useState<WallpaperSelection>(() => readWallpaperSelection());
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /*
   * Выбранный фон могут сменить и мимо этой страницы: ответ сервера
   * приезжает после первого рендера, а вход другим пользователем стирает
   * кэш. Без подписки отметка «выбран» осталась бы от прошлого владельца —
   * на плитке одно, на фоне другое.
   */
  useEffect(() => onWallpaperChange(() => setWallpaper(readWallpaperSelection())), []);

  // Миниатюра своей картинки (если сохранена) — из IndexedDB
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void loadCustomWallpaperUrl().then((loaded) => {
      url = loaded;
      if (alive) setCustomUrl(loaded);
      else if (loaded) URL.revokeObjectURL(loaded);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  const themeOptions: readonly { value: ThemeSetting; title: string; meta: ThemeMeta | 'system' }[] =
    [
      { value: 'system', title: 'Как в системе', meta: 'system' },
      ...THEMES.map((meta) => ({ value: meta.id, title: meta.title, meta })),
    ];

  const pickPreset = (id: string): void => {
    setWallpaper({ kind: 'preset', id });
    void setWallpaperPreset(id);
    // Выбор фона означает желание его видеть — включаем «обойную» тему
    setTheme('wallpaper');
  };

  const pickCustom = (): void => {
    if (!customUrl) return;
    setWallpaper({ kind: 'custom' });
    void selectWallpaper({ kind: 'custom' });
    setTheme('wallpaper');
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const problem = validateWallpaperFile(file);
    if (problem) {
      setFileError(problem);
      return;
    }
    setFileError(null);
    try {
      await setCustomWallpaper(file);
    } catch {
      setFileError('Не получилось сохранить картинку в браузере');
      return;
    }
    setWallpaper({ kind: 'custom' });
    setCustomUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setTheme('wallpaper');
  };

  const removeCustom = async (): Promise<void> => {
    await clearCustomWallpaper();
    setWallpaper(readWallpaperSelection());
    setCustomUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  };

  return (
    <>
      <SettingsTitle>Оформление</SettingsTitle>

      <SettingsSection
        title="Тема"
        description="Действует сразу и запоминается за вашим ящиком — на другом компьютере тема будет та же. «Как в системе» повторяет светлую или тёмную тему операционной системы."
      >
        <div className={styles.themeGrid} role="radiogroup" aria-label="Тема оформления">
          {themeOptions.map((option) => {
            const active = option.value === themeSetting;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={cx(styles.themeCard, active && styles.themeCardActive)}
                onClick={() => setTheme(option.value)}
              >
                <ThemePreview meta={option.meta} />
                <span className={styles.themeTitle}>{option.title}</span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Фоновая картинка"
        description="Фон «обойной» темы. Выбор картинки сразу включает её: список писем, меню и настройки становятся полупрозрачными, и картинка видна сквозь них. Плотность подобрана так, чтобы текст читался на любом фоне."
      >
        {/*
          Плитки разложены по настроениям, а не одной кучей: двадцать восемь
          картинок подряд выбирать невозможно — глаз не за что зацепить.
          Своя картинка стоит в конце, отдельной группой, потому что она
          не про настроение, а про «моё».
        */}
        {WALLPAPER_GROUPS.map((group) => {
          const presets = WALLPAPER_PRESETS.filter((p) => p.group === group.id);
          if (presets.length === 0) return null;
          return (
            <div key={group.id} className={styles.wallpaperGroup}>
              <div className={styles.wallpaperGroupTitle} id={`wp-group-${group.id}`}>
                {group.title}
              </div>
              <div
                className={styles.wallpaperGrid}
                role="radiogroup"
                aria-labelledby={`wp-group-${group.id}`}
              >
                {presets.map((preset) => {
                  const active = wallpaper.kind === 'preset' && wallpaper.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={preset.title}
                      aria-label={`Фон «${preset.title}»`}
                      className={cx(styles.wallpaperTile, active && styles.wallpaperTileActive)}
                      // Плитка показывает МИНИАТЮРУ: иначе открытие раздела
                      // тянуло бы два десятка полноразмерных картинок
                      style={{ backgroundImage: preset.thumb }}
                      onClick={() => pickPreset(preset.id)}
                    >
                      <span className={styles.wallpaperTileTitle}>{preset.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {customUrl && (
          <div className={styles.wallpaperGroup}>
            <div className={styles.wallpaperGroupTitle} id="wp-group-custom">
              Своя картинка
            </div>
            <div
              className={styles.wallpaperGrid}
              role="radiogroup"
              aria-labelledby="wp-group-custom"
            >
              <button
                type="button"
                role="radio"
                aria-checked={wallpaper.kind === 'custom'}
                aria-label="Своя картинка"
                className={cx(
                  styles.wallpaperTile,
                  wallpaper.kind === 'custom' && styles.wallpaperTileActive,
                )}
                style={{ backgroundImage: `url("${customUrl}")` }}
                onClick={pickCustom}
              />
            </div>
          </div>
        )}

        <div className={styles.customRow}>
          <Button mode="secondary" onClick={() => fileInputRef.current?.click()}>
            Загрузить свою
          </Button>
          {customUrl && (
            <Button mode="tertiary" onClick={() => void removeCustom()}>
              Удалить свою картинку
            </Button>
          )}
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/*"
            aria-label="Файл фоновой картинки"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              // тот же файл можно выбрать повторно
              e.target.value = '';
            }}
          />
        </div>
        {fileError && <SettingsError>{fileError}</SettingsError>}
        <SettingsHint>
          Выбранный фон запоминается за ящиком. Сама загруженная картинка хранится в браузере на
          этом устройстве и на сервер не отправляется: на другом компьютере вместо неё покажется
          первый готовый фон. До 10 МБ, любой формат изображения.
        </SettingsHint>
      </SettingsSection>
    </>
  );
}
