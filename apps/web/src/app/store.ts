/**
 * Глобальное UI-состояние (zustand): тема оформления, выделение писем,
 * компактный режим списка, окна написания письма.
 * Данные писем живут в react-query, не здесь.
 */

import type { DraftContent } from '@mail-true/shared';
import { create } from 'zustand';
import { readCachedTheme, writeCachedTheme } from '../appearance/cache';
import { persistAppearance } from '../appearance/persist';
import type { ThemeName, ThemeSetting } from '../appearance/themes';

export type { ThemeName, ThemeSetting };

/**
 * Тема хранится за учётной записью НА СЕРВЕРЕ (настройки ящика), а
 * localStorage работает кэшем для мгновенного применения до ответа —
 * требование заказчика «тема оформления должна запоминаться для каждого
 * юзера». Всё, что касается кэша и его владельца, живёт в
 * appearance/cache.ts, отправка на сервер — в appearance/sync.ts.
 */
function readSavedSetting(): ThemeSetting {
  return readCachedTheme();
}

/** Системная тема ОС/браузера; вне браузера (тесты) — светлая. */
export function systemTheme(): ThemeName {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  }
  return 'light';
}

/** Что реально применять при данном выборе. */
export function resolveTheme(setting: ThemeSetting): ThemeName {
  return setting === 'system' ? systemTheme() : setting;
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
  /**
   * Письма, которые нужно вложить целиком, — «Переслать как вложение».
   * Байты письма уже лежат в ящике, поэтому сюда попадает только его
   * идентификатор и подпись для плашки в окне написания.
   */
  attachMessages?: readonly AttachedMessage[] | undefined;

  /* --- Дописывание сохранённого черновика ----------------------------
   * Эти поля заполняются ТОЛЬКО когда окно открывают на существующем
   * черновике (`GET /api/drafts/:uid`). Наличие `draftUid` и означает
   * «мы продолжаем письмо, а не начинаем новое», и от этого зависит
   * поведение окна: тело берётся как есть, подпись второй раз не
   * подставляется, а сохранение перезаписывает тот же черновик. */

  /** UID черновика, который дописывают. */
  draftUid?: number | undefined;
  cc?: string | undefined;
  bcc?: string | undefined;
  /** Вложения черновика — уже лежащие во временном хранилище сервера. */
  attachments?: readonly ComposeAttachment[] | undefined;
  requestReadReceipt?: boolean | undefined;
  /**
   * Почему это письмо не ушло — у черновика, вернувшегося из очереди
   * отправки. Живёт в `init`, а не в черновике окна: это неизменный факт
   * о прошлом письма, а не то, что человек сейчас правит.
   */
  sendFailure?: DraftContent['sendFailure'] | undefined;
}

/** Письмо, вложенное в другое письмо целиком (message/rfc822). */
export interface AttachedMessage {
  /** Составной идентификатор `${folderId}:${uid}`. */
  id: string;
  /** Что показать человеку — обычно тема исходного письма. */
  label: string;
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
  /** Письма, вложенные целиком («Переслать как вложение»). */
  attachedMessages: AttachedMessage[];
  showCc: boolean;
  showBcc: boolean;
  /**
   * Попросить получателя уведомить о прочтении. Живёт в черновике, а не
   * в состоянии компонента, по той же причине, что и всё остальное здесь:
   * иначе сворачивание окна тихо снимало бы просьбу.
   */
  requestReadReceipt: boolean;
  /**
   * Отложенная отправка: когда письмо должно уйти (ISO) или null.
   * Само ожидание держит сервер — браузер к этому моменту может быть
   * закрыт (см. apps/api/src/mail/deferred-send.ts).
   */
  sendAt: string | null;
  /**
   * Письмо отдано на отправку и несколько секунд лежит в очереди НА
   * СЕРВЕРЕ — его ещё можно вернуть («Письмо отправлено · Отменить»).
   *
   * Живёт в черновике, а не в состоянии компонента, ровно по той же
   * причине, что и всё остальное здесь: пока идёт отсчёт, окно написания
   * держит письмо целиком — со всеми получателями, вложениями и телом.
   * Отмена возвращает его на место, а не в «Черновики» куда-то.
   *
   * Закрытая вкладка это состояние теряет — и это правильно: пропадает
   * только возможность передумать, письмо всё равно уходит.
   */
  pending: { id: string; until: string } | null;
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
  /**
   * С какого адреса отправлять: `null` — свой ящик, число — идентификатор
   * подключённого чужого ящика (`/api/accounts/external/:id/send`).
   *
   * Живёт в черновике, как и всё остальное здесь: свернуть окно и потерять
   * выбранного отправителя — значит отправить письмо не с того адреса,
   * причём молча.
   */
  fromExternalId: number | null;
}

export interface ComposeWindowState {
  id: number;
  minimized: boolean;
  init: ComposeInit;
  draft: ComposeDraft;
}

/**
 * Пустой черновик с подставленными значениями из `init`.
 *
 * Отдельная ветка для дописывания сохранённого черновика (`init.draftUid`).
 * Там тело письма берётся ровно таким, каким его сохранили, и считается уже
 * готовым: подпись и цитата внутри него уже есть. Пропусти мы его через
 * обычный путь — окно добавило бы пустой абзац, завело бы ещё один блок
 * подписи и подставило бы подпись по умолчанию заново. За три открытия
 * черновика письмо обросло бы тремя подписями, и человек вычищал бы их руками.
 */
