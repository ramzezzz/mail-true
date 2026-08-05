/**
 * Значки почты. Основной набор — фирменный спрайт Mail.True
 * (brand/icons/sprite.svg, скопирован в public/brand/icons): сетка 24×24,
 * штрих 1.8, цвет наследуется через currentColor (см. docs/brand.md).
 * Значков, которых нет в спрайте, — минимум, они нарисованы встроенно
 * в той же стилистике.
 */

interface IconProps {
  size?: number;
}

const SPRITE = '/brand/icons/sprite.svg';

/** Значок из фирменного спрайта: `<use href="sprite.svg#icon-<имя>">`. */
function BrandIcon({ name, size = 16 }: IconProps & { name: string }) {
  return (
    <svg width={size} height={size} aria-hidden="true">
      <use href={`${SPRITE}#icon-${name}`} />
    </svg>
  );
}

/* --- Фирменные значки -------------------------------------------------- */

export const IconTrash = (p: IconProps = {}) => <BrandIcon name="delete" {...p} />;
export const IconArchive = (p: IconProps = {}) => <BrandIcon name="archive" {...p} />;
export const IconFolder = (p: IconProps = {}) => <BrandIcon name="move-to-folder" {...p} />;
export const IconSpam = (p: IconProps = {}) => <BrandIcon name="folder-spam" {...p} />;
export const IconReply = (p: IconProps = {}) => <BrandIcon name="reply" {...p} />;
export const IconReplyAll = (p: IconProps = {}) => <BrandIcon name="reply-all" {...p} />;
export const IconForward = (p: IconProps = {}) => <BrandIcon name="forward" {...p} />;
export const IconMailRead = (p: IconProps = {}) => <BrandIcon name="read" {...p} />;
export const IconMailUnread = (p: IconProps = {}) => <BrandIcon name="unread" {...p} />;
/**
 * «Важное» — закладка-лента, как у mail.ru (research/mailru/01-inbox.png:
 * красная лента 14×13 в колонке флажка, цвет #FC2C38). Контурная — в меню
 * и на панели («Пометить флажком»), сплошная — в строке уже помеченного
 * письма.
 */
export const IconFlag = (p: IconProps = {}) => <BrandIcon name="important" {...p} />;
export const IconFlagFilled = (p: IconProps = {}) => <BrandIcon name="important-filled" {...p} />;
export const IconLabel = (p: IconProps = {}) => <BrandIcon name="label" {...p} />;
export const IconAttach = (p: IconProps = {}) => <BrandIcon name="attach" {...p} />;
export const IconPrint = (p: IconProps = {}) => <BrandIcon name="print" {...p} />;
export const IconSearch = (p: IconProps = {}) => <BrandIcon name="search" {...p} />;
export const IconCompose = (p: IconProps = {}) => <BrandIcon name="compose" {...p} />;
export const IconSettings = (p: IconProps = {}) => <BrandIcon name="settings" {...p} />;

/** Значок папки по её роли (для левого меню и списков папок). */
export function IconFolderRole({
  role,
  size = 16,
}: IconProps & { role: string }) {
  const known = ['inbox', 'sent', 'drafts', 'spam', 'trash', 'archive'];
  const name = known.includes(role) ? `folder-${role}` : 'move-to-folder';
  return <BrandIcon name={name} size={size} />;
}

/* --- Встроенные значки (в спрайте аналогов нет) ------------------------ */

function stroke(paths: string[], { size = 16 }: IconProps = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const IconMore = (p: IconProps = {}) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M5.2 12a1.7 1.7 0 1 1 3.4 0 1.7 1.7 0 0 1-3.4 0Zm5.1 0a1.7 1.7 0 1 1 3.4 0 1.7 1.7 0 0 1-3.4 0Zm6.8-1.7a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Z"
      fill="currentColor"
    />
  </svg>
);

export const IconArrowLeft = (p: IconProps = {}) => stroke(['M14.5 5.5 8 12l6.5 6.5'], p);

export const IconArrowRight = (p: IconProps = {}) => stroke(['M9.5 5.5 16 12l-6.5 6.5'], p);

