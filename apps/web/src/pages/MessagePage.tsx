/**
 * Просмотр письма: панель действий, плашка надёжного отправителя,
 * тема с чипом категории, блок отправителя, тело письма (HTML вставляется
 * в DOM — санируется на сервере), блокировка внешних картинок, вложения.
 * Плашки помощника на основе ИИ появляются здесь же — но только если
 * администратор его разрешил (см. src/ai/aiVisibility.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Message } from '@mail-true/shared';
import {
  AiMessageBanners,
  AiSummaryButton,
  AiTranslateMenuItem,
  AiTranslatedBody,
  useMessageAi,
} from '../ai/MessageAi';
import { useFolders, useMessage, useMessages, useMoveMessages, useSetFlags } from '../api/queries';
import { MESSAGES_PAGE_SIZE } from '../api/client';
import { useUiStore } from '../app/store';
import { Button, Dropdown, IconButton, MenuItem, Spinner, Tooltip } from '../components';
import { isReliable, messageCategory } from '../lib/categories';
import { forwardInit, quoteHtml, replyInit } from '../lib/composeFromMessage';
import { errorText, isNotFoundError } from '../lib/errorText';
import { blockedImageCount, shouldOfferImages } from '../lib/externalImages';
import { serializeRulePrefill } from '../lib/filterRules';
import { unsubscribeLinks } from '../lib/unsubscribe';
import { hotkeyFor } from '../lib/hotkeys';
import { formatMessageDate } from '../lib/listDates';
import {
  IconArchive,
  IconArrowLeft,
  IconArrowRight,
  IconFilter,
  IconFlag,
  IconFolder,
  IconForward,
  IconMailUnread,
  IconMore,
  IconPrint,
  IconReply,
  IconSearch,
  IconShield,
  IconSpam,
  IconTrash,
  IconUnsubscribe,
} from '../mail/icons';
import { MessageThread } from '../mail/MessageThread';
import { searchUrlFor } from '../search/searchParams';
import { useGeneralPreferences } from '../settings/generalSettings';
import styles from './MessagePage.module.css';
import { folderTitle } from '../lib/folderNames';

/** Детерминированный цвет аватара из адреса отправителя. */
function avatarHue(address: string): number {
  let h = 0;
  for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** «Имя <адрес>» либо просто адрес, если имени нет. */
function formatAddress(a: { name: string | null; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Ссылка на часть письма: вложение или встроенная картинка. */
function partUrl(messageId: string, partId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/parts/${encodeURIComponent(partId)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

export function MessagePage() {
  const { folderId = 'inbox', messageId } = useParams();
  const navigate = useNavigate();
  const id = messageId ? decodeURIComponent(messageId) : undefined;
  /**
   * Внешние картинки. Блокирует их сервер: без `images=1` в теле стоят
   * прозрачные пиксели, а настоящие адреса лежат в `data-mt-src`. Поэтому
   * «Показать» — это не переключатель на клиенте, а повторный запрос письма.
   */
  const [showImages, setShowImages] = useState(false);
  const {
    data: message,
    isPending,
    isError,
    error,
    refetch,
  } = useMessage(id, { images: showImages });
  const { data: page } = useMessages({
    folderId,
    offset: 0,
    limit: MESSAGES_PAGE_SIZE,
    threaded: false,
    filter: 'all',
  });
  const { data: folders } = useFolders();
  const setFlags = useSetFlags();
  const moveMessages = useMoveMessages();
  const openCompose = useUiStore((s) => s.openCompose);
  const preferences = useGeneralPreferences();

  const [showDetails, setShowDetails] = useState(false);

  // Открытое письмо помечаем прочитанным
  useEffect(() => {
    if (message && !message.flags.seen) {
      setFlags.mutate({ ids: [message.id], set: { seen: true } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id]);

  useEffect(() => setShowImages(false), [id]);

  // Соседние письма в папке — стрелки перехода
  const { prevId, nextId } = useMemo(() => {
    const items = page?.items ?? [];
    const index = items.findIndex((m) => m.id === id);
    return {
      prevId: index > 0 ? (items[index - 1]?.id ?? null) : null,
      nextId: index >= 0 && index < items.length - 1 ? (items[index + 1]?.id ?? null) : null,
    };
  }, [page, id]);

  /** Сколько картинок заблокировал сервер — по этому числу и плашка. */
  const blockedImages = useMemo(() => blockedImageCount(message), [message]);

  /**
   * Письма той же цепочки из уже загруженного списка папки. Если их больше
   * одного, «Кратко» резюмирует всю переписку, а не одно письмо.
   */
  const threadIds = useMemo(() => {
    if (!message) return [];
    const own = (page?.items ?? []).filter((m) => m.threadId === message.threadId);
    const ids = own.map((m) => m.id);
    return ids.includes(message.id) ? ids : [message.id, ...ids];
  }, [page, message]);

  /**
   * Остальные письма цепочки — старые сверху, как в mail.ru. Список берётся
   * из уже загруженной страницы папки: отдельного маршрута цепочки в API нет
   * (`GET /api/threads/:id` — см. отчёт), поэтому за пределами первой сотни
   * писем цепочка окажется неполной.
   */
  const threadRest = useMemo(() => {
    if (!message) return [];
    return (page?.items ?? [])
      .filter((m) => m.threadId === message.threadId && m.id !== message.id)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [page, message]);

  const ai = useMessageAi({ messageId: message?.id, threadIds });

  const goBack = () => navigate(`/${folderId}/`);

  /**
   * Куда уходить после того, как письмо покинуло папку, — общая настройка
   * «После удаления письма». Следующего письма может не оказаться (удалили
   * последнее в папке), тогда остаётся список: показывать пустой экран
   * вместо письма было бы хуже любого из двух обещанных вариантов.
   */
  const goAfterRemoved = () => {
    if (preferences.afterDelete === 'next-message' && nextId) {
      navigate(`/${folderId}/${encodeURIComponent(nextId)}`);
      return;
    }
    goBack();
  };

  // Уходим со страницы только после ответа сервера. Раньше уходили сразу,
  // и неудавшееся перемещение выглядело удавшимся: письмо «исчезало»
  // из виду, хотя оставалось на месте.
  const moveTo = (target: string) => {
    if (!message) return;
    moveMessages.mutate(
      { ids: [message.id], targetFolderId: target },
      { onSuccess: goAfterRemoved },
    );
  };

  // Ответ и пересылка объявлены до горячих клавиш: обработчик клавиатуры
  // зовёт ровно то же, что кнопки панели, — иначе R и «Ответить» разошлись бы.
  const reply = () => {
    if (!message) return;
    openCompose(replyInit(message, preferences.quoteOriginalOnReply));
  };

  const forward = () => {
    if (!message) return;
    openCompose(forwardInit(message));
  };

  // Горячие клавиши письма: R, F, Delete, U, I, Shift+J, Shift+L, Ctrl+P, Esc
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Пока фокус на кнопке панели, ссылке или поле ввода — клавиши их
      if (!message) return;
      const action = hotkeyFor(e, e.target);
      switch (action) {
        case 'reply':
          e.preventDefault();
          reply();
          return;
        case 'forward':
          e.preventDefault();
          forward();
          return;
        case 'delete':
          e.preventDefault();
          moveTo('trash');
          return;
        case 'toggle-unread':
          e.preventDefault();
          setFlags.mutate({ ids: [message.id], set: { seen: false } });
          navigate(`/${folderId}/`);
          return;
        case 'toggle-flag':
          e.preventDefault();
          setFlags.mutate({ ids: [message.id], set: { flagged: !message.flags.flagged } });
          return;
        case 'spam':
          e.preventDefault();
          // Через тот же moveTo, что и кнопка меню: иначе Shift+J уносил бы
          // в список даже при настройке «переходить к следующему письму».
          moveTo('spam');
          return;
        case 'create-filter':
          e.preventDefault();
          void navigate(
            `/settings/filters?new=${encodeURIComponent(
              serializeRulePrefill('from', message.from.address),
            )}`,
          );
          return;
        case 'print':
          e.preventDefault();
          window.print();
          return;
        case 'close':
          e.preventDefault();
          navigate(`/${folderId}/`);
          return;
        default:
          return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    message,
    folderId,
    navigate,
    setFlags,
    moveMessages,
    nextId,
    preferences.afterDelete,
    preferences.quoteOriginalOnReply,
    openCompose,
  ]);

  if (isPending) {
    return (
      <div className={styles.centered}>
        <Spinner size={28} />
      </div>
    );
  }

  // «Нет письма» и «не смогли загрузить» — разные беды, и говорить
  // о них надо по-разному: раньше на любую ошибку показывалось
  // «Письмо не найдено», и повторить попытку было нечем.
  if (isError || !message) {
    const notFound = isNotFoundError(error) || (!isError && !message);
    return (
      <div className={styles.centered}>
        <div className={styles.loadError}>
          <p className={styles.loadErrorText}>
            {notFound ? 'Письмо не найдено' : `Не удалось загрузить письмо. ${errorText(error)}`}
          </p>
          <div className={styles.loadErrorActions}>
            {!notFound && (
              <Button mode="secondary" onClick={() => void refetch()}>
                Повторить
              </Button>
            )}
            <Button mode="tertiary" onClick={goBack}>
              К списку писем
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const reliable = isReliable(message.labels);
  const category = messageCategory(message.labels);
  // Заголовки сервер отдаёт в нижнем регистре, поэтому ищем без учёта
  // регистра и понимаем сводный `list` от mailparser (см. lib/unsubscribe.ts)
  const unsubscribe = unsubscribeLinks(message.headers);
  const toMe = message.to.length === 1 ? 'вам' : message.to.map((a) => a.name ?? a.address).join(', ');

  /**
   * Отписка. Своего маршрута для неё в API нет (в отчёте это отмечено),
   * поэтому делаем то же, что почтовые клиенты без серверной поддержки:
   * веб-адрес открываем в новой вкладке, а mailto — готовым письмом
   * в окне написания. Молчаливой заглушки здесь больше нет.
   */
  const doUnsubscribe = () => {
    if (!unsubscribe) return;
    if (unsubscribe.http) {
      window.open(unsubscribe.http, '_blank', 'noopener,noreferrer');
      return;
    }
    if (unsubscribe.mailto) {
      const url = new URL(unsubscribe.mailto);
      openCompose({
        to: url.pathname,
        subject: url.searchParams.get('subject') ?? 'unsubscribe',
        bodyHtml: '<p>unsubscribe</p>',
      });
    }
  };

  return (
    <article className={styles.page}>
      {/* Панель действий */}
      <div className={styles.toolbar}>
        <IconButton label="К списку" onClick={goBack}>
          <IconArrowLeft size={20} />
        </IconButton>
        <Button mode="tertiary" before={<IconTrash />} onClick={() => moveTo('trash')}>
          Удалить
        </Button>
        <Button mode="tertiary" before={<IconArchive />} onClick={() => moveTo('archive')}>
          В архив
        </Button>
        <Dropdown
          trigger={({ toggle }) => (
            <Button mode="tertiary" before={<IconFolder />} onClick={toggle}>
              В папку
            </Button>
          )}
        >
          {(folders ?? [])
            .filter((f) => f.id !== folderId)
            .map((f) => (
              <MenuItem key={f.id} onClick={() => moveTo(f.id)}>
                {f.depth > 0 ? `  ${folderTitle(f)}` : folderTitle(f)}
              </MenuItem>
            ))}
        </Dropdown>
        {unsubscribe && (
          <Button mode="tertiary" before={<IconUnsubscribe />} onClick={doUnsubscribe}>
            Отписаться
          </Button>
        )}
        <Dropdown
          menuClassName={styles.moreMenu}
          trigger={({ toggle }) => (
            <IconButton label="Ещё действия" onClick={toggle}>
              <IconMore size={20} />
            </IconButton>
          )}
        >
          <MenuItem
            before={<IconMailUnread />}
            hint="U"
            onClick={() => {
              setFlags.mutate({ ids: [message.id], set: { seen: false } });
              goBack();
            }}
          >
            Пометить непрочитанным
          </MenuItem>
          <MenuItem
            before={<IconFlag />}
            hint="I"
            onClick={() =>
              setFlags.mutate({ ids: [message.id], set: { flagged: !message.flags.flagged } })
            }
          >
            {message.flags.flagged ? 'Снять флажок' : 'Пометить флажком'}
          </MenuItem>
          <MenuItem before={<IconSpam />} hint="Shift+J" onClick={() => moveTo('spam')}>
            Спам
          </MenuItem>
          <MenuItem before={<IconPrint />} hint="Ctrl+P" onClick={() => window.print()}>
            Распечатать
          </MenuItem>
          {/* Раньше это были заглушки — теперь есть куда вести */}
          <MenuItem
            before={<IconFilter />}
            hint="Shift+L"
            onClick={() =>
              void navigate(
                `/settings/filters?new=${encodeURIComponent(
                  serializeRulePrefill('from', message.from.address),
                )}`,
              )
            }
          >
            Создать фильтр
          </MenuItem>
          <MenuItem
            before={<IconSearch />}
            onClick={() => void navigate(searchUrlFor(message.from.address))}
          >
            Найти все письма отправителя
          </MenuItem>
          <AiTranslateMenuItem controller={ai} />
        </Dropdown>

        <Button mode="tertiary" before={<IconReply />} onClick={reply}>
          Ответить
        </Button>
        <Button mode="tertiary" before={<IconForward />} onClick={forward}>
          Переслать
        </Button>
        <AiSummaryButton controller={ai} />

        <div className={styles.spacer} />

        {/* Стрелки к соседним письмам */}
        <Tooltip text="Предыдущее письмо">
          <IconButton
            label="Предыдущее письмо"
            disabled={!prevId}
            onClick={() => prevId && navigate(`/${folderId}/${encodeURIComponent(prevId)}`)}
          >
            <IconArrowLeft size={20} />
          </IconButton>
        </Tooltip>
        <Tooltip text="Следующее письмо">
          <IconButton
            label="Следующее письмо"
            disabled={!nextId}
            onClick={() => nextId && navigate(`/${folderId}/${encodeURIComponent(nextId)}`)}
          >
            <IconArrowRight size={20} />
          </IconButton>
        </Tooltip>
      </div>

      <div className={styles.scroll}>
        {/* Плашка надёжного отправителя */}
        {reliable && (
          <div className={styles.reliableBanner}>
            <span className={styles.reliableIcon}>
              <IconShield />
            </span>
            Это письмо от надёжного отправителя
            <button type="button" className={styles.reliableMore}>
              Подробнее
            </button>
          </div>
        )}

        {/* Плашки помощника: резюме и извлечённые данные */}
        <AiMessageBanners controller={ai} />

        {/* Тема с чипом категории */}
        <div className={styles.subjectRow}>
          <h2 className={styles.subject}>{message.subject || '(без темы)'}</h2>
          {category && (
            <span className={styles.categoryChip}>
              <span
                className={styles.categoryChipDot}
                style={{ backgroundColor: `var(${category.colorVar})` }}
              />
              {category.name}
            </span>
          )}
        </div>

        {/* Блок отправителя */}
        <div className={styles.senderBlock}>
          <span
            className={styles.senderAvatar}
            style={{ backgroundColor: `hsl(${avatarHue(message.from.address)} 60% 55%)` }}
            aria-hidden="true"
          >
            {((message.from.name ?? message.from.address)[0] ?? '?').toUpperCase()}
          </span>
          <div className={styles.senderInfo}>
            <div className={styles.senderLine}>
              <span className={styles.senderName}>{message.from.name ?? message.from.address}</span>
              {/* Адрес рядом с именем. Раньше показывалось только имя, и когда
                  оно было, увидеть сам адрес было негде — а именно по адресу
                  и отличают настоящего отправителя от подделки. */}
              {message.from.name && (
                <span className={styles.senderAddress}>&lt;{message.from.address}&gt;</span>
              )}
              <span className={styles.senderDate}>{formatMessageDate(message.date)}</span>
            </div>
            <div className={styles.senderTo}>
              {/* Многоточие вешаем на сам перечень адресатов, а не на строку
                  целиком: у письма на два десятка получателей кнопка
                  «подробности» уезжала за край обрезанной строки — увидеть,
                  кому ещё ушло письмо, было нельзя ничем. */}
              <span className={styles.senderToText}>Кому: {toMe}</span>
              <button
                type="button"
                className={styles.detailsToggle}
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
              >
                {showDetails ? 'скрыть подробности' : 'подробности'}
              </button>
            </div>

            {showDetails && (
              <dl className={styles.details}>
                <dt>От</dt>
                <dd>{formatAddress(message.from)}</dd>
                {message.replyTo.length > 0 && (
                  <>
                    <dt>Ответить</dt>
                    <dd>{message.replyTo.map(formatAddress).join(', ')}</dd>
                  </>
                )}
                <dt>Кому</dt>
                <dd>{message.to.map(formatAddress).join(', ') || '—'}</dd>
                {message.cc.length > 0 && (
                  <>
                    <dt>Копия</dt>
                    <dd>{message.cc.map(formatAddress).join(', ')}</dd>
                  </>
                )}
                <dt>Дата</dt>
                <dd>{new Date(message.date).toLocaleString('ru-RU')}</dd>
                <dt>Подлинность</dt>
                <dd>
                  SPF: {message.authentication.spf} · DKIM: {message.authentication.dkim} · DMARC:{' '}
                  {message.authentication.dmarc}
                </dd>
                {message.messageId && (
                  <>
                    <dt>Идентификатор</dt>
                    <dd className={styles.detailsMono}>{message.messageId}</dd>
                  </>
                )}
                {Object.keys(message.headers).length > 0 && (
                  <>
                    <dt>Заголовки</dt>
                    <dd>
                      <details className={styles.headers}>
                        <summary>Показать заголовки письма</summary>
                        <pre className={styles.headersBody}>
                          {Object.entries(message.headers)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join('\n')}
                        </pre>
                      </details>
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>
          <div className={styles.senderActions}>
            <Tooltip text="Распечатать">
              {/* 20px, как размер значка в шапке mail.ru: при 16px кнопка
                  печати терялась — пользователь её не находил. */}
              <IconButton label="Распечатать" onClick={() => window.print()}>
                <IconPrint size={20} />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        {/* Заблокированные внешние картинки. Счётчик — от сервера */}
        {shouldOfferImages(message, showImages) && (
          <div className={styles.imagesBar}>
            Внешние картинки заблокированы для вашей безопасности
            {blockedImages > 0 ? ` (${blockedImages})` : ''}.
            <button type="button" className={styles.imagesShow} onClick={() => setShowImages(true)}>
              Показать
            </button>
          </div>
        )}

        {/* Тело письма — HTML вставляется в DOM (санируется на сервере).
            Когда включён перевод, вместо оригинала показывается он. */}
        {ai.translationShown && ai.translation ? (
          <AiTranslatedBody controller={ai} />
        ) : message.bodyHtml ? (
          <div className={styles.body} dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />
        ) : (
          <pre className={styles.bodyText}>{message.bodyText}</pre>
        )}

        {/* Вложения */}
        {message.attachments.length > 0 && (
          <div className={styles.attachments}>
            <div className={styles.attachmentsTitle}>
              Вложения ({message.attachments.length})
            </div>
            <div className={styles.attachmentsList}>
              {message.attachments.map((a) => (
                // Именно ссылка, а не блок: раньше вложение было нарисовано
                // обычным div-ом без обработчика, поэтому не открывалось и
                // не скачивалось — при том что маршрут отдачи части письма
                // в API есть и работает.
                <a
                  key={a.partId}
                  className={styles.attachment}
                  href={partUrl(message.id, a.partId)}
                  download={a.filename}
                  title={`${a.filename} — ${a.mimeType}`}
                >
                  <span className={styles.attachmentExt}>
                    {(a.filename.split('.').pop() ?? '?').toUpperCase()}
                  </span>
                  <span className={styles.attachmentInfo}>
                    <span className={styles.attachmentName}>{a.filename}</span>
                    <span className={styles.attachmentSize}>{formatSize(a.size)}</span>
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Нижняя панель действий по содержимому */}
        <div className={styles.bottomBar}>
          <Button mode="secondary" before={<IconReply />} onClick={reply}>
            Ответить
          </Button>
          <Button mode="secondary" before={<IconForward />} onClick={forward}>
            Переслать
          </Button>
          {unsubscribe && (
            <Button mode="secondary" before={<IconUnsubscribe />} onClick={doUnsubscribe}>
              Отписаться от рассылки
            </Button>
          )}
        </div>

        {/* Остальные письма переписки — свёрнутыми строками по 48px */}
        <MessageThread messages={threadRest} totalCount={threadRest.length + 1} />
      </div>
    </article>
  );
}