export function emptyDraft(init: ComposeInit): ComposeDraft {
  const continuing = init.draftUid !== undefined;
  const cc = init.cc ?? '';
  const bcc = init.bcc ?? '';
  return {
    to: init.to ?? '',
    cc,
    bcc,
    subject: init.subject ?? '',
    bodyHtml: continuing ? (init.bodyHtml ?? '') : '',
    attachments: [...(init.attachments ?? [])],
    attachedMessages: [...(init.attachMessages ?? [])],
    // Заполненные «Копия» и «Скрытая» обязаны быть видны сразу: спрятанный
    // получатель — это письмо, ушедшее не тому, кого человек видел на экране.
    showCc: cc !== '',
    showBcc: bcc !== '',
    requestReadReceipt: init.requestReadReceipt ?? false,
    sendAt: null,
    pending: null,
    draftUid: init.draftUid ?? null,
    savedAt: null,
    bodyInitialized: continuing,
    signatureId: null,
    signatureApplied: continuing,
    // Новое письмо всегда начинается со своего ящика: чужой адрес
    // выбирают осознанно, а не получают по умолчанию.
    fromExternalId: null,
  };
}

let composeSeq = 0;

interface UiState {
  /** Выбор пользователя: конкретная тема или «как в системе». */
  themeSetting: ThemeSetting;
  /** Применённая тема (для 'system' — текущая системная). */
  theme: ThemeName;
  setTheme(setting: ThemeSetting): void;

  /** Компактный список писем (в привычных почтовых интерфейсах — «pony mode», строки 40px). */
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
  /**
   * Открыть окно написания. Возвращает НОМЕР окна.
   *
   * Номер нужен пересылке: вложения исходного письма переносятся
   * отдельным шагом (их надо скачать и загрузить обратно), и дописать их
   * потом можно только в конкретное окно — человек за это время успевает
   * открыть второе.
   */
  openCompose(init?: ComposeInit): number;
  closeCompose(id: number): void;
  /**
   * Закрыть ВСЕ окна написания — при выходе и при смене ящика.
   *
   * Окна живут вне кэша запросов, поэтому `queryClient.clear()` их не
   * трогает, а сам компонент монтируется заново для любой сессии. Из-за
   * этого недописанное письмо переживало выход: на общем компьютере
   * следующий вошедший видел чужой текст с чужими адресатами. Хуже того,
   * после переключения на связанный ящик окно отправило бы письмо уже от
   * НОВОГО адреса, а «Сохранить» ушло бы в черновики нового ящика — по
   * номеру, под которым там лежит совсем другое письмо.
   */
  closeAllCompose(): void;
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

  /* --- Возврат из письма в список ------------------------------------
   * Оба поля живут здесь, а не в странице папки: страница при уходе в
   * письмо размонтируется целиком и всё своё состояние теряет — ровно
   * поэтому список и открывался заново сверху. */

  /** Прокрутка списка по ключу «папка + отбор», px. */
  listScroll: Readonly<Record<string, number>>;
  rememberListScroll(key: string, top: number): void;
  /**
   * Письмо, которое человек смотрел последним, — его строку в списке видно
   * подсветкой. Папка хранится вместе с идентификатором: подсветка говорит
   * «вот отсюда ты вышел» и в другой папке не значит ничего.
   */
  visitedMessage: { folderId: string; messageId: string } | null;
  setVisitedMessage(folderId: string, messageId: string): void;
  clearVisitedMessage(): void;

  /**
   * Сообщение об отказе поверх интерфейса. Раньше ошибки мутаций терялись
   * молча: письмо не отправилось — кнопка просто переставала мигать.
   */
  notice: string | null;
  showNotice(text: string): void;
  clearNotice(): void;
}

export const useUiStore = create<UiState>((set) => ({
  themeSetting: readSavedSetting(),
  theme: resolveTheme(readSavedSetting()),
  setTheme(setting) {
    writeCachedTheme(setting);
    // Выбор человека уходит за его учётную запись: за другим компьютером
    // тема должна быть та же. Отправка не ждётся и не показывает ошибок —
    // тема уже применена, а недоступный сервер не повод мешать работе.
    persistAppearance({ theme: setting });
    const theme = resolveTheme(setting);
    applyTheme(theme);
    set({ themeSetting: setting, theme });
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
  openCompose: (init = {}) => {
    const id = ++composeSeq;
    set((s) => ({
      composeWindows: [
        ...s.composeWindows,
        { id, minimized: false, init, draft: emptyDraft(init) },
      ],
    }));
    return id;
  },
  closeCompose: (id) =>
    set((s) => ({ composeWindows: s.composeWindows.filter((w) => w.id !== id) })),
  closeAllCompose: () => set({ composeWindows: [] }),
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
          ? {
              ...w,
              draft: { ...w.draft, ...(typeof patch === 'function' ? patch(w.draft) : patch) },
            }
          : w,
      ),
    })),

  listScroll: {},
  rememberListScroll: (key, top) =>
    set((s) => {
      const next = { ...s.listScroll, [key]: top };
      // Держим только последние несколько списков: папок бывает много, а
      // помнить прокрутку той, куда не заходили полдня, незачем.
      const keys = Object.keys(next);
      if (keys.length > 12) {
        for (const old of keys.slice(0, keys.length - 12)) delete next[old];
      }
      return { listScroll: next };
    }),

  visitedMessage: null,
  setVisitedMessage: (folderId, messageId) => set({ visitedMessage: { folderId, messageId } }),
  clearVisitedMessage: () => set({ visitedMessage: null }),

  notice: null,
  showNotice: (text) => set({ notice: text }),
  clearNotice: () => set({ notice: null }),
}));

// Пока действует «как в системе», смена системной темы (день/ночь в ОС)
// подхватывается на лету — без перезагрузки страницы.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    const state = useUiStore.getState();
    if (state.themeSetting !== 'system') return;
    const theme = systemTheme();
    applyTheme(theme);
    useUiStore.setState({ theme });
  });
}
