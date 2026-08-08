/**
 * Генератор слоя дизайн-токенов.
 *
 * Читает brand/reference/design-tokens-raw.json (полная выгрузка CSS-переменных
 * с живого e.mail.ru, ~1500 переменных) и порождает:
 *
 *   src/styles/tokens.css      — отобранное подмножество в нашем пространстве
 *                                имён --mt-* (значения :root, светлая тема);
 *   src/styles/tokens.map.json — карта соответствия «наше имя → исходное имя»,
 *                                чтобы всегда было видно, откуда взят токен.
 *
 * Принцип отбора: включаем всё осмысленное для почтового интерфейса (цвета,
 * типографика, размеры, отступы, тени, анимации, слой octavius и портальную
 * шапку --ph-*) и выбрасываем мусор: палитры соцсетей, 90 цветов тегов,
 * тематические тултипы, рекламные и промо-токены, внутренние z-index VKUI.
 *
 * ВАЖНО: выгрузка сделана при включённой «обойной» теме оформления, поэтому
 * токены сайдбара/шапки в ней «обойные» (белый текст поверх картинки).
 * Обычная светлая и тёмная темы переопределяются в src/styles/themes.css.
 *
 * Запуск: node scripts/build-tokens.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_PATH = join(HERE, '../../../brand/reference/design-tokens-raw.json');
const OUT_CSS = join(HERE, '../src/styles/tokens.css');
const OUT_MAP = join(HERE, '../src/styles/tokens.map.json');

/* ------------------------------------------------------------------ */
/* Фильтры: что заведомо не берём                                      */
/* ------------------------------------------------------------------ */

/** Мусорные семейства — исключаются до любых переименований. */
export const EXCLUDE_PATTERNS = [
  /^--vkui_internal/, //            внутренние z-index и служебные штуки VKUI
  /^--vkui--color_palette/, //      сырая палитра (54 шт.) — работаем семантикой
  /^--vkui--color_tag_/, //         90 цветов пользовательских тегов — пока не нужны
  /^--vkui--color_social_/, //      цвета соцсетей
  /^--vkui--color_avatar_/, //      градиенты аватаров VK
  /^--vkui--color_tooltip_text_\w+_themed/, // 24 тематических цвета тултипов
  /^--vkui--color_rating/, //       рейтинги — не про почту
  /^--vkui--theme_name/, //         строковые имена темы
  /^--vkui--colors_scheme/, //      'light' — задаём сами через data-theme
  /adv|promo|marusia/, //           реклама и промо (llc_adv, promo-баннеры)
  /^--ph-custom-color-social-/, //  соцкнопки портальной шапки
  /^--ph-custom-portal-/, //        портальные виджеты (облако и т. п.)
  /^--ph-home-/, //                 главная страница портала
  /^--calls-logo|^--logo-/, //      URL логотипов с CDN mail.ru
  /^--column-right/, //             правая рекламная колонка — не делаем
  /^--operand-height/, //           операнды поисковых фильтров — до поиска далеко
  /^--vkui-lft-sidebar-bg/, //      залипший токен старой темы
  /*
   * Две «мины» из «обойной» выгрузки. Выгрузка снята при теме с фоновой
   * картинкой, и у этих двух семейств БАЗОВОЕ значение оттуда белое, а
   * ступени --hover/--active — из обычной светлой темы:
   *
   *   octavius_color_sidebar_item_text_secondary  #fff .64 / #82848C / #7C7F88
   *   octavius_color_sidebar_icon_unread          #ffffff / #0073F7 / #006FEF
   *
   * То есть внутри одного семейства значения из РАЗНЫХ тем. В приложении их
   * никто не использует (левое меню знает только семантику --mt-sidebar-*
   * из themes.css), но первый же, кто возьмёт базовое значение, получит
   * белый текст на белом в светлой теме. Убираем целиком, вместе со
   * ступенями: чинить внутри сгенерированного слоя нечего — там нет
   * ни одной темы, а только сырой снимок одной из них.
   */
  /^--vkui--octavius_color_sidebar_item_text_secondary/,
  /^--vkui--octavius_color_sidebar_icon_unread/,
];

/* ------------------------------------------------------------------ */
/* Переименование                                                       */
/* ------------------------------------------------------------------ */

/**
 * Суффиксы состояний в конце имени: '--hover' → '-hover', '--focus' → '-focus',
 * а '--active' (в VKUI это НАЖАТИЕ) → '-press', чтобы не путался со
 * структурным '_active' (выбранный элемент, например активная папка).
 */
function stateSuffix(name) {
  const m = name.match(/--(hover|active|focus)$/);
  if (!m) return { base: name, state: '' };
  const state = m[1] === 'active' ? '-press' : `-${m[1]}`;
  return { base: name.slice(0, -m[0].length), state };
}

const slug = (s) => s.replace(/_/g, '-').replace(/-{3,}/g, '--');