export const IconClose = (p: IconProps = {}) => stroke(['M6 6l12 12', 'M18 6 6 18'], p);

export const IconCheckAll = (p: IconProps = {}) =>
  stroke(
    [
      'M4.5 8.5v-2a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-2',
      'M4.5 8.5h9a2 2 0 0 1 2 2v9h-9a2 2 0 0 1-2-2v-9Z',
      'M7.6 14.4l1.9 1.9 3.4-3.6',
    ],
    p,
  );

export const IconFilter = (p: IconProps = {}) =>
  stroke(['M4.5 6.5h15', 'M7.5 12h9', 'M10.5 17.5h3'], p);

export const IconShield = (p: IconProps = {}) =>
  stroke(['M12 3 5 5.8v5.4c0 4.4 3 7.4 7 9 4-1.6 7-4.6 7-9V5.8L12 3Z', 'M9 11.8l2.2 2.2 3.8-4'], p);

export const IconUnsubscribe = (p: IconProps = {}) =>
  stroke(
    [
      'M20 11V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6',
      'M4.5 7.5 12 12.5l7.5-5',
      'M15.5 17h5.5',
    ],
    p,
  );

/** Выход из ящика — пункт «Выйти» в меню. */
export const IconExit = (p: IconProps = {}) =>
  stroke(['M14 5.5H6.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1H14', 'M11.5 12h8', 'M16.5 8.5 20 12l-3.5 3.5'], p);

export const IconChevronDown = (p: IconProps = {}) => stroke(['M6 9.5l6 6 6-6'], p);

export const IconChevronRight = (p: IconProps = {}) => stroke(['M9.5 6l6 6-6 6'], p);

export const IconArrowUp = (p: IconProps = {}) => stroke(['M12 19V6', 'M6 12l6-6 6 6'], p);

export const IconArrowDown = (p: IconProps = {}) => stroke(['M12 5v13', 'M6 12l6 6 6-6'], p);

export const IconPlus = (p: IconProps = {}) => stroke(['M12 5v14', 'M5 12h14'], p);

/** Карандаш — переименовать папку, изменить правило. */
export const IconPencil = (p: IconProps = {}) =>
  stroke(['M4.5 19.5h4L20 8a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z', 'M15.5 6.5l3 3'], p);

/** Метла — «Очистить папку»: удалить письма, папку оставить. */
export const IconBroom = (p: IconProps = {}) =>
  stroke(['M15.5 4.5 19 8', 'M13 7 6 14l4 4 7-7', 'M8 16l-3.5 3.5', 'M11 19h8'], p);

export const IconNewTab = (p: IconProps = {}) =>
  stroke(
    ['M10 5H6.5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V14', 'M14 4.5h5.5V10', 'M19 5 11.5 12.5'],
    p,
  );

export const IconEvent = (p: IconProps = {}) =>
  stroke(
    ['M5 6.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1Z', 'M8 4v3.5', 'M16 4v3.5', 'M4 10.5h16'],
    p,
  );

/* --- Панель форматирования письма (в спрайте таких значков нет) --------
 *
 * Раньше эти кнопки были подписаны юникодными глифами («⇤ ↔ •• 1. ↶ ↷»,
 * эмодзи 🔗 и 🙂, комбинирующий «A̶»): рядом стояли знаки трёх разных
 * оптических плотностей, а два из них ещё и цветные. У mail.ru
 * (research/mailru/03-compose.png) вся полоса — один набор одноцветных
 * штриховых значков. Здесь они нарисованы в стилистике спрайта:
 * сетка 24×24, штрих 1.8, currentColor.
 */

export const IconAlignLeft = (p: IconProps = {}) =>
  stroke(['M4 6.5h16', 'M4 11h10', 'M4 15.5h16', 'M4 20h10'], p);

export const IconAlignCenter = (p: IconProps = {}) =>
  stroke(['M4 6.5h16', 'M7 11h10', 'M4 15.5h16', 'M7 20h10'], p);

export const IconAlignRight = (p: IconProps = {}) =>
  stroke(['M4 6.5h16', 'M10 11h10', 'M4 15.5h16', 'M10 20h10'], p);

