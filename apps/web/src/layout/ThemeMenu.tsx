/**
 * Переключатель темы в шапке.
 *
 * Раньше кнопка-палитра перебирала темы по кругу — с восемью темами так
 * жить нельзя. Теперь она открывает панель, где видны сразу ВСЕ варианты
 * с образцами цвета: кружок каждой темы показывает её фон и акцент.
 * Выбор применяется мгновенно, панель при этом не закрывается — так темы
 * удобно сравнивать; закрытие — щелчок мимо или Escape.
 *
 * Первый пункт — «Авто»: тема следует системной (prefers-color-scheme).
 * Ссылка внизу ведёт в настройки оформления, где темы показаны крупно
 * и настраивается фоновая картинка.
 */

import { useNavigate } from 'react-router-dom';
import { THEMES, type ThemeMeta } from '../appearance/themes';
import { useUiStore, type ThemeSetting } from '../app/store';
import { Dropdown, IconButton, MenuItem, MenuSeparator, Tooltip } from '../components';
import { cx } from '../lib/cx';
import styles from './ThemeMenu.module.css';

/** Кружок-образец: фон темы и её акцент по диагонали. */
function Swatch({ meta }: { meta: ThemeMeta | 'system' }) {
  if (meta === 'system') {
    // Половина светлая, половина тёмная — «как в системе»
    return (
      <span
        className={styles.swatch}
        style={{ background: 'linear-gradient(90deg, #ffffff 50%, #232324 50%)' }}
        aria-hidden="true"
      />
    );
  }
  const background =
    meta.kind === 'wallpaper'
      ? 'linear-gradient(160deg, #1e3c72 0%, #2a5298 45%, #6a85b6 100%)'
      : `linear-gradient(135deg, ${meta.contentBg} 0%, ${meta.contentBg} 55%, ${meta.accent} 55%)`;
  return <span className={styles.swatch} style={{ background }} aria-hidden="true" />;
}

const SYSTEM_TITLE = 'Авто';

export function themeSettingTitle(setting: ThemeSetting): string {
  if (setting === 'system') return SYSTEM_TITLE;
  return THEMES.find((t) => t.id === setting)?.title ?? setting;
}

export function ThemeMenu({ buttonClassName }: { buttonClassName?: string | undefined }) {
  const navigate = useNavigate();
  const themeSetting = useUiStore((s) => s.themeSetting);
  const setTheme = useUiStore((s) => s.setTheme);

  const options: readonly { value: ThemeSetting; title: string; meta: ThemeMeta | 'system' }[] = [
    { value: 'system', title: SYSTEM_TITLE, meta: 'system' },
    ...THEMES.map((meta) => ({ value: meta.id, title: meta.title, meta })),
  ];

  return (
    <Dropdown
      align="right"
      menuClassName={styles.panel}
      trigger={({ toggle }) => (
        <Tooltip text={`Тема: ${themeSettingTitle(themeSetting)}`}>
          <IconButton label="Тема оформления" onClick={toggle} className={buttonClassName}>
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
          const active = option.value === themeSetting;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              className={cx(styles.option, active && styles.optionActive)}
              // Меню не закрываем: выбор применяется сразу, темы удобно сравнивать
              onClick={() => setTheme(option.value)}
            >
              <Swatch meta={option.meta} />
              <span className={styles.optionTitle}>{option.title}</span>
            </button>
          );
        })}
      </div>
      <MenuSeparator />
      <MenuItem onClick={() => void navigate('/settings/appearance')}>
        Настройки оформления
      </MenuItem>
    </Dropdown>
  );
}