/** Свойства составных шрифтовых токенов VKUI → короткие имена. */
const FONT_PROP = {
  font_size: 'size',
  line_height: 'line-height',
  font_weight: 'weight',
  font_family: 'family',
  letter_spacing: 'letter-spacing',
  text_transform: 'transform',
};

/** Явные соответствия для одиночных переменных слоя приложения. */
export const LAYOUT_MAP = {
  '--headline-height': '--mt-layout-header-height',
  '--headline-promo-height': '--mt-layout-header-promo-height',
  '--leftnav-width': '--mt-layout-sidebar-width',
  '--sidebar-folders-header-height': '--mt-layout-sidebar-header-height',
  '--panel-height-normal': '--mt-layout-toolbar-height',
  '--panel-height-compact': '--mt-layout-toolbar-height-compact',
  '--app-top-offset': '--mt-layout-app-top-offset',
  '--octavius--padding_maincontent': '--mt-layout-maincontent-padding',
  '--list-letter-die-width': '--mt-layout-list-die-width',
  '--list-letter-die-margin-left': '--mt-layout-list-die-margin-left',
  '--list-letter-die-button-horizontal-padding': '--mt-layout-list-die-button-padding-x',
  '--list-letter-compact-header': '--mt-layout-list-compact-header',
  '--list-letter-compact-header-pony': '--mt-layout-list-compact-header-pony',
  '--letter-swipe-actions-width': '--mt-layout-letter-swipe-actions-width',
};

/**
 * Переименовывает исходную переменную в пространство --mt-*.
 * Возвращает { name, group } или null, если переменную не берём.
 */
export function renameToken(source) {
  if (EXCLUDE_PATTERNS.some((re) => re.test(source))) return null;

  if (source in LAYOUT_MAP) return { name: LAYOUT_MAP[source], group: 'layout' };

  const { base, state } = stateSuffix(source);
  let m;

  /* Слой octavius (мейловая надстройка над VKUI) → --mt-mail-* */
  if ((m = base.match(/^--vkui--octavius_(.+)$/))) {
    let rest = m[1];
    // размерные токены имеют режимы --regular/--compact; берём только regular
    if (/--compact$/.test(rest)) return null;
    rest = rest.replace(/--regular$/, '');
    return { name: `--mt-mail-${slug(rest)}${state}`, group: 'mail' };
  }

  /* Семантические цвета VKUI → --mt-color-* */
  if ((m = base.match(/^--vkui--color_(.+)$/))) {
    return { name: `--mt-color-${slug(m[1])}${state}`, group: 'color' };
  }

  /* Составные шрифтовые роли: --vkui--font_<роль>--<свойство>--regular */
  if ((m = base.match(/^--vkui--font_(\w+?)--(\w+)--(regular|compact)$/))) {
    if (m[3] === 'compact') return null; // компактный режим не воспроизводим
    const prop = FONT_PROP[m[2]] ?? slug(m[2]);
    return { name: `--mt-font-${slug(m[1])}-${prop}`, group: 'font' };
  }

  /* Простые шрифтовые токены: семейства и насыщенности */
  if ((m = base.match(/^--vkui--font_(family|weight)_(.+)$/))) {
    return { name: `--mt-font-${m[1]}-${slug(m[2])}${state}`, group: 'font' };
  }

  /* Размеры: --vkui--size_*--regular */
  if ((m = base.match(/^--vkui--size_(.+?)--(regular|compact)$/))) {
    if (m[2] === 'compact') return null;
    return { name: `--mt-size-${slug(m[1])}${state}`, group: 'size' };
  }

  /* Шкала отступов: --vkui--x05 … --vkui--x12 и spacing_size_* */
  if ((m = base.match(/^--vkui--x(\d+|05)$/))) {
    return { name: `--mt-space-x${m[1]}`, group: 'space' };
  }
  if ((m = base.match(/^--vkui--spacing_size_(.+)$/))) {
    return { name: `--mt-space-${slug(m[1])}`, group: 'space' };
  }

  /* Тени-высоты */
  if ((m = base.match(/^--vkui--elevation(\d)$/))) {
    return { name: `--mt-elevation-${m[1]}`, group: 'effect' };
  }

  /* Анимация */
  if ((m = base.match(/^--vkui--animation_(.+)$/))) {
    return { name: `--mt-anim-${slug(m[1])}`, group: 'effect' };
  }

  /* Прочие простые группы VKUI: прозрачности, блюр, градиенты, z-index */
  if (
    (m = base.match(/^--vkui--(opacity|blur|gradient|tone_value|z_index|type_border)(?:_(.+))?$/))
  ) {
    const tail = m[2] ? `-${slug(m[2])}` : '';
    return { name: `--mt-${slug(m[1])}${tail}${state}`, group: 'effect' };
  }

  /* Портальная шапка --ph-* — имена уже дефисные, просто префиксуем */
  if ((m = base.match(/^--ph-(.+)$/))) {
    return { name: `--mt-ph-${m[1]}${state}`, group: 'ph' };
  }

  return null; // всё неопознанное не тащим
}