/** Маркированный список. */
export const IconListBulleted = (p: IconProps = {}) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 6.5h11" />
    <path d="M9 12h11" />
    <path d="M9 17.5h11" />
    <circle cx="4.6" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.6" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

/** Нумерованный список. */
export const IconListNumbered = (p: IconProps = {}) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 6.5h11" />
    <path d="M9 12h11" />
    <path d="M9 17.5h11" />
    <path d="M3.4 4.6l1.4-.8V8" strokeWidth="1.4" />
    <path d="M3.4 10.6a1.4 1.4 0 1 1 2.3 1.1L3.4 14h2.6" strokeWidth="1.4" />
    <path d="M3.5 15.9h2.4l-1.5 1.8a1.4 1.4 0 1 1-1 2.4" strokeWidth="1.4" />
  </svg>
);

export const IconUndo = (p: IconProps = {}) =>
  stroke(['M4.5 9.5h9.8a4.7 4.7 0 0 1 0 9.4H8.5', 'M8 5.5 4 9.5l4 4'], p);

export const IconRedo = (p: IconProps = {}) =>
  stroke(['M19.5 9.5H9.7a4.7 4.7 0 0 0 0 9.4h5.8', 'M16 5.5l4 4-4 4'], p);

/** Вставить ссылку — звено цепи, одним цветом (было цветное эмодзи 🔗). */
export const IconLink = (p: IconProps = {}) =>
  stroke(
    [
      'M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4',
      'M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4',
    ],
    p,
  );

/** Вставить смайлик (было нативное 🙂 в `select`). */
export const IconEmoji = (p: IconProps = {}) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0" />
    <circle cx="9.2" cy="9.8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="9.8" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

/** Очистить форматирование — ластик (был комбинирующий символ «A̶»). */
export const IconClearFormat = (p: IconProps = {}) =>
  stroke(['M9.4 19.5 4.6 14.7a1.4 1.4 0 0 1 0-2l7.7-7.7a1.4 1.4 0 0 1 2 0l4.8 4.8a1.4 1.4 0 0 1 0 2l-8.4 8.4', 'M8.5 9.5l6.8 6.8', 'M9.4 19.5H20'], p);

/** Начертание («Tt» у mail.ru) — выбор гарнитуры. */
export const IconFontFamily = (p: IconProps = {}) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M3.2 18.4 8 5.6h2.1l4.8 12.8h-2.05l-1.24-3.46H6.49L5.25 18.4H3.2Zm3.9-5.2h3.9L9.05 7.8 7.1 13.2Z" />
    <path d="M17.6 18.55c-1.3 0-1.95-.72-1.95-2.05v-5.1h-1.4V9.75h1.4V7.4h1.9v2.35h2.05v1.65H17.55v4.85c0 .43.2.63.62.63h1.43v1.67H17.6Z" />
  </svg>
);

/* --- Помощник на основе ИИ (в спрайте таких значков нет) --------------- */

/** Общий значок помощника: искры. */
export const IconSparkles = (p: IconProps = {}) =>
  stroke(
    [
      'M10 3.5l1.6 4.3 4.4 1.7-4.4 1.7L10 15.5l-1.6-4.3L4 9.5l4.4-1.7L10 3.5Z',
      'M17.5 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z',
    ],
    p,
  );

/** Перевод письма. */
export const IconTranslate = (p: IconProps = {}) =>
  stroke(
    [
      'M3.5 6.5h8',
      'M7.5 4.5v2',
      'M9.5 6.5c0 3.7-2.6 6.8-6 7.8',
      'M4.8 9.8c1 2.2 2.9 3.8 5.2 4.4',
      'M12.5 20l4-9 4 9',
      'M13.9 17h5.2',
    ],
    p,
  );

/** Скопировать значение. */
export const IconCopy = (p: IconProps = {}) =>
  stroke(
    [
      'M9.5 8.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
      'M5.5 15.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1',
    ],
    p,
  );

/** Галочка — значение скопировано. */
export const IconCheck = (p: IconProps = {}) => stroke(['M5 12.5l4.5 4.5L19 7'], p);
