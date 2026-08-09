/**
 * Страница папки: панель действий, виртуализированный список писем,
 * контекстное меню и горячие клавиши (U, I, Shift+J, Shift+L, Ctrl+P,
 * стрелки, Enter, Esc).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { MessageFilter, MessageSummary } from '@mail-true/shared';
import { api } from '../api';
import {
  queryKeys,
  useFolderMessages,
  useFolders,
  useMoveMessages,
  useSetFlags,
} from '../api/queries';
import { useUiStore } from '../app/store';
import { Button } from '../components';
import { useOpenDraft } from '../compose/useOpenDraft';
import { forwardInit, replyInit } from '../lib/composeFromMessage';
import { collectForwardAttachments } from '../lib/forwardAttachments';
import { actionErrorText, errorText } from '../lib/errorText';
import { serializeRulePrefill } from '../lib/filterRules';
import { markAllReadLabel, selectAllLabel } from '../lib/paging';
import { hotkeyFor } from '../lib/hotkeys';
import { useGeneralPreferences } from '../settings/generalSettings';
import { searchUrlFor } from '../search/searchParams';
import { ListSkeleton } from '../mail/ListSkeleton';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabels,
  ContextMenuSeparator,
} from '../mail/ContextMenu';
import { LabelMenu, type LabelTarget } from '../mail/LabelMenu';
import { useLabelDictionary, useLabelsState } from '../mail/useLabels';
import { EmptyFolder } from '../mail/EmptyFolder';
import {
  IconArchive,
  IconCheckAll,
  IconClock,
  IconFilter,
  IconFlag,
  IconFolder,
  IconMailUnread,
  IconMuted,
  IconNewTab,
  IconSearch,
  IconSpam,
  IconTrash,
} from '../mail/icons';
import { ListToolbar } from '../mail/ListToolbar';
import { MailboxReview, type ReviewTab } from '../mail/MailboxReview';
import { useMailboxReviewAvailable } from '../mail/useMailings';
import { MessageList } from '../mail/MessageList';
import { chunkIds, expandThreadIds, isRowFlagged, rowLabelKeys } from '../mail/threadList';
import { PRESET_TITLES, formatWakeAt, type SnoozePreset } from '../mail/snoozeApi';
import { useSnoozeMessages, useSnoozeState, useUnsnoozeMessages } from '../mail/useSnooze';
import { useMuteThreads, useMutedState, useUnmuteThreads } from '../mail/useMute';
import { useAwaitReply, useAwaitingState, useCancelAwaitReply } from '../mail/useAwaitReply';
import styles from './FolderPage.module.css';
import { folderTitle } from '../lib/folderNames';

interface ContextMenuState {
  message: MessageSummary;
  x: number;
  y: number;
  /** «Переместить в папку» и «Отложить» раскрываются внутри меню. */
  view: 'main' | 'folders' | 'snooze';
}