/**
 * Переписывает ссылки var(--исходное-имя) внутри значения на новые имена.
 * Неизвестные ссылки остаются как были (падение на fallback).
 */
export function rewriteValue(value, mapping) {
  return value.replace(/var\((--[\w-]+)/g, (full, ref) =>
    mapping.has(ref) ? `var(${mapping.get(ref)}` : full,
  );
}

/**
 * Основной отбор: вход — объект { исходноеИмя: значение },
 * выход — { tokens: Map<новоеИмя, {value, source, group}>, collisions: [] }.
 */
export function selectTokens(rawVars) {
  const tokens = new Map();
  const sourceToNew = new Map();
  const collisions = [];

  for (const [source, value] of Object.entries(rawVars)) {
    if (String(value).trim() === '') continue; // пустые значения (есть в выгрузке) не тащим
    const renamed = renameToken(source);
    if (!renamed) continue;
    if (tokens.has(renamed.name)) {
      collisions.push({ name: renamed.name, source, existing: tokens.get(renamed.name).source });
      continue;
    }
    tokens.set(renamed.name, { value: String(value).trim(), source, group: renamed.group });
    sourceToNew.set(source, renamed.name);
  }

  // второй проход: переписываем var()-ссылки внутри значений
  for (const entry of tokens.values()) {
    entry.value = rewriteValue(entry.value, sourceToNew);
  }

  return { tokens, collisions };
}

/* ------------------------------------------------------------------ */
/* Генерация файла                                                     */
/* ------------------------------------------------------------------ */

const GROUP_TITLES = {
  color: 'Семантические цвета VKUI (--vkui--color_*)',
  mail: 'Мейловый слой octavius (--vkui--octavius_*)',
  ph: 'Портальная шапка (--ph-*)',
  font: 'Типографика (--vkui--font_*)',
  size: 'Размеры (--vkui--size_*)',
  space: 'Шкала отступов (--vkui--x*, spacing_size_*)',
  effect: 'Тени, анимация, прозрачности (--vkui--elevation*, animation_*, …)',
  layout: 'Каркас приложения (одиночные переменные слоя приложения)',
};

export function generateCss(tokens) {
  const byGroup = new Map(Object.keys(GROUP_TITLES).map((g) => [g, []]));
  for (const [name, entry] of tokens) byGroup.get(entry.group).push([name, entry.value]);

  let css = `/*
 * СГЕНЕРИРОВАНО СКРИПТОМ — НЕ ПРАВИТЬ РУКАМИ.
 * Источник: brand/reference/design-tokens-raw.json (выгрузка с живого e.mail.ru).
 * Генератор: apps/web/scripts/build-tokens.mjs.
 * Карта соответствия «--mt-* → исходное имя»: src/styles/tokens.map.json.
 *
 * Выгрузка снята при включённой «обойной» теме, поэтому кластер sidebar/header
 * здесь «обойный»; обычные светлая/тёмная темы переопределяются в themes.css.
 */
:root {\n`;

  for (const [group, list] of byGroup) {
    if (list.length === 0) continue;
    list.sort(([a], [b]) => a.localeCompare(b));
    css += `\n  /* === ${GROUP_TITLES[group]} — ${list.length} шт. === */\n`;
    for (const [name, value] of list) css += `  ${name}: ${value};\n`;
  }
  css += '}\n';
  return css;
}

export function generateMap(tokens) {
  const map = {};
  for (const [name, entry] of [...tokens].sort(([a], [b]) => a.localeCompare(b))) {
    map[name] = entry.source;
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Точка входа                                                          */
/* ------------------------------------------------------------------ */

function main() {
  const raw = JSON.parse(readFileSync(RAW_PATH, 'utf8'));
  const rawVars = raw.cssVars?.root;
  if (!rawVars) throw new Error('В выгрузке нет cssVars.root — формат изменился?');

  const { tokens, collisions } = selectTokens(rawVars);
  if (collisions.length > 0) {
    console.warn('Коллизии имён (пропущены):');
    for (const c of collisions) console.warn(`  ${c.name}: ${c.source} vs ${c.existing}`);
  }

  mkdirSync(dirname(OUT_CSS), { recursive: true });
  writeFileSync(OUT_CSS, generateCss(tokens), 'utf8');
  writeFileSync(OUT_MAP, JSON.stringify(generateMap(tokens), null, 2) + '\n', 'utf8');

  const total = Object.keys(rawVars).length;
  console.log(`Отобрано ${tokens.size} токенов из ${total} (${collisions.length} коллизий).`);
  console.log(`→ ${OUT_CSS}`);
  console.log(`→ ${OUT_MAP}`);
}

// запускаем только при прямом вызове (не при импорте из тестов)
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
) {
  main();
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
