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
import { forwardInit, replyInit } from '../lib/composeFromMessage';
import { actionErrorText, errorText } from '../lib/errorText';
import { serializeRulePrefill } from '../lib/filterRules';
import { selectAllLabel } from '../lib/paging';
import { hotkeyFor } from '../lib/hotkeys';
import { useGeneralPreferences } from '../settings/generalSettings';
import { searchUrlFor } from '../search/searchParams';
import { ListSkeleton } from '../mail/ListSkeleton';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '../mail/ContextMenu';
import { EmptyFolder } from '../mail/EmptyFolder';
import {
  IconArchive,
  IconCheckAll,
  IconFilter,
  IconFlag,
  IconFolder,
  IconMailUnread,
  IconNewTab,
  IconSearch,
  IconSpam,
  IconTrash,
} from '../mail/icons';
import { ListToolbar } from '../mail/ListToolbar';
import { MessageList } from '../mail/MessageList';
import styles from './FolderPage.module.css';
import { folderTitle } from '../lib/folderNames';

interface ContextMenuState {
  message: MessageSummary;
  x: number;
  y: number;
  /** «Переместить в папку» раскрывает список папок внутри меню. */
  view: 'main' | 'folders';
}

export function FolderPage() {
  const { folderId = 'inbox' } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<MessageFilter>('all');
  const { data: folders } = useFolders();
  // Письма подгружаются страницами: сервер отдаёт не больше сотни за раз,
  // а в папке их бывает вдвое больше — раньше остальные были недостижимы.
  const page = useFolderMessages(folderId, filter);
  const setFlags = useSetFlags();
  const moveMessages = useMoveMessages();

  const showNotice = useUiStore((s) => s.showNotice);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const selectMany = useUiStore((s) => s.selectMany);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const openCompose = useUiStore((s) => s.openCompose);
  const preferences = useGeneralPreferences();
  const queryClient = useQueryClient();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Письма, уже уезжающие из папки: перенос отправлен, ответа ещё нет. */
  const [leavingIds, setLeavingIds] = useState<readonly string[]>([]);

  const messages = page.items;

  // Смена папки: сбрасываем выделение, курсор и фильтр
  useEffect(() => {
    clearSelection();
    setFocusedId(null);
    setFilter('all');
    setContextMenu(null);
    setLeavingIds([]);
  }, [folderId, clearSelection]);

  // Уехавшие письма пропали из списка — метку можно снять
  useEffect(() => {
    if (leavingIds.length === 0) return;
    if (leavingIds.some((id) => messages.some((m) => m.id === id))) return;
    setLeavingIds([]);
  }, [messages, leavingIds]);

  /** Письма, к которым применяется действие: выделенные, иначе — под курсором. */
  const targetIds = useCallback((): string[] => {
    if (selectedIds.size > 0) return [...selectedIds];
    if (focusedId) return [focusedId];
    return [];
  }, [selectedIds, focusedId]);

  const applyFlags = useCallback(
    (ids: string[], set: Parameters<typeof setFlags.mutate>[0]['set']) => {
      if (ids.length === 0) return;
      setFlags.mutate({ ids, set });
      clearSelection();
    },
    [setFlags, clearSelection],
  );

  const moveTo = useCallback(
    (ids: string[], targetFolderId: string) => {
      if (ids.length === 0) return;
      // Строки гаснут сразу: ждать ответа сервера, чтобы показать отклик,
      // нельзя — при неудаче метка снимается и письма возвращаются на место.
      setLeavingIds(ids);
      moveMessages.mutate(
        { ids, targetFolderId },
        { onError: () => setLeavingIds([]) },
      );
      clearSelection();
      setFocusedId(null);
    },
    [moveMessages, clearSelection],
  );

  /** Подгрузка следующей страницы — по прокрутке до конца списка. */
  const loadMore = page.loadMore;

  const openMessage = useCallback(
    (id: string) => navigate(`/${folderId}/${encodeURIComponent(id)}`),
    [navigate, folderId],
  );

  /**
   * «Создать фильтр» — окно правила в настройках с подставленным
   * отправителем. Адрес берётся у письма под курсором или у первого
   * выделенного: правило строится по одному отправителю, а не по пачке.
   */
  const createFilter = useCallback(
    (address?: string) => {
      const from =
        address ??
        messages.find((m) => m.id === (focusedId ?? [...selectedIds][0]))?.from.address;
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
        openCompose(
          kind === 'reply'
            ? replyInit(message, preferences.quoteOriginalOnReply)
            : forwardInit(message),
        );
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
    ],
  );

  /** Пометить флажком: если все цели уже с флагом — снять. */
  const toggleFlagOn = useCallback(
    (ids: string[]) => {
      const targets = messages.filter((m) => ids.includes(m.id));
      const allFlagged = targets.length > 0 && targets.every((m) => m.flags.flagged);
      applyFlags(ids, { flagged: !allFlagged });
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
              : Math.min(messages.length - 1, Math.max(0, index + (action === 'nav-down' ? 1 : -1)));
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
  const currentFolder = (folders ?? []).find((f) => f.id === folderId);
  const allIds = useMemo(() => messages.map((m) => m.id), [messages]);
  /** Список загружен и в нём нет ни одного письма. */
  const emptyFolder = !page.isPending && !page.isError && messages.length === 0;

  return (
    <div className={styles.page}>
      <ListToolbar
        selectedCount={selectedIds.size}
        selectAllLabel={selectAllLabel(page.loaded, page.total)}
        emptyFolder={emptyFolder}
        filter={filter}
        onFilterChange={setFilter}
        folders={otherFolders}
        onSelectAll={() => selectMany(allIds)}
        onClearSelection={clearSelection}
        onMarkAllRead={() => applyFlags(allIds, { seen: true })}
        onDelete={() => moveTo(targetIds(), 'trash')}
        onArchive={() => moveTo(targetIds(), 'archive')}
        onMoveTo={(target) => moveTo(targetIds(), target)}
        // Отписка живёт в письме: адрес отписки берётся из его заголовков.
        // Молчаливой заглушки здесь быть не должно — говорим, куда идти.
        onUnsubscribe={() =>
          showNotice('Отписаться можно в самом письме — там есть адрес отписки')
        }
        onMarkUnread={() => applyFlags(targetIds(), { seen: false })}
        onToggleFlag={() => toggleFlagOn(targetIds())}
        onSpam={() => moveTo(targetIds(), 'spam')}
        onPrint={() => window.print()}
        onCreateFilter={() => createFilter()}
        onForwardAsAttachment={() =>
          console.info('Пересылка как вложение появится вместе с бэкендом')
        }
      />

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

      {!page.isPending && !page.isError && messages.length === 0 && (
        <EmptyFolder role={currentFolder?.role ?? folderId} />
      )}

      {messages.length > 0 && (
        <MessageList
          /* Ключ по папке: список монтируется заново — и прокрутка начинается
             сверху, и появление новой папки видно */
          key={folderId}
          messages={messages}
          focusedId={focusedId}
          leavingIds={leavingIds}
          onEndReached={loadMore}
          onContextMenu={(message, x, y) => {
            setFocusedId(message.id);
            setContextMenu({ message, x, y, view: 'main' });
          }}
        />
      )}

      {/*
        Подвал списка — только кнопка «Показать ещё» и только пока есть что
        показывать. Она нужна и при подгрузке по прокрутке: бывает, что
        прокручивать нечего (короткое окно, мышь без колеса).

        Подписи «Показано 11 из 11» здесь больше нет: у mail.ru такого
        элемента не существует ни в каком виде, а на догруженном до конца
        списке она к тому же сообщала ровно ничего.
      */}
      {messages.length > 0 && page.hasMore && (
        <div className={styles.listFooter}>
          <Button mode="secondary" onClick={loadMore} disabled={page.isLoadingMore}>
            {page.isLoadingMore ? 'Загружаем…' : 'Показать ещё'}
          </Button>
        </div>
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
                onClick={() => moveTo([contextMenu.message.id], 'trash')}
              >
                Удалить
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconArchive />}
                onClick={() => moveTo([contextMenu.message.id], 'archive')}
              >
                В архив
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconSpam />}
                onClick={() => moveTo([contextMenu.message.id], 'spam')}
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
              <ContextMenuSeparator />
              {/* Группа 3 */}
              <ContextMenuItem
                before={<IconMailUnread />}
                hint="U"
                onClick={() => applyFlags([contextMenu.message.id], { seen: false })}
              >
                Пометить непрочитанным
              </ContextMenuItem>
              <ContextMenuItem
                before={<IconFlag />}
                hint="I"
                onClick={() => toggleFlagOn([contextMenu.message.id])}
              >
                Пометить флажком
              </ContextMenuItem>
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
                  onClick={() => moveTo([contextMenu.message.id], f.id)}
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