export function FolderPage() {
  const { folderId = 'inbox' } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<MessageFilter>('all');
  const { data: folders } = useFolders();
  const preferences = useGeneralPreferences();
  /**
   * Группировать ли письма в переписки.
   *
   * Спрашивается ровно одно — что выбрал человек. В каких папках
   * группировка уместна, решает СЕРВЕР (threadingAllowed в API): иначе
   * правило пришлось бы держать в двух местах, а расходиться такие пары
   * начинают с первой же новой папки. В черновиках и корзине сервер
   * ответит обычным плоским списком, о чём строка честно скажет
   * отсутствием сводки переписки.
   */
  const threaded = preferences.groupByThread;
  /**
   * Отбор списка по своей метке.
   *
   * Состояние объявлено ДО запроса списка, потому что отбирает сервер:
   * метка уходит в запрос вместе с папкой и фильтром (`KEYWORD` в поиске
   * IMAP), и список с меткой — это другой ответ, а не подмножество
   * загруженного. Иначе человек, у которого помечено сто писем, а в папке
   * двадцать тысяч, видел бы только те из них, до которых долистал.
   */
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  // Письма подгружаются страницами: сервер отдаёт не больше сотни за раз,
  // а в папке их бывает вдвое больше — раньше остальные были недостижимы.
  // С группировкой страница — это сотня ПЕРЕПИСОК, а не писем.
  const page = useFolderMessages(folderId, filter, threaded, labelFilter);

  /*
   * Запоминаем вид списка для страницы письма: её стрелки
   * «предыдущее/следующее» обязаны листать ТОТ ЖЕ список, а не какой-то
   * свой. Пишем при каждом изменении — уход в письмо размонтирует эту
   * страницу вместе со всем её состоянием.
   */
  const setListView = useUiStore((s) => s.setListView);
  useEffect(() => {
    setListView({ threaded, filter, labelFilter });
  }, [setListView, threaded, filter, labelFilter]);
  const setFlags = useSetFlags();
  const moveMessages = useMoveMessages();

  const updateComposeDraft = useUiStore((s) => s.updateComposeDraft);
  const showNotice = useUiStore((s) => s.showNotice);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const selectMany = useUiStore((s) => s.selectMany);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const openCompose = useUiStore((s) => s.openCompose);
  const visitedMessage = useUiStore((s) => s.visitedMessage);
  const clearVisitedMessage = useUiStore((s) => s.clearVisitedMessage);
  const queryClient = useQueryClient();

  /**
   * Подсветка «отсюда ты вышел» — только для ЭТОЙ папки. В соседней папке
   * то же письмо ничего не значит, а после смены отбора список другой —
   * поэтому подсветка снимается вместе с ним (см. onFilterChange).
   */
  const highlightId = visitedMessage?.folderId === folderId ? visitedMessage.messageId : null;
  /**
   * Ключ, под которым помнится прокрутка. Отбор входит в ключ: список
   * «непрочитанные» — это другой список, и ставить его на прокрутку
   * полного было бы просто неправильным местом.
   */
  const scrollKey = labelFilter ? `${folderId}:${filter}:${labelFilter}` : `${folderId}:${filter}`;

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Письма, уже уезжающие из папки: перенос отправлен, ответа ещё нет. */
  const [leavingIds, setLeavingIds] = useState<readonly string[]>([]);

  /**
   * Пометить строки уезжающими — ДОПОЛНЕНИЕМ к уже уезжающим.
   *
   * Здесь стояло присваивание списком, и второе действие стирало память о
   * первом: смахнул письмо A, тут же смахнул B — строка A переставала быть
   * погашенной и снова выглядела живой. Человек смахивал её второй раз,
   * то есть удалял уже удалённое.
   */
  const markLeaving = useCallback((ids: readonly string[]) => {
    setLeavingIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }, []);

  /**
   * Вернуть строки в живые: сервер отказал.
   *
   * Снимаем пометку ТОЛЬКО с той порции, которая не доехала. Раньше отказ
   * одного запроса зажигал заново все уезжающие строки — в том числе те,
   * что честно уехали соседним запросом (письма уходят порциями по пятьсот).
   */
  const unmarkLeaving = useCallback((ids: readonly string[]) => {
    setLeavingIds((prev) => prev.filter((id) => !ids.includes(id)));
  }, []);

  const messages = page.items;

  // Смена папки: сбрасываем выделение, курсор и фильтры
  useEffect(() => {
    clearSelection();
    setFocusedId(null);
    setFilter('all');
    /*
     * Отбор по метке сбрасывается вместе с остальным.
     *
     * Раньше он переживал смену папки, а признак его действия нарисован
     * только галочкой ВНУТРИ выпадающего меню «Фильтр» — на самой панели
     * ничего. Человек отбирал «Входящие» по метке «Оплатить», переходил в
     * «Отправленные» и видел неполный список без единого указания почему.
     */
    setLabelFilter(null);
    setContextMenu(null);
    setLeavingIds([]);
  }, [folderId, clearSelection]);

  // Уехавшие письма пропали из списка — метку можно снять. Именно с тех,
  // кого в списке уже нет: остальные ещё уезжают, и гасить их рано.
  useEffect(() => {
    if (leavingIds.length === 0) return;
    const stillHere = leavingIds.filter((id) => messages.some((m) => m.id === id));
    if (stillHere.length !== leavingIds.length) setLeavingIds(stillHere);
  }, [messages, leavingIds]);

  /**
   * Строки, к которым применяется действие: выделенные, иначе — под курсором.
   *
   * Именно СТРОКИ, а не письма: строка бывает целой перепиской. Разворачивает
   * их в письма `expand` — через него обязано пройти каждое действие.
   */
  const targetIds = useCallback((): string[] => {
    if (selectedIds.size > 0) return [...selectedIds];
    if (focusedId) return [focusedId];
    return [];
  }, [selectedIds, focusedId]);

  /**
   * Строки -> письма. Здесь и живёт обещание «действие над строкой
   * действует на всю переписку»: без этого шага «удалить» уносило бы одно
   * последнее письмо из шести, а строка в списке пропадала бы целиком —
   * то есть человек видел бы удалённую переписку, у которой пять писем
   * остались в папке.
   */
  const expand = useCallback(
    (rowIds: string[]): string[] => expandThreadIds(rowIds, messages),
    [messages],
  );

  /* ---------------------------------------------------------------- */
  /* Свои метки                                                        */
  /* ---------------------------------------------------------------- */

  /*
   * Метка относится ко ВСЕЙ переписке — как удаление, архив, флажок и
   * откладывание. Обоснование то же и одно на все действия: строка списка
   * представляет разговор, а не последнее письмо в нём. «Оплатить» — это
   * про дело, а не про реплику; и если пометить одно письмо, метка уйдёт
   * из виду от первого же ответа собеседника — строку рисует последнее
   * письмо, а оно ключевого слова не несёт.
   *
   * Поэтому простановка идёт через тот же `expand`, что и всё остальное,
   * а показ строки берёт ОБЪЕДИНЕНИЕ меток разговора (useRowLabels):
   * метка стоит на переписке, если стоит хоть на одном её письме — ровно
   * то же правило, по которому в сводке переписки живут `flagged`
   * и `hasAttachments`.
   */
  const labelsAvailable = useLabelsState().available;
  const labelDictionary = useLabelDictionary();

  /**
   * Строка для меню меток: её собственные метки — объединение разговора.
   * Считать его здесь нечего, оно приходит готовым в сводке переписки.
   */
  const labelTargetsOf = useCallback(
    (rowIds: readonly string[]): LabelTarget[] => {
      const byId = new Map(messages.map((m) => [m.id, m]));
      return rowIds.map((id) => {
        const message = byId.get(id);
        return { id, labels: message ? rowLabelKeys(message) : [] };
      });
    },
    [messages],
  );

  // Метка, которой больше нет (удалили в настройках), отбором быть не может
  useEffect(() => {
    if (labelFilter && !labelDictionary.some((l) => l.key === labelFilter)) setLabelFilter(null);
  }, [labelFilter, labelDictionary]);

  const applyFlags = useCallback(
    (rowIds: string[], set: Parameters<typeof setFlags.mutate>[0]['set']) => {
      const ids = expand(rowIds);
      if (ids.length === 0) return;
      // Пачками не больше пятисот: столько принимает маршрут за раз.
      // Сотня выделенных строк — это легко больше пятисот писем, и раньше
      // такой запрос просто отвергался бы целиком.
      for (const chunk of chunkIds(ids)) setFlags.mutate({ ids: chunk, set });
      clearSelection();
    },
    [expand, setFlags, clearSelection],
  );

  /**
   * Над чем работает контекстное меню.
   *
   * Если щёлкнули по выделенной строке — над всем выделением; иначе — над
   * этой строкой. Ровно так же ведёт себя перетаскивание, и два жеста
   * над одним письмом не должны делать разное.
   */
  const contextTargets = useCallback((): string[] => {
    const id = contextMenu?.message.id;
    if (!id) return [];
    return selectedIds.has(id) ? [...selectedIds] : [id];
  }, [contextMenu?.message.id, selectedIds]);

  /** Папка, открытая сейчас: нужна и обработчикам выше, и разметке ниже. */
  const currentFolder = (folders ?? []).find((f) => f.id === folderId);

  const moveTo = useCallback(
    (rowIds: string[], targetFolderId: string) => {
      const ids = expand(rowIds);
      if (ids.length === 0) return;
      /*
       * ПЕРЕНОС В ТУ ЖЕ ПАПКУ — НЕ ДЕЙСТВИЕ, А НЕДОРАЗУМЕНИЕ.
       *
       * Сервер такой перенос пропускает (исходная папка и есть цель) и
       * честно отвечает «перенесено 0». А браузер к этому моменту уже
       * погасил строки: они становились невидимыми дырами — их нельзя ни
       * выделить, ни открыть, ни повторить действие, и метка «уезжает» с
       * них не снималась никогда, потому что письма из списка никуда не
       * делись. Лечилось только уходом в другую папку или перезагрузкой.
       *
       * Ловилось это на самом обычном: «Удалить» в «Корзине», «В архив» в
       * «Архиве», «Спам» в «Спаме» — и жестами смахивания, которые делают
       * то же самое.
       */
      if (targetFolderId === folderId || targetFolderId === currentFolder?.role) {
        showNotice(
          targetFolderId === 'trash'
            ? 'Эти письма уже в «Корзине». Очистить её целиком можно в настройках, в разделе «Восстановление писем»'
            : 'Эти письма уже в этой папке',
        );
        clearSelection();
        return;
      }
      // Строки гаснут сразу: ждать ответа сервера, чтобы показать отклик,
      // нельзя — при неудаче метка снимается и письма возвращаются на место.
      markLeaving(ids);
      for (const chunk of chunkIds(ids)) {
        moveMessages.mutate(
          { ids: chunk, targetFolderId },
          { onError: () => unmarkLeaving(chunk) },
        );
      }
      clearSelection();
      setFocusedId(null);
    },
    [
      expand,
      moveMessages,
      clearSelection,
      folderId,
      currentFolder?.role,
      showNotice,
      markLeaving,
      unmarkLeaving,
    ],
  );

  /** Подгрузка следующей страницы — по прокрутке до конца списка. */
  const loadMore = page.loadMore;

  /**
   * Папка «Черновики» — папка НЕОТПРАВЛЕННЫХ писем, и открывать их надо на
   * дописывание, а не на чтение. Раньше щелчок по черновику вёл на обычный
   * просмотр письма, и продолжить набранное было нельзя ничем — черновик
   * оставался в папке навсегда как мусор.
   *
   * Смотрим на роль папки, а не на её идентификатор: имя папки черновиков
   * в IMAP бывает любым, роль ставит сервер.
   */
  const draftsFolder = (currentFolder?.role ?? folderId) === 'drafts';
  const { openDraft } = useOpenDraft();

  const openMessage = useCallback(
    (id: string) => {
      if (draftsFolder) {
        const message = messages.find((m) => m.id === id);
        if (message) {
          openDraft(message.uid);
          return;
        }
      }
      void navigate(`/${folderId}/${encodeURIComponent(id)}`);
    },
    [navigate, folderId, draftsFolder, messages, openDraft],
  );

  /**
   * «Создать фильтр» — окно правила в настройках с подставленным
   * отправителем. Адрес берётся у письма под курсором или у первого
   * выделенного: правило строится по одному отправителю, а не по пачке.
   */
  const createFilter = useCallback(
    (address?: string) => {
      const from =
        address ?? messages.find((m) => m.id === (focusedId ?? [...selectedIds][0]))?.from.address;
      const query = from ? `?new=${encodeURIComponent(serializeRulePrefill('from', from))}` : '';
      void navigate(`/settings/filters${query}`);
    },
    [navigate, messages, focusedId, selectedIds],
  );

  /** «Найти все письма отправителя» — обычный поиск по его адресу. */
  const findFromSender = useCallback(
    (address: string) => void navigate(searchUrlFor(address)),
    [navigate],
  );

  /**
   * Ответ и пересылка прямо из списка (клавиши R и F).
   *
   * В списке лежат только краткие сведения о письме, а в ответ идёт цитата
   * из его тела — поэтому письмо догружаем. Ключ тот же, что у страницы
   * письма: уже открытое возьмётся из кэша, без запроса к серверу.
   */
  const composeFrom = useCallback(
    async (kind: 'reply' | 'forward') => {
      const id = focusedId ?? [...selectedIds][0];
      if (!id) return;
      try {
        const message = await queryClient.fetchQuery({
          queryKey: queryKeys.message(id, false),
          queryFn: () => api.getMessage(id, { images: false }),
        });
        const windowId = openCompose(
          kind === 'reply'
            ? replyInit(message, preferences.quoteOriginalOnReply)
            : forwardInit(message),
        );
        /*
         * Пересылка обязана донести вложения. Их надо скачать и загрузить
         * обратно, поэтому окно открывается сразу, а файлы догоняют: пока
         * они едут, человек уже набирает текст.
         */
        if (kind === 'forward') {
          // Пока файлы едут, отправка недоступна: иначе письмо уходит без
          // них и молча (см. pendingAttachments в app/store.ts).
          updateComposeDraft(windowId, (draft) => ({
            pendingAttachments: draft.pendingAttachments + 1,
          }));
          void collectForwardAttachments(message)
            .then(({ attachments, failed }) => {
              if (attachments.length > 0) {
                updateComposeDraft(windowId, (draft) => ({
                  attachments: [...draft.attachments, ...attachments],
                }));
              }
              if (failed.length > 0) {
                showNotice(`Не удалось перенести вложения: ${failed.join(', ')}`);
              }
            })
            .finally(() => {
              updateComposeDraft(windowId, (draft) => ({
                pendingAttachments: Math.max(0, draft.pendingAttachments - 1),
              }));
            });
        }
      } catch (error) {
        showNotice(actionErrorText('Не удалось открыть письмо', error));
      }
    },
    [
      focusedId,
      selectedIds,
      queryClient,
      openCompose,
      preferences.quoteOriginalOnReply,
      showNotice,
      updateComposeDraft,
    ],
  );

  /**
   * «Переслать как вложение» — новое письмо, к которому выбранные письма
   * приложены целиком (`message/rfc822`), а не пересказаны цитатой.
   *
   * Байты писем берёт сервер прямо из ящика (см. `attachMessageIds`
   * в apps/api/src/routes/compose.ts): тащить исходник в браузер и обратно
   * незачем, да и портится он при этом легко. Здесь остаются только
   * идентификаторы и темы для плашек в окне написания.
   */
  const forwardAsAttachment = useCallback(() => {
    const ids = targetIds();
    const chosen = messages.filter((m) => ids.includes(m.id));
    if (chosen.length === 0) {
      showNotice('Выберите письмо, которое нужно переслать вложением');
      return;
    }
    const first = chosen[0];
    openCompose({
      // Тема — как у обычной пересылки одного письма; для пачки называем
      // их число: перечислять десяток тем в строке темы бессмысленно
      subject:
        chosen.length === 1 && first
          ? first.subject.startsWith('Fwd:')
            ? first.subject
            : `Fwd: ${first.subject}`
          : `Fwd: ${String(chosen.length)} писем`,
      attachMessages: chosen.map((m) => ({ id: m.id, label: m.subject || '(без темы)' })),
    });
    clearSelection();
  }, [targetIds, messages, openCompose, showNotice, clearSelection]);

  /**
   * Пометить флажком: если все цели уже с флагом — снять.
   *
   * «С флагом» у переписки означает «хоть одно письмо с флагом»
   * (isRowFlagged) — ровно то, что и нарисовано в строке. Иначе нажатие
   * по строке с уже красной лентой ставило бы флаг ещё раз вместо того,
   * чтобы его снять.
   */
  const toggleFlagOn = useCallback(
    (rowIds: string[]) => {
      const targets = messages.filter((m) => rowIds.includes(m.id));
      const allFlagged = targets.length > 0 && targets.every(isRowFlagged);
      applyFlags(rowIds, { flagged: !allFlagged });
    },
    [messages, applyFlags],
  );

  // Горячие клавиши
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Пока фокус на кнопке, ссылке или поле, клавиши принадлежат им, а не
      // нам. Иначе разобравший список стрелками не мог нажать ни одной
      // кнопки: Enter отбирал глобальный обработчик и уводил в письмо.
      const action = hotkeyFor(e, e.target);
      if (!action) return;

      switch (action) {
        case 'reply':
          e.preventDefault();
          void composeFrom('reply');
          return;
        case 'forward':
          e.preventDefault();
          void composeFrom('forward');
          return;
        case 'delete':
          e.preventDefault();
          moveTo(targetIds(), 'trash');
          return;
        case 'nav-down':
        case 'nav-up': {
          e.preventDefault();
          if (messages.length === 0) return;
          const index = messages.findIndex((m) => m.id === focusedId);
          const next =
            index === -1
              ? 0
              : Math.min(
                  messages.length - 1,
                  Math.max(0, index + (action === 'nav-down' ? 1 : -1)),
                );
          setFocusedId(messages[next]?.id ?? null);
          return;
        }
        case 'open':
          if (focusedId) {
            e.preventDefault();
            openMessage(focusedId);
          }
          return;
        case 'close':
          e.preventDefault();
          if (contextMenu) setContextMenu(null);
          else if (selectedIds.size > 0) clearSelection();
          else setFocusedId(null);
          return;
        case 'toggle-unread':
          e.preventDefault();
          applyFlags(targetIds(), { seen: false });
          return;
        case 'toggle-flag':
          e.preventDefault();
          toggleFlagOn(targetIds());
          return;
        case 'spam':
          e.preventDefault();
          moveTo(targetIds(), 'spam');
          return;
        case 'create-filter':
          e.preventDefault();
          createFilter();
          return;
        case 'print':
          e.preventDefault();
          window.print();
          return;
        default:
          return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    messages,
    focusedId,
    contextMenu,
    selectedIds,
    clearSelection,
    applyFlags,
    moveTo,
    targetIds,
    toggleFlagOn,
    openMessage,
    createFilter,
    composeFrom,
  ]);

  const otherFolders = (folders ?? []).filter((f) => f.id !== folderId);
  const allIds = useMemo(() => messages.map((m) => m.id), [messages]);

  /* --- Отложить письмо до срока ---------------------------------------
   *
   * Состояние возможности приходит с сервера, и пока он не сказал
   * `available`, кнопки «Отложить» здесь нет вовсе: за ней стоит база и
   * работник возврата, и без них она была бы мёртвой.
   */
  const snoozeState = useSnoozeState();
  const snoozeMessages = useSnoozeMessages();
  const unsnooze = useUnsnoozeMessages();
  /** Мы в самой папке «Отложенные»: здесь действия обратные. */
  const snoozedFolder = (currentFolder?.role ?? folderId) === 'snoozed';

  const snoozeTo = useCallback(
    (rowIds: string[], choice: { preset: SnoozePreset; until?: string }) => {
      // Откладывается вся переписка: половина разговора, уехавшая до
      // понедельника, — это разорванный разговор в обеих папках.
      const ids = expand(rowIds);
      if (ids.length === 0) return;
      // Строки гаснут сразу, как при переносе в другую папку: письмо и
      // правда уезжает — ждать ответа сервера, чтобы показать отклик,
      // значило бы на секунду делать вид, что нажатие не сработало.
      markLeaving(ids);
      for (const chunk of chunkIds(ids)) {
        snoozeMessages.mutate(
          { ids: chunk, preset: choice.preset, ...(choice.until ? { until: choice.until } : {}) },
          { onError: () => unmarkLeaving(chunk) },
        );
      }
      clearSelection();
      setFocusedId(null);
    },
    [expand, snoozeMessages, clearSelection, markLeaving, unmarkLeaving],
  );

  const returnNow = useCallback(
    (rowIds: string[]) => {
      // В самих «Отложенных» группировки нет (там у каждого письма свой
      // срок), поэтому разворачивать обычно нечего — но правило одно на все
      // действия, и исключений в нём быть не должно.
      const ids = expand(rowIds);
      if (ids.length === 0) return;
      markLeaving(ids);
      for (const chunk of chunkIds(ids)) {
        unsnooze.mutate(chunk, { onError: () => unmarkLeaving(chunk) });
      }
      clearSelection();
      setFocusedId(null);
    },
    [expand, unsnooze, clearSelection, markLeaving, unmarkLeaving],
  );

  /**
   * Сроки для строк папки «Отложенные».
   *
   * Список сроков приходит отдельным запросом (он живёт в базе, а не в
   * самом письме), поэтому здесь только сводим его со строками списка по
   * идентификатору письма. Письмо без срока подписи не получает — и это
   * правильно: срока у него действительно нет, и придумывать его нельзя.
   */
  const snoozeLabels = useMemo(() => {
    if (!snoozedFolder) return undefined;
    const map = new Map<string, string>();
    for (const item of snoozeState.items) {
      if (!item.orphan && item.wakeAt) map.set(item.id, formatWakeAt(item.wakeAt));
    }
    return map;
  }, [snoozedFolder, snoozeState.items]);

  /* --- Заглушить цепочку -----------------------------------------------
   *
   * Кнопки нет, пока сервер не сказал ДВА раза: возможность есть И она
   * доедет до доставки. Второе условие здесь важнее первого: заглушка,
   * которая прячет письма только в списке, — это ровно та мёртвая кнопка,
   * ради отказа от которой всё и делалось (см. muteApi.ts).
   */
  const mutedState = useMutedState();
  const muteThreads = useMuteThreads();
  const unmuteThreads = useUnmuteThreads();
  /** Мы в самой папке «Заглушённые»: здесь действие обратное. */
  const mutedFolder = (currentFolder?.role ?? folderId) === 'muted';

  const muteRows = useCallback(
    (rowIds: string[]) => {
      // Заглушается весь разговор целиком — это и есть смысл действия,
      // поэтому строка разворачивается в переписку, как и везде.
      const ids = expand(rowIds);
      if (ids.length === 0) return;
      // Строки гаснут сразу: письма уезжают в «Заглушённые», и делать вид,
      // что нажатие не сработало, пока идёт запрос, нельзя.
      markLeaving(ids);
      for (const chunk of chunkIds(ids)) {
        muteThreads.mutate(chunk, { onError: () => unmarkLeaving(chunk) });
      }
      clearSelection();
      setFocusedId(null);
    },
    [expand, muteThreads, clearSelection, markLeaving, unmarkLeaving],
  );

  /**
   * Снятие заглушки в самой папке «Заглушённые».
   *
   * Ключи переписок берутся из подборки: в письме их нет — заглушена
   * ПЕРЕПИСКА, а не письмо, и по одному письму сервер не смог бы понять,
   * какую именно запись снимать. Пока подборка не загрузилась, кнопки нет.
   */
  const unmuteSelected = useCallback(() => {
    /*
     * Снимаем заглушку с переписок ВЫДЕЛЕННЫХ писем — ровно то, что
     * написано на кнопке. Раньше сюда подставлялись ключи всей подборки,
     * и одно нажатие возвращало во «Входящие» всё заглушённое разом; а
     * когда переписок становилось больше сотни, запрос упирался в предел
     * схемы и не работал вовсе.
     */
    const ids = targetIds();
    if (ids.length === 0) return;
    // Порциями: маршрут снятия принимает не больше пятисот писем.
    for (const chunk of chunkIds(ids)) unmuteThreads.mutate(chunk);
    clearSelection();
  }, [targetIds, unmuteThreads, clearSelection]);

  /* --- Напомнить, если не ответили -------------------------------------
   *
   * Только в «Отправленных»: ждать ответа можно на то, что написал сам.
   * Сервер это же и проверяет — здесь условие стоит ради кнопки, а не
   * вместо замка.
   */
  const awaitingState = useAwaitingState();
  const awaitReply = useAwaitReply();
  const cancelAwaitReply = useCancelAwaitReply();
  const sentFolder = (currentFolder?.role ?? folderId) === 'sent';

  const waitReply = useCallback(
    (rowIds: string[], choice: { preset: SnoozePreset; until?: string }) => {
      /*
       * Здесь строка НЕ разворачивается в переписку, и это не забывчивость.
       * Ждут ответа на конкретное отправленное письмо: у переписки из трёх
       * своих писем ответ ждут на последнее, а поставить ожидание на все
       * три значило бы три напоминания об одном и том же.
       */
      if (rowIds.length === 0) return;
      // Порциями: маршрут ожидания принимает не больше сотни писем, а
      // в «Отправленных» легко выделить двести загруженных строк — запрос
      // отвергался целиком, и ожидание не ставилось ни на одно письмо.
      for (const chunk of chunkIds(rowIds, 100)) {
        awaitReply.mutate({
          ids: chunk,
          preset: choice.preset,
          ...(choice.until ? { until: choice.until } : {}),
        });
      }
      clearSelection();
    },
    [awaitReply, clearSelection],
  );

  const stopWaiting = useCallback(
    (rowIds: string[]) => {
      if (rowIds.length === 0) return;
      for (const chunk of chunkIds(rowIds, 100)) cancelAwaitReply.mutate(chunk);
      clearSelection();
    },
    [cancelAwaitReply, clearSelection],
  );

  /** Есть ли среди выделенного письмо, на котором уже стоит ожидание. */
  const someAwaiting = useMemo(() => {
    if (selectedIds.size === 0) return false;
    return messages.some((m) => selectedIds.has(m.id) && m.awaitReply === 'waiting');
  }, [messages, selectedIds]);
  /* --- Разбор ящика ---------------------------------------------------
   *
   * Окно поверх списка, а не отдельная страница: разбор — это ответ на
   * вопрос «что за мусор у меня в списке», и уводить за ним из списка
   * значит терять место, где вопрос возник. Осмотр ящика начинается
   * только с открытием окна (см. useMailings): он дорог, и платить за
   * него при каждом открытии почты нельзя.
   */
  const reviewAvailable = useMailboxReviewAvailable();
  const [reviewTab, setReviewTab] = useState<ReviewTab | null>(null);

  /** Список загружен и в нём нет ни одного письма. */
  const emptyFolder = !page.isPending && !page.isError && messages.length === 0;

  return (
    <div className={styles.page}>
      <ListToolbar
        selectedCount={selectedIds.size}
        selectAllLabel={selectAllLabel(page.loaded, page.total)}
        markAllReadLabel={markAllReadLabel(page.loaded, page.total)}
        emptyFolder={emptyFolder}
        filter={filter}
        /* Со сменой отбора список становится другим, и подсветка «отсюда ты
           вышел» перестаёт что-либо значить: она про место в ЭТОМ списке. */
        onFilterChange={(next) => {
          setFilter(next);
          clearVisitedMessage();
        }}
        folders={otherFolders}
        onSelectAll={() => selectMany(allIds)}
        onClearSelection={clearSelection}
        onMarkAllRead={() => applyFlags(allIds, { seen: true })}
        // Кнопочный двойник жеста «потянуть вниз»: жест не может быть
        // единственным способом обновить список — его не видно и его нет
        // ни у мыши, ни у клавиатуры.
        onRefresh={() => void page.refresh()}
        refreshing={page.isRefreshing}
        onDelete={() => moveTo(targetIds(), 'trash')}
        onArchive={() => moveTo(targetIds(), 'archive')}
        onMoveTo={(target) => moveTo(targetIds(), target)}
        /*
          «Отписаться» над выделением ведёт в разбор рассылок. Отписка —
          это действие над ОТПРАВИТЕЛЕМ, а не над выбранными письмами: в
          разборе видно, сколько у него писем всего, и отписка идёт по
          самому свежему из них (у старого адрес отписки часто протух).
          Раньше здесь стояло указание «отписаться можно в самом письме» —
          то есть отправка человека делать это тридцать раз подряд.
        */
        onUnsubscribe={() =>
          reviewAvailable
            ? setReviewTab('mailings')
            : showNotice('Отписаться можно в самом письме — там есть адрес отписки')
        }
        onReview={reviewAvailable ? () => setReviewTab('mailings') : undefined}
        onMarkUnread={() => applyFlags(targetIds(), { seen: false })}
        onToggleFlag={() => toggleFlagOn(targetIds())}
        onSpam={() => moveTo(targetIds(), 'spam')}
        onPrint={() => window.print()}
        onCreateFilter={() => createFilter()}
        onForwardAsAttachment={forwardAsAttachment}
        /* «Отложить» — только там, где это имеет смысл: не в самих
           «Отложенных» (там письмо уже отложено) и не тогда, когда
           возможности нет на сервере. */
        onSnooze={
          snoozeState.available && !snoozedFolder
            ? (choice) => snoozeTo(targetIds(), choice)
            : undefined
        }
        snoozeScheduledReturn={snoozeState.scheduledReturn}
        onReturnNow={snoozedFolder ? () => returnNow(targetIds()) : undefined}
        /* «Заглушить» — там же, где «Отложить», и по тем же правилам: не в
           самих «Заглушённых» и только когда заглушка доедет до доставки. */
        onMute={
          mutedState.available && mutedState.delivery && !mutedFolder
            ? () => muteRows(targetIds())
            : undefined
        }
        onUnmute={mutedFolder && mutedState.items.length > 0 ? unmuteSelected : undefined}
        /* «Ждать ответа» — только в «Отправленных» и только когда сервер
           обещает проверить срок сам. */
        onAwaitReply={
          awaitingState.available && awaitingState.scheduledCheck && sentFolder && !someAwaiting
            ? (choice) => waitReply(targetIds(), choice)
            : undefined
        }
        awaitScheduledCheck={awaitingState.scheduledCheck}
        /* А если ожидание уже стоит — на том же месте обратное действие.
           Две кнопки разом означали бы, что человек может нажать «ждать»
           на письме, которое уже ждёт, и получить отказ базы. */
        onCancelAwaitReply={
          awaitingState.available && someAwaiting ? () => stopWaiting(targetIds()) : undefined
        }
        /* Метки на всю пачку выделенных строк. Галочка считается по
           СТРОКАМ (выделяли их), а правятся все письма их переписок. */
        labelMenu={
          labelsAvailable && selectedIds.size > 0 ? (
            <LabelMenu
              messages={labelTargetsOf([...selectedIds])}
              targetIds={expand([...selectedIds])}
            />
          ) : undefined
        }
        labels={labelsAvailable ? labelDictionary : undefined}
        labelFilter={labelFilter}
        onLabelFilterChange={(key) => {
          setLabelFilter(key);
          clearVisitedMessage();
        }}
      />

      {/*
        Строки о пределах отбора здесь больше нет, и это не упрощение.
        Отбор делает сервер по всей папке, поэтому «из загруженных N»
        сообщать нечего: список с меткой полон по построению. Пока отбор
        шёл по загруженным строкам, молчать об этом было нельзя.

        Осталось единственное, о чём сказать надо: отбор нашёл пусто.
        Обычная заставка пустой папки соврала бы — папка-то не пуста.
      */}
      {labelFilter && !page.isPending && !page.isError && messages.length === 0 && (
        <div className={styles.labelFilterNote} role="status">
          С меткой «{labelDictionary.find((l) => l.key === labelFilter)?.name ?? labelFilter}» писем
          нет.{' '}
          <button
            type="button"
            className={styles.labelFilterReset}
            onClick={() => setLabelFilter(null)}
          >
            Показать все
          </button>
        </div>
      )}

      {/* Скелетоны вместо пустого экрана: строки встают на те же места,
          что и настоящие письма, поэтому список не «прыгает» при загрузке */}
      {page.isPending && <ListSkeleton />}

      {/* Раньше сюда попадал сырой текст исключения — вместе с именем
          класса. Теперь понятная причина и кнопка повтора. */}
      {page.isError && (
        <div className={styles.centered}>
          <div className={styles.loadError}>
            <p className={styles.loadErrorText}>
              Не удалось загрузить письма. {errorText(page.error)}
            </p>
            <Button mode="secondary" onClick={page.retry}>
              Повторить
            </Button>
          </div>
        </div>
      )}

      {!page.isPending && !page.isError && messages.length === 0 && !labelFilter && (
        <EmptyFolder role={currentFolder?.role ?? folderId} />
      )}

      {messages.length > 0 && (
        <MessageList
          /* Ключ по папке: список монтируется заново — и прокрутка начинается
             сверху, и появление новой папки видно */
          key={folderId}
          /* Отбор по метке уже применил сервер — сужать здесь нечего. */
          messages={messages}
          focusedId={focusedId}
          leavingIds={leavingIds}
          onEndReached={loadMore}
          /* Смахнули строку: вправо — в архив, влево — удалить. Ровно те же
             два действия лежат кнопками в панели над списком. */
          onSwipe={(message, action) =>
            moveTo([message.id], action === 'archive' ? 'archive' : 'trash')
          }
          onRefresh={() => page.refresh()}
          /* В «Черновиках» щелчок открывает окно написания с уже набранным
             письмом, а не просмотр: это папка неотправленных писем, и
             приходят в неё дописывать. В остальных папках проп не задан, и
             строка ведёт себя как прежде — ссылкой на просмотр. */
          onOpen={draftsFolder ? (message) => openDraft(message.uid) : undefined}
          /* Возврат из письма ставит список на то же место, а строку, из
             которой ушли, подсвечивает: без этого при просмотре нескольких
             писем подряд место в списке приходится искать заново после
             каждого. */
          scrollKey={scrollKey}
          highlightId={highlightId}
          /* Срок возврата в строке — только в папке «Отложенные»: в
             остальных его нет и показывать нечего. */
          snoozeLabels={snoozeLabels}
          /* Метки строк: справочник (имена и цвета) и ключевые слова
             каждой строки. И то и другое приходит сверху — список сам
             к серверу не ходит. */
          labels={labelDictionary}
          /*
            Подвал уходит ВНУТРЬ списка, в его область прокрутки. Рядом со
            списком он висел под ним всегда: человек ещё не долистал, а
            «Показать ещё» уже перед глазами — кнопка не сообщала ничего о
            том, где ты находишься, и спорила с прокруткой.

            Она нужна и при подгрузке по прокрутке: бывает, что прокручивать
            нечего — короткое окно, мышь без колеса.
          */
          footer={
            messages.length > 0 && page.hasMore ? (
              <Button mode="secondary" onClick={loadMore} disabled={page.isLoadingMore}>
                {page.isLoadingMore ? 'Загружаем…' : 'Показать ещё'}
              </Button>
            ) : null
          }
          onContextMenu={(message, x, y) => {
            /*
             * Правый щелчок по ВЫДЕЛЕННОМУ письму работает над всем
             * выделением — так же, как перетаскивание в этом же списке.
             *
             * Раньше пункты меню шли по одному письму под курсором, а
             * `clearSelection` внутри действий уничтожал выделение из
             * двадцати строк: человек отмечал галочками два десятка писем,
             * выбирал «Удалить» — уезжало одно, а набирать выделение
             * приходилось заново. Два соседних жеста над одной строкой
             * делали разное.
             *
             * Щелчок по НЕвыделенной строке выделение не трогает: он
             * относится к этой строке, и это тоже привычно. Здесь стояло
             * `clearSelection()` — прямо против написанного выше: человек
             * набирал два десятка галочек, чуть промахивался правой
             * кнопкой мимо выделения — и весь набор пропадал. Меню и так
             * работает по contextTargets(), которое само решает, над чем
             * действовать, так что снимать выделение незачем.
             */
            setFocusedId(message.id);
            setContextMenu({ message, x, y, view: 'main' });
          }}
        />
      )}

      {reviewTab && (
        <MailboxReview
          initialTab={reviewTab}
          folders={folders ?? []}
          onClose={() => setReviewTab(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          {contextMenu.view === 'main' ? (
            <>
              {/* Группа 1 */}
              <ContextMenuItem
                before={<IconNewTab />}
                onClick={() =>
                  window.open(
                    `/${contextMenu.message.folderId}/${encodeURIComponent(contextMenu.message.id)}`,
                    '_blank',
                  )
                }
              >
                Открыть в новой вкладке
              </ContextMenuItem>
              <ContextMenuItem before={<IconCheckAll />} onClick={() => selectMany(allIds)}>
                Выделить все письма
              </ContextMenuItem>
              <ContextMenuSeparator />
              {/* Группа 2 */}
              <ContextMenuItem
                before={<IconTrash />}
                onClick={() => moveTo(contextTargets(), 'trash')}
              >
                Удалить
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconArchive />}
                onClick={() => moveTo(contextTargets(), 'archive')}
              >
                В архив
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconSpam />}
                onClick={() => moveTo(contextTargets(), 'spam')}
              >
                Спам
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconFolder />}
                keepOpen
                onClick={() => setContextMenu({ ...contextMenu, view: 'folders' })}
              >
                Переместить в папку…
              </ContextMenuItem>
              {snoozeState.available && !snoozedFolder && (
                <ContextMenuItem
                  before={<IconClock />}
                  keepOpen
                  onClick={() => setContextMenu({ ...contextMenu, view: 'snooze' })}
                >
                  Отложить до…
                </ContextMenuItem>
              )}
              {snoozedFolder && (
                <ContextMenuItem before={<IconClock />} onClick={() => returnNow(contextTargets())}>
                  Вернуть сейчас
                </ContextMenuItem>
              )}
              {/* «Заглушить переписку» — в той же группе, что «В архив» и
                  «Отложить»: все три про «убрать с глаз», и человек ищет
                  их рядом. Пункта нет, пока заглушка не доедет до доставки. */}
              {mutedState.available && mutedState.delivery && !mutedFolder && (
                <ContextMenuItem before={<IconMuted />} onClick={() => muteRows(contextTargets())}>
                  Заглушить переписку
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              {/* Группа 3 */}
              <ContextMenuItem
                before={<IconMailUnread />}
                hint="U"
                onClick={() => applyFlags(contextTargets(), { seen: false })}
              >
                Пометить непрочитанным
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconFlag />}
                hint="I"
                onClick={() => toggleFlagOn(contextTargets())}
              >
                Пометить флажком
              </ContextMenuItem>
              {/* Метки — рядом с флажком: это соседние по смыслу пометки,
                  только флажок один на всё, а меток сколько угодно.
                  Правится вся переписка (см. пояснение у labelTargetsOf). */}
              <ContextMenuLabels
                messages={labelTargetsOf(contextTargets())}
                targetIds={expand(contextTargets())}
              />
              <ContextMenuSeparator />
              {/* Группа 4 */}
              <ContextMenuItem
                before={<IconFilter />}
                hint="Shift+L"
                onClick={() => createFilter(contextMenu.message.from.address)}
              >
                Создать фильтр
              </ContextMenuItem>
              <ContextMenuSeparator />
              {/* Группа 5 */}
              <ContextMenuItem
                before={<IconSearch />}
                onClick={() => findFromSender(contextMenu.message.from.address)}
              >
                Найти все письма отправителя
              </ContextMenuItem>
            </>
          ) : contextMenu.view === 'snooze' ? (
            <>
              <ContextMenuItem
                keepOpen
                onClick={() => setContextMenu({ ...contextMenu, view: 'main' })}
              >
                ← Назад
              </ContextMenuItem>
              <ContextMenuSeparator />
              {/* Готовые сроки. Произвольная дата живёт в панели действий:
                  поле ввода внутри контекстного меню закрывалось бы от
                  первого же щелчка по календарю. */}
              {(Object.keys(PRESET_TITLES) as Array<Exclude<SnoozePreset, 'custom'>>).map(
                (preset) => (
                  <ContextMenuItem
                    key={preset}
                    before={<IconClock />}
                    onClick={() => snoozeTo(contextTargets(), { preset })}
                  >
                    {PRESET_TITLES[preset]}
                  </ContextMenuItem>
                ),
              )}
            </>
          ) : (
            <>
              <ContextMenuItem
                keepOpen
                onClick={() => setContextMenu({ ...contextMenu, view: 'main' })}
              >
                ← Назад
              </ContextMenuItem>
              <ContextMenuSeparator />
              {otherFolders.map((f) => (
                <ContextMenuItem
                  key={f.id}
                  before={<IconFolder />}
                  onClick={() => moveTo(contextTargets(), f.id)}
                >
                  {f.depth > 0 ? `  ${folderTitle(f)}` : folderTitle(f)}
                </ContextMenuItem>
              ))}
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
