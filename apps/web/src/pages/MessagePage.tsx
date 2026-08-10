/**
 * Просмотр письма: панель действий, плашка надёжного отправителя,
 * тема с чипом категории, блок отправителя, тело письма (HTML вставляется
 * в DOM — санируется на сервере), блокировка внешних картинок, вложения.
 * Плашки помощника на основе ИИ появляются здесь же — но только если
 * администратор его разрешил (см. src/ai/aiVisibility.ts).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { MAIL_BODY_CLASS, type Message, type MessageListQuery } from '@mail-true/shared';
import {
  AiMessageBanners,
  AiSummaryButton,
  AiTranslateMenuItem,
  AiTranslatedBody,
  useMessageAi,
} from '../ai/MessageAi';
import {
  fetchMessageForQuote,
  useFolders,
  useMessage,
  useMessages,
  useMoveMessages,
  useSendReadReceipt,
  useSetFlags,
} from '../api/queries';
import { MESSAGES_PAGE_SIZE } from '../api/client';
import { useAccountAddress } from '../app/session';
import { useUiStore } from '../app/store';
import {
  Button,
  Dropdown,
  IconButton,
  MenuItem,
  MenuSeparator,
  Spinner,
  Tooltip,
} from '../components';
import { LabelMenu } from '../mail/LabelMenu';
import { orderedMessages } from '../mail/MessageList';
import { LabelPills } from '../mail/LabelPill';
import { useApplyLabels, useLabelsState } from '../mail/useLabels';
import { isReliable, messageCategory } from '../lib/categories';
import { recipientLabel } from '../lib/recipients';
import { forwardInit, replyInit } from '../lib/composeFromMessage';
import { collectForwardAttachments } from '../lib/forwardAttachments';
import { errorText, isNotFoundError } from '../lib/errorText';
import { blockedImageCount, shouldOfferImages } from '../lib/externalImages';
import { serializeRulePrefill } from '../lib/filterRules';
import { annotatePrintLinks, printAddress, printAddresses, printDate } from '../lib/printMessage';
import { readReceiptAsk, readReceiptWho } from '../lib/readReceipt';
import { unsubscribeLinks } from '../lib/unsubscribe';
import { hotkeyFor } from '../lib/hotkeys';
import { useSwipeBack } from '../lib/useSwipeBack';
import { formatMessageDate } from '../lib/listDates';
import {
  IconArchive,
  IconArrowLeft,
  IconArrowRight,
  IconClock,
  IconCode,
  IconDownload,
  IconEye,
  IconFilter,
  IconFlag,
  IconFolder,
  IconForward,
  IconMailUnread,
  IconMore,
  IconPencil,
  IconPrint,
  IconReply,
  IconSearch,
  IconShield,
  IconSpam,
  IconTrash,
  IconUnsubscribe,
} from '../mail/icons';
import { AttachmentViewer } from '../mail/AttachmentViewer';
import { canPreview } from '../mail/attachments';
import { MessageSource } from '../mail/MessageSource';
import { SnoozeMenu } from '../mail/SnoozeMenu';
import { useSnoozeMessages, useSnoozeState, useUnsnoozeMessages } from '../mail/useSnooze';
import type { SnoozePreset } from '../mail/snoozeApi';
import { MessageThread } from '../mail/MessageThread';
import { SenderAuth } from '../mail/SenderAuth';
import { SenderAvatar } from '../mail/SenderAvatar';
import { useOpenDraft } from '../compose/useOpenDraft';
import { searchUrlFor } from '../search/searchParams';
import { useGeneralPreferences } from '../settings/generalSettings';
import styles from './MessagePage.module.css';
import { folderTitle } from '../lib/folderNames';

/* Цвет кружка и буква в нём переехали в SenderAvatar: тот же кружок теперь
   умеет показывать логотип домена, и три копии этого кода (список, цепочка,
   открытое письмо) разошлись бы при первой же правке — в одном месте
   логотип, в двух других буква. */

