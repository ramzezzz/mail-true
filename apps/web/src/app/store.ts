/**
 * Глобальное UI-состояние (zustand): тема оформления, выделение писем,
 * компактный режим списка, окна написания письма.
 * Данные писем живут в react-query, не здесь.
 */

import { create } from 'zustand';

export type ThemeName = 'light' | 'dark' | 'wallpaper';

const THEME_KEY = 'mt-theme';

/** Хранилище браузера есть не всегда (тесты, отрисовка на сервере). */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // приватный режим может запрещать доступ
    return null;
  }
}

function readSavedTheme(): ThemeName {
  const saved = storage()?.getItem(THEME_KEY);
  return saved === 'dark' || saved === 'wallpaper' ? saved : 'light';
}

export function applyTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

/** Начальное наполнение окна написания (ответ, пересылка, черновик). */
export interface ComposeInit {
  to?: string | undefined;
  subject?: string | undefined;
  bodyHtml?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  /**
   * Составной идентификатор письма, из которого открыто окно.
   * Нужен помощнику: варианты ответа считаются по исходному письму.
   * Это не то же, что `inReplyTo` — там заголовок Message-ID.
   */
  sourceMessageId?: string | undefined;
}

/** Вложение, уже загруженное на сервер. */
export interface ComposeAttachment {
  id: string;
  filename: string;
  size: number;
}

/**
 * Всё, что пользователь ввёл в окне написания.
 *
 * Живёт в общем состоянии, а не внутри компонента, — и это не украшение.
 * Свёрнутое и развёрнутое окна рисуются по-разному, и при сворачивании
 * React размонтировал компонент вместе со всем введённым: получатели, тема,
 * вложения и тело письма исчезали безвозвратно. Пока черновик хранится
 * здесь, ни размонтирование, ни перерисовка ему не страшны.
 */
export interface ComposeDraft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** HTML тела; собирается из редактора при каждом изменении. */
  bodyHtml: string;
  attachments: ComposeAttachment[];
  showCc: boolean;
  showBcc: boolean;
  /** UID черновика на сервере — чтобы повторное сохранение не плодило копии. */
  draftUid: number | null;
  /** Когда последний раз сохранился (ISO) — подпись «Сохранено в …». */
  savedAt: string | null;
  /** Тело ещё не создавалось: цитату подставит окно при первом показе. */
  bodyInitialized: boolean;
  /** Выбранная в окне подпись; null — «Без подписи». */
  signatureId: string | null;
  /**
   * Подпись уже подставлена в тело письма.
   *
   * Отдельный признак, а не `signatureId !== null`: подпись приходит из
   * общих настроек, а они грузятся отдельным запросом и приходят позже
   * открытия окна. Пока их нет, подставлять нечего, и «без подписи»
   * от «ещё не знаем» надо отличать — иначе окно навсегда оставалось бы
   * пустым (ровно так и было с `account.signature`, который API отдаёт
   * пустой строкой).
   */
  signatureApplied: boolean;
}

export interface ComposeWindowState {
  id: number;
  minimized: boolean;
  init: ComposeInit;
  draft: ComposeDraft;
}

/** Пустой черновик с подставленными значениями из `init`. */
export function emptyDraft(init: ComposeInit): ComposeDraft {
  return {
    to: init.to ?? '',
    cc: '',
    bcc: '',
    subject: init.subject ?? '',
    bodyHtml: '',
    attachments: [],
    showCc: false,
    showBcc: false,
    draftUid: null,
    savedAt: null,
    bodyInitialized: false,
    signatureId: null,
    signatureApplied: false,
  };
}

let composeSeq = 0;

interface UiState {
  theme: ThemeName;
  setTheme(theme: ThemeName): void;

  /** Компактный список писем (у mail.ru — «pony mode», строки 40px). */
  compactList: boolean;
  toggleCompactList(): void;

  /** Выделенные чекбоксами письма (составные id). */
  selectedIds: ReadonlySet<string>;
  toggleSelected(id: string): void;
  /** Добавить к выделению набор id (кнопка «Выделить все»). */
  selectMany(ids: readonly string[]): void;
  clearSelection(): void;

  /** Открытые окна написания письма (несколько одновременно). */
  composeWindows: readonly ComposeWindowState[];
  openCompose(init?: ComposeInit): void;
  closeCompose(id: number): void;
  toggleComposeMinimized(id: number): void;
  /**
   * Правка черновика окна — переживает сворачивание и перерисовку.
   * Патч можно задать функцией, если он зависит от текущего значения
   * (например, добавление вложения к уже загруженным).
   */
  updateComposeDraft(
    id: number,
    patch: Partial<ComposeDraft> | ((draft: ComposeDraft) => Partial<ComposeDraft>),
  ): void;

  /**
   * Сообщение об отказе поверх интерфейса. Раньше ошибки мутаций терялись
   * молча: письмо не отправилось — кнопка просто переставала мигать.
   */
  notice: string | null;
  showNotice(text: string): void;
  clearNotice(): void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: readSavedTheme(),
  setTheme(theme) {
    storage()?.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },

  compactList: false,
  toggleCompactList: () => set((s) => ({ compactList: !s.compactList })),

  selectedIds: new Set<string>(),
  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),
  selectMany: (ids) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      for (const id of ids) next.add(id);
      return { selectedIds: next };
    }),
  clearSelection: () => set({ selectedIds: new Set<string>() }),

  composeWindows: [],
  openCompose: (init = {}) =>
    set((s) => ({
      composeWindows: [
        ...s.composeWindows,
        { id: ++composeSeq, minimized: false, init, draft: emptyDraft(init) },
      ],
    })),
  closeCompose: (id) =>
    set((s) => ({ composeWindows: s.composeWindows.filter((w) => w.id !== id) })),
  toggleComposeMinimized: (id) =>
    set((s) => ({
      composeWindows: s.composeWindows.map((w) =>
        w.id === id ? { ...w, minimized: !w.minimized } : w,
      ),
    })),
  updateComposeDraft: (id, patch) =>
    set((s) => ({
      composeWindows: s.composeWindows.map((w) =>
        w.id === id
          ? { ...w, draft: { ...w.draft, ...(typeof patch === 'function' ? patch(w.draft) : patch) } }
          : w,
      ),
    })),

  notice: null,
  showNotice: (text) => set({ notice: text }),
  clearNotice: () => set({ notice: null }),
}));
