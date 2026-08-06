/**
 * Переключатель темы — в ШАПКЕ панели, а не в настройках.
 *
 * Тема — это то, что меняют, увидев экран, а не то, что ищут по разделам:
 * закопанный в настройки переключатель означает «сменить нельзя». Кнопка
 * рядом с блоком администратора открывает панель, где сразу видны все темы
 * с образцами цвета — кружок показывает поверхность темы и её акцент.
 *
 * Выбор применяется мгновенно, меню при этом НЕ закрывается: темы удобно
 * сравнивать, не открывая список заново. Закрытие — щелчок мимо или Escape.
 * Выбранное запоминается между сеансами (appearance/themeStore.ts).
 *
 * Устройство повторяет переключатель почты (apps/web/src/layout/ThemeMenu):
 * одно приложение — один способ менять оформление.
 */

import { useSyncExternalStore } from 'react';
import { Dropdown, IconButton, Tooltip } from '@web/components';
import { cx } from '@web/lib/cx';
import {
  ADMIN_THEMES,
  adminThemeMeta,
  type AdminThemeMeta,
  type AdminThemeSetting,
} from '../appearance/adminThemes';
import { getAdminThemeSetting, setAdminTheme, subscribeAdminTheme } from '../appearance/themeStore';
import styles from './ThemeMenu.module.css';

const SYSTEM_TITLE = 'Как в системе';

/** Название выбранного — для подсказки на кнопке. */
export function adminThemeTitle(setting: AdminThemeSetting): string {
  return setting === 'system' ? SYSTEM_TITLE : adminThemeMeta(setting).title;
}

/**
 * Кружок-образец: поверхность темы и её акцент по диагонали. Цвета берутся
 * из реестра, а не задаются в стилях: образец обязан показывать ровно то,
 * что человек получит, выбрав тему.
 */
function Swatch({ meta }: { meta: AdminThemeMeta | 'system' }) {
  const background =
    meta === 'system'
      ? // Половина светлая, половина графитовая — «как в системе»
        `linear-gradient(90deg, ${adminThemeMeta('light').surface} 50%, ${
          adminThemeMeta('graphite').surface
        } 50%)`
      : `linear-gradient(135deg, ${meta.surface} 0%, ${meta.surface} 55%, ${meta.accent} 55%)`;
  return (
    <span
      className={styles.swatch}
      style={{ background, borderColor: meta === 'system' ? undefined : meta.surfaceAlt }}
      aria-hidden="true"
    />
  );
}

export function ThemeMenu({ className }: { className?: string | undefined }) {
  // Тему меняют из этого же меню, но знать о ней должны и другие места
  // (подсказка на кнопке, отметка выбранного) — поэтому внешнее хранилище,
  // а не состояние компонента.
  const setting = useSyncExternalStore(
    subscribeAdminTheme,
    getAdminThemeSetting,
    getAdminThemeSetting,
  );

  const options: readonly {
    value: AdminThemeSetting;
    title: string;
    meta: AdminThemeMeta | 'system';
  }[] = [
    ...ADMIN_THEMES.map((meta) => ({
      value: meta.id as AdminThemeSetting,
      title: meta.title,
      meta,
    })),
    { value: 'system' as AdminThemeSetting, title: SYSTEM_TITLE, meta: 'system' as const },
  ];

  return (
    <Dropdown
      align="right"
      className={className}
      menuClassName={styles.panel}
      trigger={({ toggle }) => (
        <Tooltip text={`Тема: ${adminThemeTitle(setting)}`}>
          <IconButton label="Тема оформления" onClick={toggle} className={styles.button}>
            {/* Палитра: понятна без подписи и не путается с шестерёнкой настроек */}
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M10 2a8 8 0 1 0 0 16c.94 0 1.35-.62 1.35-1.19 0-.32-.12-.6-.31-.85a1.5 1.5 0 0 1 1.17-2.46h1.61A4.18 4.18 0 0 0 18 9.32 7.7 7.7 0 0 0 10 2Zm-4.5 8.75a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm2.75-4a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm4.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"
                fill="currentColor"
              />
            </svg>
          </IconButton>
        </Tooltip>
      )}
    >
      <div className={styles.title}>Оформление</div>
      <div className={styles.grid} role="group" aria-label="Тема оформления">
        {options.map((option) => {
          const active = option.value === setting;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              className={cx(styles.option, active && styles.optionActive)}
              onClick={() => setAdminTheme(option.value)}
            >
              <Swatch meta={option.meta} />
              <span className={styles.optionTitle}>{option.title}</span>
            </button>
          );
        })}
      </div>
    </Dropdown>
  );
}