/** «Имя <адрес>» либо просто адрес, если имени нет. */
function formatAddress(a: { name: string | null; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Ссылка на часть письма: вложение или встроенная картинка. */
function partUrl(messageId: string, partId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/parts/${encodeURIComponent(partId)}`;
}

/** Ссылка на письмо целиком — файл .eml, байт в байт как оно пришло. */
function sourceUrl(messageId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/source`;
}

/** Есть ли в письме текст. Пробелы и переводы строк текстом не считаются. */
export function hasBodyText(message: Pick<Message, 'bodyText'>): boolean {
  return (message.bodyText ?? '').trim() !== '';
}

/**
 * Что написать вместо тела, когда его нет.
 *
 * Пустое письмо и письмо, у которого сервер не смог разобрать ни одной
 * текстовой части, выглядели одинаково — пустым местом. Разделять эти два
 * случая интерфейсу нечем (в обоих `bodyHtml` и `bodyText` пусты), поэтому
 * подпись говорит ровно то, что известно наверняка: текста нет. Если при
 * письме есть вложения, это сразу и объясняет, почему.
 */
export function emptyBodyText(message: Pick<Message, 'attachments'>): string {
  return message.attachments.length > 0
    ? 'В этом письме нет текста — только вложения.'
    : 'В этом письме нет текста.';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

export function MessagePage() {
  const { folderId = 'inbox', messageId } = useParams();
  const navigate = useNavigate();
  // Нужен, чтобы взять тело письма с настоящими адресами картинок при
  // ответе и пересылке — см. fetchMessageForQuote.
  const queryClient = useQueryClient();
  // Адрес открытого ящика: по нему решается, писали ли письмо «вам».
  const myAddress = useAccountAddress();
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
  /*
   * Соседи берутся из ТОГО ЖЕ списка, из которого человек пришёл.
   *
   * Здесь стояло «threaded: false, filter: all» жёстко, независимо от
   * вида списка. В папке с отбором «Непрочитанные» стрелка «Следующее»
   * уводила в прочитанное письмо, которого в списке человека не было, а
   * возврат «К списку» приводил не туда, где он остановился.
   */
  const storedView = useUiStore((s) => s.listView);
  /*
   * Вид применяем ТОЛЬКО к той папке, для которой он снят.
   *
   * Пришли в письмо из поиска, по прямой ссылке или из уведомления —
   * вида этой папки у нас нет, и брать чужой нельзя: отбор
   * «Непрочитанные» от «Входящих» превращал бы список соседей для
   * «Спама» в чужой (а с меткой, которой в этой папке нет, — в пустой,
   * с мёртвыми стрелками). Тогда берём обычный список папки.
   */
  const listView =
    storedView.folderId === folderId
      ? storedView
      : { threaded: false, filter: 'all' as const, labelFilter: null };
  const listQuery: MessageListQuery = {
    folderId,
    offset: 0,
    limit: MESSAGES_PAGE_SIZE,
    threaded: listView.threaded,
    filter: listView.filter,
    ...(listView.labelFilter ? { label: listView.labelFilter } : {}),
    /*
     * БЕЗ НАЧАЛ ПИСЕМ — НО ТОЛЬКО КОГДА ЭТОТ ЗАПРОС ОТДЕЛЬНЫЙ.
     *
     * Отсюда список нужен для одного: узнать соседей открытого письма,
     * чтобы работали стрелки «предыдущее» и «следующее». Текста в этих
     * строках не видно нигде, а стоит он дорого: начало письма читается
     * ОТДЕЛЬНОЙ командой на каждое письмо, последовательно, по
     * единственному соединению ящика — до сотни команд IMAP на страницу.
     *
     * Но при выключенной группировке этот же запрос — тот самый, из
     * которого берётся блок «Ещё писем в переписке», а там свёрнутые
     * строки показывают начало письма. Поэтому признак ставится только
     * когда запросов действительно два, то есть при включённой
     * группировке: тогда соседи считаются по этому, а переписка — по
     * отдельному плоскому, и он начала сохраняет.
     */
    ...(listView.threaded ? { snippets: false } : {}),
  };
  const { data: page } = useMessages(listQuery);
  /**
   * Тот же отбор, но БЕЗ группировки — ради самой переписки.
   *
   * С группировкой сервер отдаёт по одной строке на разговор: в списке
   * лежит только последнее письмо каждого, а остальных нет вовсе. Поэтому
   * блок «Ещё писем в переписке» оказывался пуст, и разговор из шести
   * писем показывал ровно одну реплику — ту, что открыли. Без группировки
   * (как было раньше жёстко прописано) письма были на месте, то есть
   * возможность ломалась ровно от включения переписок в настройках.
   *
   * Когда группировка выключена, это тот же самый ключ запроса, что и
   * выше, — второго обращения к серверу не будет.
   */
  /*
   * Плоский список ВСЕГДА с началами писем: из него рисуется блок
   * «Ещё писем в переписке», где свёрнутая строка показывает начало.
   * Признак `snippets` из listQuery сюда не переносится намеренно —
   * иначе при группировке блок остался бы без текста.
   */
  const flatQuery: MessageListQuery = (() => {
    const { snippets: _dropped, ...rest } = listQuery;
    return { ...rest, threaded: false };
  })();
  const { data: flatPage } = useMessages(flatQuery);
  const { data: folders } = useFolders();
  const setFlags = useSetFlags();
  const moveMessages = useMoveMessages();
  /* Свои метки: справочник (имена и цвета) и простановка. Оба хука стоят
     здесь, до первого раннего выхода, — иначе порядок хуков менялся бы
     между «письмо загружается» и «письмо показано». */
  const { available: labelsAvailable, items: labelDictionary } = useLabelsState();
  const applyLabels = useApplyLabels();
  const updateComposeDraft = useUiStore((s) => s.updateComposeDraft);
  const showNotice = useUiStore((s) => s.showNotice);
  const openCompose = useUiStore((s) => s.openCompose);
  const setVisitedMessage = useUiStore((s) => s.setVisitedMessage);
  const readReceipt = useSendReadReceipt(id);
  const preferences = useGeneralPreferences();
  /*
   * «Отложить» в панели письма. Состояние спрашивается у сервера: пока он
   * не сказал `available`, кнопки нет вовсе — за ней стоят база и работник
   * возврата, и без них она была бы мёртвой.
   */
  const snoozeState = useSnoozeState();
  const snoozeMessages = useSnoozeMessages();
  const unsnooze = useUnsnoozeMessages();

  const [showDetails, setShowDetails] = useState(false);
  /** Открыто окно «Исходный текст письма». */
  const [showSource, setShowSource] = useState(false);
  /**
   * Какое вложение открыто в предпросмотре (номер в `message.attachments`)
   * или null, если окно закрыто. Именно номер, а не сам файл: из окна
   * вложения листаются стрелками, и номер — то, что при этом меняется.
   */
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  /**
   * Дописывание черновика. Сюда попадают по прямой ссылке, из поиска или
   * из «открыть в новой вкладке»: щелчок по строке в папке «Черновики»
   * открывает окно написания сразу, минуя просмотр.
   */
  const { openDraft, loading: draftOpening } = useOpenDraft();
  /** Тело письма в DOM — по нему размечаются ссылки для печати. */
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Пока открыто письмо, на `body` висит метка режима печати.
   *
   * По ней действуют правила `@media print` (MessagePage.module.css):
   * они снимают с бумаги весь интерфейс и оставляют только лист письма.
   * Метка нужна именно потому, что правила глобальные: без неё печать
   * списка писем давала бы пустой лист.
   */
  useEffect(() => {
    document.body.dataset.mtPrint = 'message';
    return () => {
      delete document.body.dataset.mtPrint;
    };
  }, []);

  /**
   * Запоминаем, какое письмо человек смотрит: вернувшись в список, он увидит
   * его строку подсвеченной и на прежнем месте.
   *
   * Ставится на КАЖДОЕ показанное письмо, а не один раз при входе, — и это
   * не мелочь: стрелки «предыдущее/следующее» листают письма прямо здесь,
   * и вернуться человек ждёт к последнему прочитанному, а не к тому,
   * с которого начал.
   */
  useEffect(() => {
    if (id) setVisitedMessage(folderId, id);
  }, [folderId, id, setVisitedMessage]);

  /**
   * Открытое письмо помечаем прочитанным — по одному разу на письмо.
   *
   * Раньше `seen: true` уходил заново при каждом возврате к тому же
   * письму: пометки правились в списке, а САМО письмо лежит под своим
   * ключом кэша и оставалось непрочитанным до перезагрузки страницы —
   * вместе с ним возвращался и запрос. Ключ письма теперь сбрасывается
   * вместе со списком (useInvalidateMail в api/queries.ts), а здесь стоит
   * замок от повтора внутри одного просмотра.
   */
  const markedReadId = useRef<string | null>(null);
  useEffect(() => {
    if (!message || message.flags.seen) return;
    if (markedReadId.current === message.id) return;
    markedReadId.current = message.id;
    setFlags.mutate({ ids: [message.id], set: { seen: true } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, message?.flags.seen]);

  useEffect(() => setShowImages(false), [id]);

  /* Перешли к соседнему письму — окно предпросмотра закрывается вместе с
     письмом: его вложений в новом письме нет, а номер части остался бы
     прежним и открыл бы чужой файл. */
  useEffect(() => setPreviewIndex(null), [id]);

  /**
   * Адреса ссылок для печати. Тело письма вставляется готовой разметкой,
   * поэтому разметить ссылки можно только по факту — уже в DOM. Делается
   * это один раз на письмо, а не при каждой печати: печать вызывается и
   * горячей клавишей, и из меню браузера, где перехватить её нечем.
   */
  useEffect(() => {
    annotatePrintLinks(bodyRef.current);
  }, [message?.id, message?.bodyHtml]);

  /**
   * Соседние письма в папке — стрелки перехода.
   *
   * Ищем СТРОКУ списка, в которую попало открытое письмо, а не письмо
   * с таким же идентификатором. При группировке строку представляет
   * последнее письмо разговора, поэтому у письма, открытого из блока
   * «Ещё писем в переписке» (или по прямой ссылке, или из поиска),
   * совпадения не находилось вовсе — обе стрелки гасли намертво.
   */
  const { prevId, nextId } = useMemo(() => {
    /*
     * Соседи берутся в том порядке, в каком строки НАРИСОВАНЫ в списке.
     *
     * Раньше это был сырой ответ сервера, а список переставляет строки:
     * вернувшиеся из «Отложенных» и оставшиеся без ответа поднимаются
     * группами наверх. Человек открывал первое письмо сверху, жал
     * «Следующее» — и попадал не во вторую строку экрана, а в письмо из
     * середины списка; вернувшись «К списку», не находил места, где
     * остановился.
     */
    const rows = orderedMessages(page?.items ?? []);
    const index = rows.findIndex(
      (m) => m.id === id || (m.thread?.messageIds ?? []).some((mid) => mid === id),
    );
    return {
      prevId: index > 0 ? (rows[index - 1]?.id ?? null) : null,
      nextId: index >= 0 && index < rows.length - 1 ? (rows[index + 1]?.id ?? null) : null,
    };
  }, [page, id]);

  /** Сколько картинок заблокировал сервер — по этому числу и плашка. */
  const blockedImages = useMemo(() => blockedImageCount(message), [message]);

  /**
   * Письма той же цепочки. Если их больше одного, «Кратко» резюмирует всю
   * переписку, а не одну реплику.
   *
   * Сводка переписки от сервера (`thread.messageIds`) знает про ВСЮ папку,
   * поэтому она здесь первый источник; плоский список добавляет то, чего
   * в сводке нет (её не бывает без группировки).
   */
  const threadIds = useMemo(() => {
    if (!message) return [];
    const ids = [message.id];
    const add = (value: string) => {
      if (!ids.includes(value)) ids.push(value);
    };
    /*
     * СТРОКУ СПИСКА ИЩЕМ ПО СОСТАВУ ЦЕПОЧКИ, А НЕ ПО threadId.
     *
     * Строку представляет ПОСЛЕДНЕЕ письмо разговора, а `threadId`
     * считается как «ссылка на родителя или свой Message-ID»
     * (mail/summary.ts). Для переписки A→B→C→D это даёт разные значения
     * у открытого письма и у представителя строки, и совпадения почти
     * никогда нет: сводка от сервера, где лежит ВЕСЬ состав цепочки,
     * не находилась, и «Кратко» резюмировало одну реплику вместо
     * переписки.
     *
     * Соседние стрелки в этом же файле ищут строку правильно — через
     * `thread.messageIds`; здесь было по-другому, и работал только один
     * из двух поисков.
     */
    const row = (page?.items ?? []).find(
      (m) => m.id === message.id || (m.thread?.messageIds ?? []).some((mid) => mid === message.id),
    );
    const inThread = new Set(row?.thread?.messageIds ?? []);
    for (const mid of inThread) add(mid);
    /*
     * Плоский список добавляет то, чего нет в сводке. Отбираем по
     * СОСТАВУ цепочки, а не по равенству threadId: по нему один
     * разговор распадается на «звёзды» вокруг каждого родителя, и в
     * подборку попадала бы только пара писем.
     */
    for (const m of flatPage?.items ?? []) {
      if (inThread.has(m.id) || m.threadId === message.threadId) add(m.id);
    }
    return ids;
  }, [page, flatPage, message]);

  /**
   * Остальные письма цепочки — старые сверху, как в привычных почтовых интерфейсах. Список берётся
   * из плоской страницы папки: отдельного маршрута цепочки в API нет
   * (`GET /api/threads/:id` — см. отчёт), поэтому за пределами первой сотни
   * писем цепочка окажется неполной.
   */
  const threadRest = useMemo(() => {
    if (!message) return [];
    /*
     * Состав цепочки берётся из threadIds — он собран из сводки сервера
     * (IMAP THREAD=REFS знает про всю папку) и из плоского списка.
     *
     * Раньше здесь стояло равенство `threadId`, и блок «Ещё писем в
     * переписке» был ПУСТ для любого разговора длиннее двух писем:
     * threadId у A и B совпадает, у C он уже указывает на B, у D — на C.
     * Сервер при этом присылал правильный состав, а страница им не
     * пользовалась — человек видел одну реплику там, где разговор из
     * четырёх.
     */
    const inThread = new Set(threadIds);
    return (flatPage?.items ?? [])
      .filter((m) => m.id !== message.id && (inThread.has(m.id) || m.threadId === message.threadId))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [flatPage, message, threadIds]);

  const ai = useMessageAi({ messageId: message?.id, threadIds });

  /*
   * Обещание навигации наружу не отдаётся: goBack передаётся и в жест
   * «назад», и в onClick — а там ждут обычную функцию, и отказ обещания
   * никто бы не поймал. Сам отказ означает отменённый переход, чинить
   * его нечем и показывать человеку нечего.
   */
  const goBack = () => {
    void navigate(`/${folderId}/`);
  };

  /**
   * Назад к списку пальцем от левого края. Кнопка «К списку» стоит в левом
   * верхнем углу — на телефоне это самый недосягаемый угол экрана, и одной
   * рукой до неё не дотянуться. Кнопка при этом никуда не делась.
   */
  const swipeBack = useSwipeBack(goBack);

  /**
   * Куда уходить после того, как письмо покинуло папку, — общая настройка
   * «После удаления письма». Следующего письма может не оказаться (удалили
   * последнее в папке), тогда остаётся список: показывать пустой экран
   * вместо письма было бы хуже любого из двух обещанных вариантов.
   */
  const goAfterRemoved = () => {
    if (preferences.afterDelete === 'next-message' && nextId) {
      void navigate(`/${folderId}/${encodeURIComponent(nextId)}`);
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

  /**
   * Отложить открытое письмо.
   *
   * После откладывания письмо уходит из папки — значит, и со страницы
   * уходим туда же, куда после удаления и переноса: это ровно тот же
   * случай «письма здесь больше нет», и вести себя иначе он не должен.
   * Уходим только ПОСЛЕ ответа сервера: неудавшееся откладывание не должно
   * выглядеть удавшимся.
   */
  const snoozeTo = (choice: { preset: SnoozePreset; until?: string }) => {
    if (!message) return;
    snoozeMessages.mutate(
      {
        ids: [message.id],
        preset: choice.preset,
        ...(choice.until ? { until: choice.until } : {}),
      },
      { onSuccess: goAfterRemoved },
    );
  };

  /** «Вернуть сейчас» — из открытого письма в папке «Отложенные». */
  const returnNow = () => {
    if (!message) return;
    unsnooze.mutate([message.id], { onSuccess: goAfterRemoved });
  };

  // Ответ и пересылка объявлены до горячих клавиш: обработчик клавиатуры
  // зовёт ровно то же, что кнопки панели, — иначе R и «Ответить» разошлись бы.
  const reply = () => {
    if (!message) return;
    /*
     * Цитата берётся отдельным запросом — с настоящими адресами картинок.
     * То, что на экране, приготовлено для чтения: внешние картинки там
     * заменены пустым пикселем, и отправить такое письмо значит отправить
     * его без картинок. Пока запрос идёт, окно уже открыто с прежним
     * телом: письмо человек всё равно дописывает, а подмена тела на месте
     * заняла бы у него курсор.
     */
    void fetchMessageForQuote(queryClient, message.id)
      .then((full) => openCompose(replyInit(full, preferences.quoteOriginalOnReply)))
      .catch(() => openCompose(replyInit(message, preferences.quoteOriginalOnReply)));
  };

  /**
   * Пересылка: вложения исходного письма переносим в новое.
   *
   * Отдельным шагом, потому что их надо скачать и загрузить обратно, а
   * окно должно открыться сразу. Пока файлы едут, человек уже набирает
   * текст — они появятся в списке вложений по мере готовности.
   */
  const bringAttachments = async (message: Message, windowId: number): Promise<void> => {
    if ((message.attachments ?? []).every((a) => a.inline)) return;
    // Отметка «вложения ещё едут» ставится ДО первого запроса: между
    // открытием окна и приездом файлов человек успевает нажать
    // «Отправить», и письмо уходило без них — молча.
    updateComposeDraft(windowId, (draft) => ({
      pendingAttachments: draft.pendingAttachments + 1,
    }));
    try {
      const { attachments, failed } = await collectForwardAttachments(message);
      if (attachments.length > 0) {
        updateComposeDraft(windowId, (draft) => ({
          attachments: [...draft.attachments, ...attachments],
        }));
      }
      if (failed.length > 0) {
        // Молчать нельзя: человек уверен, что вложения на месте, и пишет
        // «см. вложение».
        showNotice(`Не удалось перенести вложения: ${failed.join(', ')}`);
      }
    } finally {
      updateComposeDraft(windowId, (draft) => ({
        pendingAttachments: Math.max(0, draft.pendingAttachments - 1),
      }));
    }
  };

  const forward = () => {
    if (!message) return;
    // Тот же довод, что и у ответа: пересылать нужно тело с настоящими
    // адресами картинок, а не заготовку для чтения.
    void fetchMessageForQuote(queryClient, message.id)
      .then((full) => {
        const windowId = openCompose(forwardInit(full));
        void bringAttachments(full, windowId);
      })
      .catch(() => {
        const windowId = openCompose(forwardInit(message));
        void bringAttachments(message, windowId);
      });
  };

  /**
   * «Переслать как вложение»: письмо прикладывается целиком (message/rfc822),
   * а не пересказывается цитатой. Так доходят и заголовки исходного письма,
   * и его вложения, и подпись, — это единственный способ переслать письмо
   * без искажений, и именно за ним сюда и приходят.
   */
  const forwardAsAttachment = () => {
    if (!message) return;
    openCompose({
      subject: message.subject.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      attachMessages: [{ id: message.id, label: message.subject || '(без темы)' }],
    });
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
          void navigate(`/${folderId}/`);
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
          void navigate(`/${folderId}/`);
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
  /**
   * Это неотправленный черновик. Смотрим и на флаг письма, и на папку:
   * флаг `\Draft` ставит тот, кто письмо сохранил, и у писем, положенных
   * в папку черновиков со стороны (отказ отложенной отправки, другая
   * почтовая программа), его может не быть.
   */
  const isDraft = message.flags.draft || message.folderId === 'drafts';
  /** Продолжить набор письма — то же окно, что и по щелчку в «Черновиках». */
  const continueDraft = () => openDraft(message.uid);
  // Заголовки сервер отдаёт в нижнем регистре, поэтому ищем без учёта
  // регистра и понимаем сводный `list` от mailparser (см. lib/unsubscribe.ts)
  const unsubscribe = unsubscribeLinks(message.headers);
  /*
   * «вам» пишется, только если письмо и правда адресовано ЭТОМУ ящику.
   *
   * Условие было «получатель ровно один», и адрес учётной записи здесь не
   * спрашивался ни разу. Поэтому у любого письма с одним адресатом
   * подпись выходила «Кому: вам» — в том числе в «Отправленных», где
   * каждое письмо сообщало человеку, что он написал его сам себе.
   * Подпись под адресом отвечает на вопрос «а мне ли это писали», и
   * отвечать на него неправдой хуже, чем не отвечать вовсе.
   */
  const toMe = recipientLabel(message.to, myAddress);
  /**
   * Отправитель просит уведомить о прочтении. Плашка показывается, пока
   * человек не ответил: флаг `$MDNSent` сервер ставит и на «отправить»,
   * и на «не отправлять» (RFC 3503), поэтому вопрос не возвращается ни
   * после перезагрузки, ни в другой почтовой программе.
   */
  const receiptAsk = message.flags.mdnSent ? null : readReceiptAsk(message.headers);

  /**
   * Отписка. Своего маршрута для неё в API нет (в отчёте это отмечено),
   * поэтому делаем то же, что почтовые клиенты без серверной поддержки:
   * веб-адрес открываем в новой вкладке, а mailto — готовым письмом
   * в окне написания. Молчаливой заглушки здесь больше нет.
   */
  /**
   * Сохранить письмо файлом .eml.
   *
   * Скачивается ИСХОДНИК с сервера, а не собранное в браузере из разобранных
   * полей: файл .eml открывают в другой почтовой программе и им же проверяют
   * подпись DKIM, а она считается по исходным байтам. Любая пересборка —
   * другие переводы строки, другой порядок заголовков — делает файл
   * бесполезным ровно там, где он нужнее всего.
   *
   * Имя файла (тема и дата) ставит сервер заголовком Content-Disposition,
   * поэтому у ссылки `download` без значения: с пустым значением браузер
   * берёт имя с сервера, а не выдумывает своё из адреса.
   */
  const saveEml = () => {
    const link = document.createElement('a');
    link.href = sourceUrl(message.id);
    link.download = '';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  };

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
    <article className={styles.page} {...swipeBack}>
      {/* Панель действий */}
      <div className={styles.toolbar}>
        <IconButton label="К списку" onClick={goBack}>
          <IconArrowLeft size={20} />
        </IconButton>
        {/* У черновика главное действие — не «удалить» и не «ответить»,
            а дописать его. Поэтому кнопка стоит первой и она главная. */}
        {isDraft && (
          <Button
            mode="primary"
            before={<IconPencil />}
            onClick={continueDraft}
            disabled={draftOpening}
          >
            {draftOpening ? 'Открываем…' : 'Продолжить'}
          </Button>
        )}
        <Button mode="tertiary" before={<IconTrash />} onClick={() => moveTo('trash')}>
          Удалить
        </Button>
        <Button mode="tertiary" before={<IconArchive />} onClick={() => moveTo('archive')}>
          В архив
        </Button>
        {/* «Отложить» стоит между «В архив» и «В папку»: три соседних
            действия одного рода — убрать письмо с глаз. */}
        {snoozeState.available && folderId !== 'snoozed' && (
          <SnoozeMenu onSnooze={snoozeTo} scheduledReturn={snoozeState.scheduledReturn} />
        )}
        {folderId === 'snoozed' && (
          <Button mode="tertiary" before={<IconClock />} onClick={returnNow}>
            Вернуть сейчас
          </Button>
        )}
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
          {/*
            Метки прямо в меню «⋯», а не отдельным видом меню: список
            короткий, а метки вешают по нескольку сразу — переход
            туда-обратно за каждой стоил бы двух лишних нажатий.
            Меню не закрывается по нажатию на метку намеренно.
          */}
          {labelsAvailable && (
            <>
              <MenuSeparator />
              <LabelMenu messages={[{ id: message.id, labels: message.labels }]} />
              <MenuSeparator />
            </>
          )}
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
          <MenuItem before={<IconForward />} onClick={forwardAsAttachment}>
            Переслать как вложение
          </MenuItem>
          {/*
            «Исходный текст письма», а не «Показать оригинал»: слово
            «оригинал» ничего не обещает — из него не понять, откроется
            перевод, картинки или что-то ещё. Здесь же сказано ровно то,
            что откроется: текст письма как он есть, со всеми заголовками.
          */}
          <MenuItem before={<IconCode />} onClick={() => setShowSource(true)}>
            Исходный текст письма
          </MenuItem>
          {/*
            Скачивание стоит рядом с показом исходника, а не внутри него:
            это одно и то же письмо, но разные надобности. Исходник читают
            глазами; файл .eml забирают, чтобы положить в дело, открыть
            другой почтовой программой или переслать целиком. Прежде за
            файлом приходилось сперва открывать окно исходника.
          */}
          <MenuItem before={<IconDownload />} onClick={saveEml}>
            Сохранить письмо (.eml)
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
            onClick={() => {
              if (prevId) void navigate(`/${folderId}/${encodeURIComponent(prevId)}`);
            }}
          >
            <IconArrowLeft size={20} />
          </IconButton>
        </Tooltip>
        <Tooltip text="Следующее письмо">
          <IconButton
            label="Следующее письмо"
            disabled={!nextId}
            onClick={() => {
              if (nextId) void navigate(`/${folderId}/${encodeURIComponent(nextId)}`);
            }}
          >
            <IconArrowRight size={20} />
          </IconButton>
        </Tooltip>
      </div>

      <div className={styles.scroll}>
        {/*
          Шапка листа. На экране её нет вовсе (display:none), она существует
          ради печати: на бумаге нужны отправитель, адресаты, дата и перечень
          вложений — на экране всё это разбросано по блокам, часть спрятана
          за «подробности», а «Кому: вам» на листе не значит ничего.

          Это НЕ копия разметки в отдельном окне: тот же компонент, те же
          данные одного рендера, поэтому разъехаться с письмом ей не с чем.
        */}
        <header className={styles.printHead}>
          <h1 className={styles.printSubject}>{message.subject || '(без темы)'}</h1>
          <dl className={styles.printMeta}>
            <dt>От кого</dt>
            <dd>{printAddress(message.from)}</dd>
            <dt>Кому</dt>
            <dd>{printAddresses(message.to)}</dd>
            {message.cc.length > 0 && (
              <>
                <dt>Копия</dt>
                <dd>{printAddresses(message.cc)}</dd>
              </>
            )}
            <dt>Дата</dt>
            <dd>{printDate(message.date)}</dd>
            {message.attachments.length > 0 && (
              <>
                {/* Самих файлов на бумаге не будет, но знать, что они были
                    и как назывались, человеку нужно */}
                <dt>Вложения</dt>
                <dd>
                  {message.attachments
                    .map((a) => `${a.filename} (${formatSize(a.size)})`)
                    .join(', ')}
                </dd>
              </>
            )}
          </dl>
        </header>

        {/*
          Плашка черновика.

          Сюда попадают по прямой ссылке, из поиска или открыв черновик в
          новой вкладке — то есть человек видит просмотр письма и должен
          сразу понимать две вещи: письмо НЕ отправлено и его можно дописать.
          Раньше не было ни того, ни другого: черновик выглядел как обычное
          полученное письмо, и продолжить его было нечем.
        */}
        {isDraft && (
          <div className={styles.draftBanner}>
            <span className={styles.draftText}>Это черновик — письмо ещё не отправлено.</span>
            <Button
              mode="primary"
              size="s"
              before={<IconPencil />}
              onClick={continueDraft}
              disabled={draftOpening}
            >
              {draftOpening ? 'Открываем…' : 'Продолжить'}
            </Button>
          </div>
        )}

        {/* Плашка надёжного отправителя */}
        {reliable && (
          <div className={styles.reliableBanner}>
            <span className={styles.reliableIcon}>
              <IconShield />
            </span>
            Это письмо от надёжного отправителя
            {/*
              «Подробнее» раньше не делало ничего: обработчика у кнопки не
              было вовсе. в привычных почтовых интерфейсах она ведёт в справку, а справки у нас нет
              — зато есть то, на чём эта плашка и держится: результаты
              проверки подлинности отправителя (SPF, DKIM, DMARC) и его
              настоящий адрес. Их и раскрываем — это и есть «подробнее».
            */}
            <button
              type="button"
              className={styles.reliableMore}
              aria-expanded={showDetails}
              onClick={() => setShowDetails(true)}
            >
              Подробнее
            </button>
          </div>
        )}

        {/*
          Отправитель просит уведомить о прочтении. Уведомление уходит
          ТОЛЬКО по нажатию: молча подтверждать, что письмо открыто и когда,
          нельзя — это чужое знание о человеке, и заодно подтверждение
          живого адреса для рассылок. Отказ здесь такое же полноценное
          решение, как согласие, и запоминается он так же.
        */}
        {receiptAsk && (
          <div className={styles.receiptBanner}>
            <span className={styles.receiptText}>
              Отправитель просит уведомить о прочтении письма. Уведомление уйдёт на{' '}
              {readReceiptWho(receiptAsk)}.
            </span>
            <Button
              mode="secondary"
              size="s"
              disabled={readReceipt.isPending}
              onClick={() => readReceipt.mutate(true)}
            >
              Уведомить
            </Button>
            <Button
              mode="tertiary"
              size="s"
              disabled={readReceipt.isPending}
              onClick={() => readReceipt.mutate(false)}
            >
              Не уведомлять
            </Button>
          </div>
        )}

        {/* Плашки помощника: резюме и извлечённые данные */}
        <AiMessageBanners controller={ai} />

        {/* Тема с чипом категории */}
        <div className={styles.subjectRow}>
          {/* Длинная тема обрезается тремя строками — целиком её видно
              в подсказке, иначе обрезанное было бы недоступно вовсе */}
          <h2 className={styles.subject} title={message.subject || undefined}>
            {message.subject || '(без темы)'}
          </h2>
          {category && (
            <span className={styles.categoryChip}>
              <span
                className={styles.categoryChipDot}
                style={{ backgroundColor: `var(${category.colorVar})` }}
              />
              {category.name}
            </span>
          )}
          {/*
            Свои метки письма — цветными пилюлями С НАЗВАНИЕМ, рядом с
            темой. Крестик на пилюле снимает метку прямо отсюда: снять
            метку — самое частое действие с ней («оплатил»), и уводить
            за этим в меню значило бы прятать его на два нажатия.
          */}
          <LabelPills
            keywords={message.labels}
            dictionary={labelDictionary}
            large
            onRemove={(key) => applyLabels.mutate({ ids: [message.id], remove: [key] })}
          />
        </div>

        {/* Блок отправителя */}
        <div className={styles.senderBlock}>
          {/* Тот же кружок, что и в списке писем, — один компонент на оба
              места. Здесь это особенно важно: именно на открытом письме
              человек решает, доверять ли ему, и кружок обязан показывать
              то же самое, что он видел в списке. Логотип ставится ТОЛЬКО
              отправителю, прошедшему проверку подлинности; решение принял
              сервер (apps/api/src/mail/sender-auth.ts). */}
          <SenderAvatar
            className={styles.senderAvatar}
            name={message.from.name ?? message.from.address}
            address={message.from.address}
            logoDomain={message.senderLogoDomain}
          />
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
                  {/* Было «SPF: none · DKIM: pass · DMARC: pass» — набор слов
                      для того, кто в этом не разбирается, а спрашивают об
                      этом как раз тогда, когда письмо выглядит подозрительно.
                      Значки и человеческие пояснения — в SenderAuth. */}
                  <SenderAuth authentication={message.authentication} />
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
              {/* 20px, как размер значка в шапке привычных почтовых интерфейсов: при 16px кнопка
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
          <div
            ref={bodyRef}
            /* MAIL_BODY_CLASS обязателен: к нему сервер приписывает все
               селекторы из блока <style> письма (mail/sanitize.ts). Без
               этого класса стили письма просто не найдут своей области —
               а раньше они находили всю страницу почты. */
            className={`${styles.body} ${MAIL_BODY_CLASS}`}
            dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
          />
        ) : hasBodyText(message) ? (
          <pre className={styles.bodyText}>{message.bodyText}</pre>
        ) : (
          /* Тела нет вовсе. Раньше здесь оставался пустой <pre>, и пустое
             письмо выглядело точно так же, как не разобранное. */
          <p className={styles.emptyBody}>{emptyBodyText(message)}</p>
        )}

        {/* Вложения */}
        {message.attachments.length > 0 && (
          <div className={styles.attachments}>
            <div className={styles.attachmentsTitle}>Вложения ({message.attachments.length})</div>
            <div className={styles.attachmentsList}>
              {message.attachments.map((a, i) => {
                /*
                 * Что делает нажатие на карточку, зависит от того, умеем ли
                 * мы показать этот файл. Кнопка появляется вместе с
                 * поведением: у архива и таблицы «глаза» нет вовсе, и
                 * нажатие на карточку по-прежнему скачивает — а не открывает
                 * окно с извинениями.
                 *
                 * Скачивание при этом есть ВСЕГДА, отдельной кнопкой справа:
                 * посмотреть и сохранить — разные надобности, и заставлять
                 * открывать окно ради второй было бы шагом назад.
                 */
                const previewable = canPreview(a);
                const face = (
                  <>
                    <span className={styles.attachmentExt}>
                      {(a.filename.split('.').pop() ?? '?').toUpperCase()}
                    </span>
                    <span className={styles.attachmentInfo}>
                      <span className={styles.attachmentName}>{a.filename}</span>
                      <span className={styles.attachmentSize}>{formatSize(a.size)}</span>
                    </span>
                    {previewable && (
                      <span className={styles.attachmentEye} aria-hidden="true">
                        <IconEye size={16} />
                      </span>
                    )}
                  </>
                );
                return (
                  <div key={a.partId} className={styles.attachment}>
                    {previewable ? (
                      <button
                        type="button"
                        className={styles.attachmentMain}
                        onClick={() => setPreviewIndex(i)}
                        title={`Посмотреть ${a.filename} — ${a.mimeType}`}
                      >
                        {face}
                      </button>
                    ) : (
                      // Именно ссылка, а не блок: раньше вложение было
                      // нарисовано обычным div-ом без обработчика, поэтому
                      // не открывалось и не скачивалось — при том что
                      // маршрут отдачи части письма в API есть и работает.
                      <a
                        className={styles.attachmentMain}
                        href={partUrl(message.id, a.partId)}
                        download={a.filename}
                        title={`Скачать ${a.filename} — ${a.mimeType}`}
                      >
                        {face}
                      </a>
                    )}
                    <a
                      className={styles.attachmentDownload}
                      href={partUrl(message.id, a.partId)}
                      download={a.filename}
                      title="Скачать"
                      aria-label={`Скачать ${a.filename}`}
                    >
                      <IconDownload size={16} />
                    </a>
                  </div>
                );
              })}
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

      {/* Исходник письма. Окно стоит рядом с листом, а не внутри тела:
          иначе правила печати унесли бы его на бумагу вместе с письмом. */}
      {showSource && (
        <MessageSource
          messageId={message.id}
          subject={message.subject}
          onClose={() => setShowSource(false)}
        />
      )}

      {/* Предпросмотр вложения — там же и по той же причине, что окно
          исходника: правила печати не должны утащить его на бумагу. */}
      {previewIndex !== null && message.attachments[previewIndex] && (
        <AttachmentViewer
          messageId={message.id}
          attachments={message.attachments}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </article>
  );
}
