/**
 * Окно написания письма (.compose-app привычный почтовый интерфейс): 880px, радиус 12px,
 * тень rgba(0,16,61,.16) 0 4px 32px. Поля Кому / От кого / Тема
 * с раскрытием «Копии» и «Скрытой», панель форматирования на
 * contenteditable (без сторонних редакторов), подпись, нижняя панель
 * Отправить / Сохранить / Отменить. Поддерживает свёрнутое состояние
 * и несколько окон одновременно.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import {
  useAccount,
  useMoveMessages,
  useSaveDraft,
  useSendMessage,
  useUndoSend,
} from '../api/queries';
import { useSendAsExternal, useSenders, type SenderOption } from '../api/accountsQueries';
import { useUiStore, type ComposeDraft, type ComposeWindowState } from '../app/store';
import { Button, Dropdown, IconButton, MenuItem, Tooltip, useDropdownClose } from '../components';
import { RecipientField } from '../contacts/RecipientField';
import { parseAddresses } from '../lib/addresses';
import { cx } from '../lib/cx';
import { actionErrorText } from '../lib/errorText';
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconAttach,
  IconChevronDown,
  IconClearFormat,
  IconClose,
  IconEmoji,
  IconEvent,
  IconFontFamily,
  IconForward,
  IconLink,
  IconListBulleted,
  IconListNumbered,
  IconMailRead,
  IconRedo,
  IconTemplate,
  IconUndo,
} from '../mail/icons';
import {
  firstRecipient,
  prepareTemplateBody,
  prepareTemplateSubject,
  unresolvedPlaceholders,
  templatesApi,
  type MailTemplate,
  type SubstitutionContext,
} from '../mail/templatesApi';
import { useCreateTemplate, useTemplatesState } from '../mail/useTemplates';
import { useGeneralSettings } from '../api/settingsQueries';
import {
  DEFAULT_GENERAL_SETTINGS,
  defaultSignature,
  signatureHtml,
} from '../settings/generalSettings';
import { ComposeAiPanel } from './ComposeAiPanel';
import { MailAttachmentPicker } from './MailAttachmentPicker';
import { SaveTemplateDialog, TemplateMenu } from './TemplateMenu';
import { failureSummary } from './SendFailureBanner';
import { UndoSendBar } from './UndoSendBar';
import { useComposeGeometry } from './useComposeGeometry';
import styles from './ComposeWindow.module.css';

/**
 * Метка блока подписи внутри тела письма.
 *
 * Именно атрибут, а не класс: классы здесь из CSS-модулей, их имена
 * пересобираются, и искать блок по ним значило бы зависеть от сборки.
 */
const SIGNATURE_MARK = 'data-mt-signature';

/**
 * Своя часть ключа окна написания — на одну загрузку страницы.
 *
 * Номера окон начинаются заново после каждой перезагрузки вкладки, а ключ
 * уходит на сервер и живёт там дольше окна (см. draftKey ниже). Совпади
 * номера — сервер счёл бы новое пустое окно продолжением давно закрытого
 * и удалил бы чужой черновик вместо своего. Случайная часть это исключает.
 */
const WINDOW_KEY_PREFIX = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Через сколько тишины письмо само уходит в «Черновики».
 *
 * Три секунды — это пауза между фразами, а не между письмами: набирающий
 * текст человек упирается в неё по десятку раз за письмо, и каждый раз
 * черновик обновляется. Меньше — и запись пошла бы посреди слова, больше —
 * и «сохранено» отставало бы от написанного настолько, что потеря стала бы
 * заметной. Запись при этом дешёвая: уходит только то, что изменилось с
 * прошлого раза (см. слепок письма ниже), и одно окно шлёт не больше
 * одного запроса зараз.
 */
const AUTOSAVE_DELAY_MS = 3_000;

interface ComposeWindowProps {
  win: ComposeWindowState;
  /** Порядковый номер развёрнутого окна — для каскада. */
  offset: number;
  /** Сдвиг свёрнутой плашки от левого края, px. */
  minimizedLeft?: number;
  /**
   * Порядковый номер плашки «Письмо отправлено · Отменить» снизу вверх.
   * Когда писем отправили несколько подряд, плашки встают друг над другом,
   * а не одна поверх другой.
   */
  undoIndex?: number;
}

const FONT_FAMILIES = ['Golos Text', 'Arial', 'Georgia', 'JetBrains Mono'];
const FONT_SIZES: Array<[string, string]> = [
  ['1', '10'],
  ['2', '13'],
  ['3', '15'],
  ['4', '18'],
  ['5', '24'],
  ['6', '32'],
];
const EMOJI = ['🙂', '😄', '👍', '🙏', '🔥', '❤️', '🎉', '🤝'];

/**
 * Видимый текст разметки — без тегов, сущностей и пробелов.
 *
 * Нужен, чтобы сравнивать написанное с тем, что окно подставило само
 * (см. hasContent). Разметку сравнивать нельзя: браузер переписывает её на
 * свой лад при каждом касании редактора — переносит атрибуты, добавляет
 * `<br>` и неразрывные пробелы, — и одно только нажатие стрелки в тексте
 * делало бы письмо «изменённым». Сущности разворачиваются, потому что одна
 * и та же цитата приходит и разметкой (`&lt;`), и уже разобранным текстом.
 *
 * Пробелы выброшены целиком: `<div>а</div><div>б</div>` и `а б` — один и
 * тот же текст для человека, а вот для строкового сравнения это разные
 * строки.
 */
export function visibleText(html: string): string {
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // «&amp;» разворачивается последним: иначе «&amp;lt;» превратилось бы
      // в «<» и два разных текста стали бы неотличимы.
      .replace(/&amp;/gi, '&')
      // \s в JS покрывает и неразрывный пробел — их браузер расставляет сам
      .replace(/\s/g, '')
  );
}

/** Человеческая запись времени отложенной отправки: «6 августа в 09:00». */
export function formatSendAt(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day} в ${time}`;
}

/**
 * Значение для `<input type="datetime-local">` из момента времени.
 *
 * Поле работает в местном времени и не понимает ни «Z», ни смещения,
 * поэтому ISO-строку в него подставить нельзя: браузер молча покажет
 * пустое поле. Отсюда и ручная сборка.
 */
export function toLocalInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** Ближайшее «удобное» время по умолчанию — завтра в 9 утра, как в привычных почтовых интерфейсах. */
export function defaultSendAt(now: Date): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at;
}

/**
 * Выбор времени отложенной отправки.
 *
 * Отдельный компонент ради `useDropdownClose`: поле и кнопки нарисованы
 * не через `MenuItem`, и без этого меню осталось бы висеть поверх окна
 * с уже назначенным временем.
 */
function SendLaterMenu({
  value,
  onPick,
  onClear,
}: {
  value: string | null;
  onPick: (iso: string) => void;
  onClear: () => void;
}) {
  const close = useDropdownClose();
  const [local, setLocal] = useState(() =>
    toLocalInputValue(value ? new Date(value) : defaultSendAt(new Date())),
  );
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className={styles.sendLater}>
      <span className={styles.sendLaterTitle}>Отправить позже</span>
      <input
        type="datetime-local"
        className={styles.sendLaterInput}
        aria-label="Время отправки"
        value={local}
        min={toLocalInputValue(new Date())}
        onChange={(e) => setLocal(e.target.value)}
      />
      {problem && <span className={styles.sendLaterProblem}>{problem}</span>}
      <div className={styles.sendLaterActions}>
        <Button
          mode="primary"
          size="s"
          onClick={() => {
            const at = new Date(local);
            if (Number.isNaN(at.getTime())) {
              setProblem('Укажите дату и время');
              return;
            }
            // Меньше минуты сервер отправляет сразу — обещать «позже»
            // в этом случае значило бы соврать
            if (at.getTime() - Date.now() < 60_000) {
              setProblem('Выберите время хотя бы через минуту');
              return;
            }
            onPick(at.toISOString());
            close();
          }}
        >
          Назначить
        </Button>
        {value && (
          <Button
            mode="secondary"
            size="s"
            onClick={() => {
              onClear();
              close();
            }}
          >
            Отправить сразу
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Набор смайликов в меню. Отдельный компонент нужен ради `useDropdownClose`:
 * эти кнопки нарисованы не через `MenuItem`, а он закрывается сам, — без
 * этого меню оставалось бы висеть поверх уже изменившегося письма.
 */
function EmojiGrid({ onPick }: { onPick: (symbol: string) => void }) {
  const close = useDropdownClose();
  return (
    <div className={styles.emojiGrid}>
      {EMOJI.map((symbol) => (
        <button
          key={symbol}
          type="button"
          className={styles.emojiButton}
          aria-label={`Вставить ${symbol}`}
          onClick={() => {
            onPick(symbol);
            close();
          }}
        >
          {symbol}
        </button>
      ))}
    </div>
  );
}

/** Как назвать отправителя в списке и в поле «От кого». */
export function senderLabel(sender: SenderOption, displayName: string | null): string {
  if (sender.externalId === null) {
    return displayName ? `${displayName} <${sender.address}>` : sender.address;
  }
  return sender.label ? `${sender.label} <${sender.address}>` : sender.address;
}

export function ComposeWindow({
  win,
  offset,
  minimizedLeft = 16,
  undoIndex = 0,
}: ComposeWindowProps) {
  const { data: account } = useAccount();
  const senders = useSenders();
  const sendAsExternal = useSendAsExternal();
  // Подписи живут в общих настройках ящика. Раньше сюда подставлялось
  // `account.signature`, а его /api/account отдаёт пустой строкой — в письмо
  // уезжал пустой блок, и выбрать одну из заведённых подписей было негде.
  const { data: settings, isPending: settingsPending } = useGeneralSettings();
  const preferences = settings ?? DEFAULT_GENERAL_SETTINGS;
  const closeCompose = useUiStore((s) => s.closeCompose);
  const showNotice = useUiStore((s) => s.showNotice);
  const toggleMinimized = useUiStore((s) => s.toggleComposeMinimized);
  const updateDraft = useUiStore((s) => s.updateComposeDraft);
  const sendMessage = useSendMessage();
  const saveDraft = useSaveDraft();
  const undoSend = useUndoSend();
  /** Нужно ровно для одного — убрать за собой черновик, заведённый по таймеру. */
  const moveMessages = useMoveMessages();

  /**
   * Всё введённое живёт в общем состоянии окна, а не в локальном useState:
   * иначе сворачивание (а с ним — перерисовка в другом виде) стирало бы
   * письмо целиком.
   */
  const draft = win.draft;
  const patch = useCallback(
    (values: Partial<ComposeDraft> | ((draft: ComposeDraft) => Partial<ComposeDraft>)) =>
      updateDraft(win.id, values),
    [updateDraft, win.id],
  );

  const { to, cc, bcc, subject, showCc, showBcc, attachments, attachedMessages, savedAt } = draft;

  /**
   * Выбранный отправитель. Подключение могли удалить, пока окно висело
   * свёрнутым, — тогда молча возвращаемся к своему ящику: отправить
   * с несуществующего адреса всё равно нечем.
   */
  const currentSender =
    senders.find((s) => s.externalId === draft.fromExternalId) ?? senders[0] ?? null;
  const externalSender = currentSender?.externalId === null ? null : currentSender;
  const fromLabel = currentSender
    ? senderLabel(currentSender, account?.displayName ?? null)
    : (account?.email ?? '…');

  const [maximized, setMaximized] = useState(false);
  /*
   * Перетаскивание за шапку и растягивание за уголки. Развёрнутому на весь
   * экран окну двигаться некуда, поэтому там жесты выключены: иначе оно
   * съезжало бы, оставаясь размером с экран.
   */
  const {
    ref: windowRef,
    startGesture,
    style: geometryStyle,
  } = useComposeGeometry(win.id, win.geometry, !maximized);
  const [error, setError] = useState<string | null>(null);
  /** Открыт ли выбор вложения из уже пришедших писем («Из Почты»). */
  const [pickerOpen, setPickerOpen] = useState(false);

  /* --- Шаблоны писем -------------------------------------------------
   * Кнопки нет вовсе, пока сервер не сказал, что возможность у него есть
   * (нет базы или не применена миграция). Общее правило продукта: кнопка
   * появляется вместе с поведением — так же устроены метки и «Отложить». */
  const templates = useTemplatesState();
  const createTemplate = useCreateTemplate();
  /** Открыто ли окно «Сохранить как шаблон». */
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  /**
   * Про незаполненные подстановки уже предупредили.
   *
   * Один раз, а не каждый: «Здравствуйте, {{имя}}!» в отправленном письме —
   * это стыд, а вечный запрет отправки — это тупик. Человек, который
   * написал `{{номер договора}}` намеренно, жмёт «Отправить» второй раз и
   * уходит работать.
   */
  const [placeholdersWarned, setPlaceholdersWarned] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Начальное содержимое редактора.
   *
   * Пересчитывается только когда редактор действительно создаётся заново —
   * при открытии окна, при возврате из свёрнутого вида и при отмене
   * отправки. Во всех трёх случаях редактора в DOM нет, поэтому его
   * содержимое берётся из черновика: так набранный текст возвращается
   * на место вместе с окном. Внутри одного показа значение неизменно —
   * иначе React переписывал бы innerHTML на каждое нажатие клавиши и
   * курсор прыгал бы в начало.
   *
   * `draft.pending !== null` в зависимостях — не украшение: без него
   * вернувшееся из отмены письмо показало бы тело, каким оно было в момент
   * ОТКРЫТИЯ окна, то есть без единой набранной буквы.
   */
  const initialHtml = useMemo(() => {
    if (draft.bodyInitialized) return draft.bodyHtml;
    // Блок подписи заводится пустым: настройки с подписями приходят своим
    // запросом и почти всегда позже открытия окна. Текст в него положит
    // эффект ниже — место под него нужно уже сейчас, чтобы подпись встала
    // над цитатой, а не в конец письма.
    return `<div><br></div><div ${SIGNATURE_MARK} class="${styles.signature}"></div>${win.init.bodyHtml ?? ''}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id, win.minimized, draft.pending !== null]);

  // Собранное тело сразу кладём в черновик: дальше оно живёт там и потому
  // возвращается на место после сворачивания окна.
  useEffect(() => {
    if (!draft.bodyInitialized) patch({ bodyHtml: initialHtml, bodyInitialized: true });
  }, [draft.bodyInitialized, initialHtml, patch]);

  /** Тело письма из редактора; если он ещё не смонтирован — из черновика. */
  const currentBodyHtml = (): string => editorRef.current?.innerHTML ?? draft.bodyHtml;

  /** Запоминаем набранное — по каждому изменению редактора. */
  const rememberBody = () => patch({ bodyHtml: currentBodyHtml() });

  /**
   * Подставляет выбранную подпись, не трогая написанное.
   *
   * Меняется только содержимое помеченного блока: подпись переключают уже
   * посреди набранного письма, и переписывать всё тело целиком значило бы
   * стирать текст. Возвращает false, если редактора в DOM нет (окно
   * свёрнуто) — тогда подставлять ещё рано.
   */
  const applySignature = useCallback(
    (id: string | null): boolean => {
      const editor = editorRef.current;
      if (!editor) return false;
      const chosen = id === null ? null : preferences.signatures.find((s) => s.id === id);
      let block = editor.querySelector(`[${SIGNATURE_MARK}]`);
      if (!block) {
        // Блок стёрли вместе с прежней подписью — заводим новый в конце.
        block = document.createElement('div');
        block.setAttribute(SIGNATURE_MARK, '');
        block.className = styles.signature ?? '';
        editor.append(block);
      }
      block.innerHTML = chosen ? signatureHtml(chosen.text) : '';
      patch({ bodyHtml: editor.innerHTML, signatureId: id });
      return true;
    },
    [preferences.signatures, patch],
  );

  // Первая подстановка — как только пришли настройки. Раньше окно
  // открывалось, а подписи ждать было неоткуда.
  useEffect(() => {
    if (draft.signatureApplied || settingsPending || win.minimized) return;
    if (applySignature(defaultSignature(preferences)?.id ?? null)) {
      patch({ signatureApplied: true });
    }
  }, [draft.signatureApplied, settingsPending, win.minimized, preferences, applySignature, patch]);

  /**
   * Выбранный размер шрифта. У нативного `select` он показывался сам;
   * у кнопки-меню его приходится держать, иначе на панели не видно,
   * какой размер сейчас выбран.
   */
  const [fontSize, setFontSize] = useState('3');
  const fontSizeLabel = FONT_SIZES.find(([value]) => value === fontSize)?.[1] ?? '15';

  /** Команда форматирования contenteditable с сохранением выделения. */
  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
  };

  /* --- Мостик к помощнику -------------------------------------------
   * Помощник ничего не знает про contenteditable: он получает текст
   * и отдаёт текст, а вставкой занимаются эти четыре функции —
   * через тот же document.execCommand, что и панель форматирования. */

  /** Экранирование: текст от модели вставляется как текст, а не как разметка. */
  const asHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

  const readAll = (): string => editorRef.current?.innerText ?? '';

  /** Выделенный фрагмент внутри редактора; если выделения нет — весь текст. */
  const readSelectionOrAll = (): { text: string; whole: boolean } => {
    const selection = window.getSelection();
    const editor = editorRef.current;
    const inside =
      selection && selection.rangeCount > 0 && editor
        ? editor.contains(selection.getRangeAt(0).commonAncestorContainer)
        : false;
    const selected = inside ? (selection?.toString() ?? '') : '';
    return selected.trim() ? { text: selected, whole: false } : { text: readAll(), whole: true };
  };

  const insertAiText = (text: string) => exec('insertHTML', asHtml(text));

  const replaceAiText = (text: string, whole: boolean) => {
    editorRef.current?.focus();
    // Выделения нет — правка относилась ко всему тексту, его и заменяем.
    if (whole) document.execCommand('selectAll');
    exec('insertHTML', asHtml(text));
  };

  /* --- Шаблоны --------------------------------------------------------
   *
   * Вставка идёт ТЕМ ЖЕ путём, что и смайлик с текстом помощника, —
   * `document.execCommand('insertHTML')` в позицию курсора. Это и есть
   * ответ на главный риск возможности (docs/gaps.md: «испортить можно —
   * затереть написанное вставкой»): курсор переживает нажатие по кнопке,
   * потому что панель форматирования гасит `mousedown`, а меню шаблонов
   * стоит внутри неё.
   */

  /** Что знаем о получателе и о себе — для подстановок вида `{{имя}}`. */
  const substitutionContext = (): SubstitutionContext => {
    const recipient = firstRecipient(to);
    return {
      recipientName: recipient.name,
      recipientAddress: recipient.address,
      ownName: account?.displayName || null,
    };
  };

  const insertTemplate = async (picked: MailTemplate) => {
    /*
     * Длинный шаблон приходит в списке ОБРЕЗАННЫМ — список запрашивается
     * при каждом открытии окна, и тащить в него полмегабайта текста
     * незачем. Здесь текст нужен весь, поэтому дочитываем по номеру.
     *
     * Не удалось дочитать (сеть, сессия) — вставляем то, что есть, но
     * говорим об этом: половина шаблона в письме, вставленная молча,
     * уедет получателю обрывком.
     */
    let template = picked;
    if (picked.bodyTruncated === true) {
      try {
        template = await templatesApi.getTemplate(picked.id);
      } catch {
        showNotice('Шаблон вставлен не полностью: не удалось дочитать текст с сервера');
      }
    }

    const ctx = substitutionContext();

    /*
     * Тема: пустую заполняем, набранную НЕ трогаем. Молчаливая замена
     * набранной темы — это письмо, ушедшее под чужим заголовком, и
     * заметить это можно только в «Отправленных».
     */
    const filledSubject = prepareTemplateSubject(template.subject, ctx);
    const subjectKept = subject.trim() !== '' && filledSubject !== '' && filledSubject !== subject;
    if (filledSubject !== '' && subject.trim() === '') patch({ subject: filledSubject });

    const html = prepareTemplateBody(template.bodyHtml, ctx);
    if (html !== '') {
      exec('insertHTML', html);
      rememberBody();
    }

    /*
     * Вложения шаблона выкладываются во временное хранилище загрузок
     * НОВЫМИ файлами и дальше ведут себя как обычные вложения письма:
     * их можно убрать, и шаблон от этого не пострадает. Запрос уходит
     * только когда вложения есть — см. apps/api/src/templates/routes.ts.
     */
    if (template.attachments.length > 0) {
      /*
       * Пока вложения шаблона выкладываются на сервер, письмо считается
       * НЕДОСОБРАННЫМ — ровно как при обычной загрузке файла и при
       * пересылке.
       *
       * Раньше этот счётчик здесь не трогали: кнопка «Отправить»
       * оставалась доступной, и письмо со ссылкой на прайс уходило без
       * прайса. Хуже того, окно к этому времени закрывалось, и отказ
       * («вложения не выложились») показывать было уже некому — setError
       * прилетал в несуществующее окно.
       */
      setUploading((n) => n + 1);
      templatesApi
        .materializeAttachments(template.id)
        .then((result) => {
          patch((current) => ({ attachments: [...current.attachments, ...result.attachments] }));
        })
        .catch((err: unknown) => {
          // Молчать нельзя: текст вставился, а прайса нет — и человек
          // отправит письмо, будучи уверенным, что файл приложен.
          setError(actionErrorText('Текст шаблона вставлен, а вложения — нет', err));
          showNotice('Текст шаблона вставлен, а вложения — нет');
        })
        .finally(() => setUploading((n) => Math.max(0, n - 1)));
    }

    /*
     * Что осталось незаполненным, говорим сразу: подставить нечего, когда
     * получателя ещё нет или известен только его адрес. Сказать об этом
     * при вставке дешевле, чем поймать перед отправкой.
     */
    const leftovers = unresolvedPlaceholders(html);
    const notes: string[] = [];
    if (subjectKept) notes.push('тема письма оставлена своя');
    if (leftovers.length > 0) notes.push(`заполните вручную: ${leftovers.join(', ')}`);
    if (notes.length > 0) showNotice(`Шаблон «${template.name}» вставлен — ${notes.join('; ')}`);
  };

  /**
   * Тело письма БЕЗ блока подписи — именно оно и есть шаблон.
   *
   * Подпись в шаблон брать нельзя, и это не вкусовщина. Окно написания
   * заводит свой блок подписи в каждом новом письме и наполняет его
   * выбранной подписью. Сохрани мы подпись внутрь шаблона — вставка
   * положила бы её ВТОРОЙ раз, под уже подставленную, и человек вычищал
   * бы её руками в каждом письме. Проверено на своей же подписи.
   */
  const bodyWithoutSignature = (): string => {
    const editor = editorRef.current;
    if (!editor) return draft.bodyHtml;
    const copy = editor.cloneNode(true) as HTMLElement;
    for (const block of copy.querySelectorAll(`[${SIGNATURE_MARK}]`)) block.remove();
    return copy.innerHTML;
  };

  /** «Сохранить как шаблон»: тема и текст письма, по желанию — вложения. */
  const saveAsTemplate = (name: string, withAttachments: boolean) => {
    createTemplate.mutate(
      {
        name,
        subject,
        bodyHtml: bodyWithoutSignature(),
        // Получатели в шаблон НЕ попадают намеренно: шаблон вставляют в
        // разные письма, и запомненный адрес однажды ушёл бы не тому.
        attachmentIds: withAttachments ? attachments.map((a) => a.id) : [],
      },
      { onSuccess: () => setSaveTemplateOpen(false) },
    );
  };

  /**
   * Чем это окно написания опознаётся на сервере.
   *
   * Ключ уходит в КАЖДОМ запросе окна — и сохранением черновика, и
   * отправкой, — и это не мелочь для порядка. Пока его не слали, сервер не
   * мог связать между собой запросы одного письма, и получалось вот что:
   *
   *  - неудачная отправка спасает набранный текст в «Черновики» — и делает
   *    это заново на каждую попытку. Три отказа подряд (почтовый сервер
   *    перезапускают) — три одинаковых письма в папке;
   *  - удачная отправка черновик НЕ убирала: серверная уборка выходит
   *    первой же строкой, когда не знает ни UID черновика, ни ключа окна.
   *
   * В итоге письмо уходило, а его копии оставались лежать в «Черновиках».
   * Человек, увидев их, отправлял письмо второй раз — у получателя дубль.
   */
  const draftKey = `${WINDOW_KEY_PREFIX}-${String(win.id)}`;

  const buildPayload = () => {
    const payload: Parameters<typeof sendMessage.mutate>[0] = {
      draftKey,
      to: parseAddresses(to),
      cc: parseAddresses(cc),
      bcc: parseAddresses(bcc),
      subject,
      bodyHtml: currentBodyHtml(),
      attachmentIds: attachments.map((a) => a.id),
    };
    // Повторное сохранение заменяет прежний черновик, а не плодит копии
    if (draft.draftUid !== null) payload.draftUid = draft.draftUid;
    if (win.init.inReplyTo) payload.inReplyTo = win.init.inReplyTo;
    if (win.init.references) payload.references = win.init.references;
    if (attachedMessages.length > 0) {
      payload.attachMessageIds = attachedMessages.map((m) => m.id);
    }
    if (draft.requestReadReceipt) payload.requestReadReceipt = true;
    return payload;
  };

  /**
   * Отправка с подключённого чужого адреса — через его собственный SMTP.
   *
   * Отдельная ветка, а не флаг в общем запросе: у чужого сервера нет ни
   * нашей очереди (отмена, отложенная отправка), ни наших «Отправленных»
   * — копию туда кладёт сам сервер, в чужой ящик. Смешивать эти два пути
   * значило бы обещать в окне возможности, которых на этом пути нет.
   */
  const sendExternal = (externalId: number) => {
    const payload = buildPayload();
    setError(null);
    rememberBody();
    sendAsExternal.mutate(
      {
        id: externalId,
        request: {
          to: payload.to,
          cc: payload.cc,
          bcc: payload.bcc,
          subject: payload.subject,
          bodyHtml: currentBodyHtml(),
          attachmentIds: payload.attachmentIds,
          /*
           * Черновик едет и сюда. Без этих двух полей сервер не знал, какой
           * черновик убрать после отправки, и письмо оставалось лежать в
           * «Черновиках»: человек находил его через неделю и отправлял
           * второй раз — у получателя дубль. Свой путь отправки эти поля
           * шлёт с самого начала (см. buildPayload).
           */
          ...(payload.draftUid ? { draftUid: payload.draftUid } : {}),
          draftKey,
          // Имя берём от ПОДКЛЮЧЕНИЯ, а не своё: письмо с чужого адреса,
          // подписанное именем владельца этого интерфейса, выглядит как
          // подделка — «Иван Петров <buhgalteria@example.com>».
          fromName: externalSender?.label ?? null,
          ...(win.init.inReplyTo ? { inReplyTo: win.init.inReplyTo } : {}),
          ...(win.init.references ? { references: win.init.references } : {}),
          /*
           * Вложенные письма и просьба о прочтении едут и здесь.
           *
           * Раньше этот запрос собирался вручную и оба поля терял: плашки
           * пересылаемых писем были видны в окне до самого нажатия
           * «Отправить», кнопка «Уведомить о прочтении» оставалась
           * зажжённой, а получатель не получал ни вложений, ни просьбы —
           * и человеку при этом говорили «Письмо отправлено с адреса …».
           */
          ...(payload.attachMessageIds ? { attachMessageIds: payload.attachMessageIds } : {}),
          ...(payload.requestReadReceipt ? { requestReadReceipt: true } : {}),
        },
      },
      {
        onSuccess: (result) => {
          /*
           * Письмо ушло — но, возможно, не всем.
           *
           * Чужой SMTP отвечает по каждому получателю отдельно, и отказ
           * ЧАСТИ адресов приходит внутри успешного ответа. Раньше окно
           * писало «Письмо отправлено с адреса …» безусловно, и человек
           * закрывал его в полной уверенности, что дошло всем. Молчание
           * здесь читается как «дошло всем», а это неправда.
           *
           * Слова те же, что и на своём пути отправки: вопрос у человека
           * один и тот же — «дошло ли», — и ответ на него не должен
           * зависеть от того, с какого адреса он отправлял.
           */
          const rejected = result.rejected ?? [];
          if (rejected.length > 0) {
            const who = rejected.map((r) => r.address).join(', ');
            showNotice(
              rejected.length === (result.accepted?.length ?? 0) + rejected.length
                ? `Письмо не принято ни одним получателем: ${who}`
                : `Письмо отправлено с адреса ${result.from}, но эти адреса не приняты: ${who}`,
            );
          } else {
            showNotice(`Письмо отправлено с адреса ${result.from}`);
          }
          closeCompose(win.id);
        },
        onError: (err) => setError(actionErrorText('Не удалось отправить письмо', err)),
      },
    );
  };

  const send = () => {
    const payload = buildPayload();
    /*
     * Получатель нужен ХОТЬ ОДИН — в любом из трёх полей.
     *
     * Раньше здесь требовалось непустое «Кому», и письмо только со «Скрытой»
     * отправить было нельзя вовсе: кнопка отвечала «Укажите хотя бы одного
     * получателя», хотя получатели в окне были и человек их видел. А это
     * обычный приём — разослать одно письмо десятку людей так, чтобы они не
     * увидели адресов друг друга. Сервер это разрешает (compose.ts: отказ
     * только если пусты все три поля), путь через чужой SMTP — тоже; не
     * пускало ровно это условие.
     */
    if (payload.to.length === 0 && payload.cc.length === 0 && payload.bcc.length === 0) {
      setError('Укажите хотя бы одного получателя — в «Кому», «Копии» или «Скрытой»');
      return;
    }
    /*
     * Незаполненная подстановка из шаблона.
     *
     * Останавливаем ОДИН раз и называем, что именно осталось. Письмо
     * «Здравствуйте, {{имя}}!» — это ровно та ошибка, ради которой
     * Superhuman не даёт отправить письмо с незаполненным заполнителем;
     * а вечный запрет был бы хуже неё, потому что фигурные скобки в тексте
     * человек может написать и намеренно. Второе нажатие отправляет.
     */
    if (!placeholdersWarned) {
      const leftovers = unresolvedPlaceholders(`${payload.subject} ${currentBodyHtml()}`);
      if (leftovers.length > 0) {
        setPlaceholdersWarned(true);
        setError(
          `В письме остались незаполненные подстановки: ${leftovers.join(', ')}. ` +
            'Заполните их или нажмите «Отправить» ещё раз.',
        );
        return;
      }
    }
    if (externalSender) {
      /*
       * Отложенной отправки с чужого адреса у нас нет — и не бывает.
       *
       * Очередь отложенной отправки живёт на НАШЕМ сервере: она держит
       * собранное письмо и отдаёт его нашему Postfix в назначенный час.
       * Письмо с подключённого чужого адреса уходит через ЕГО SMTP
       * (`/api/accounts/external/:id/send`), а тот маршрут про «уйдёт
       * завтра в девять» ничего не знает и знать не может.
       *
       * Выбрана первая из двух возможностей: не предлагать. Кнопка
       * отложенной отправки при чужом отправителе выключена, а назначенное
       * ранее время снимается при выборе адреса (см. chooseSender) — то
       * есть подписи в окне никогда не обещают того, чего не будет.
       *
       * Здесь остаётся страховка на случай, когда время всё-таки попало в
       * черновик (например, окно вернулось из отмены отправки с уже
       * назначенным часом). Молчаливое «уходит сейчас» было бы худшим из
       * исходов: кнопка подписана «Отправить позже», в подвале висит
       * «Уйдёт 10 августа в 09:00» — а письмо у получателя через секунду.
       */
      if (draft.sendAt) {
        setError(
          `Отложенная отправка с адреса ${externalSender.address} невозможна: письмо уйдёт ` +
            'через его почтовый сервер, а он нашей очереди не знает. Снимите время ' +
            'или выберите свой адрес.',
        );
        return;
      }
      sendExternal(externalSender.externalId as number);
      return;
    }
    // Отложенная отправка уходит тем же запросом: сервер сам решает,
    // отправить сейчас или положить письмо в очередь.
    if (draft.sendAt) payload.sendAt = draft.sendAt;
    setError(null);
    rememberBody();
    sendMessage.mutate(payload, {
      onSuccess: (result) => {
        // Про отложенное письмо надо сказать отдельно: «Отправлено» о нём
        // было бы неправдой — у получателя его ещё нет.
        if (result.scheduled && result.sendAt) {
          showNotice(`Письмо уйдёт ${formatSendAt(result.sendAt)}`);
          closeCompose(win.id);
          return;
        }
        /**
         * Отмена отправки включена: письмо принято, но несколько секунд
         * лежит в очереди НА СЕРВЕРЕ. Окно не закрываем — оно всё это время
         * держит письмо целиком, и отмена вернёт его на место, со всеми
         * получателями и вложениями, а не «куда-то в черновики». Видно
         * при этом только плашку с отсчётом (см. ниже, ветка draft.pending).
         */
        if (result.pendingId && result.undoUntil) {
          patch({ pending: { id: result.pendingId, until: result.undoUntil } });
          return;
        }
        /*
         * Письмо ушло — но, возможно, не всем и не совсем.
         *
         * Сервер отвечает 200 и при частичном отказе: остальным получателям
         * письмо доставлено, и объявлять отправку неудачной нельзя — человек
         * отправит его второй раз, и у них окажется дубль. Но раньше окно
         * просто закрывалось, и оба этих исхода были неотличимы от полного
         * успеха: молчание читается как «дошло всем».
         *
         * Поэтому говорим ровно то, что случилось: кого не приняли (сервер
         * называет их поимённо) и легла ли копия в «Отправленные» — про
         * копию у сервера уже готов текст, он же объясняет причину.
         */
        const rejected = result.rejected ?? [];
        if (rejected.length > 0) {
          const who = rejected.map((r) => r.address).join(', ');
          showNotice(
            rejected.length === (result.accepted?.length ?? 0) + rejected.length
              ? `Письмо не принято ни одним получателем: ${who}`
              : `Письмо отправлено, но эти адреса не приняты: ${who}`,
          );
        } else if (result.warning) {
          showNotice(result.warning);
        }
        closeCompose(win.id);
      },
      // Не отправилось — окно остаётся с текстом, а причина видна
      onError: (err) => setError(actionErrorText('Не удалось отправить письмо', err)),
    });
  };

  /**
   * Слепок письма — по нему видно, изменилось ли хоть что-нибудь с прошлой
   * записи. Сравнение, а не «грязный» признак: правка, отменённая обратно
   * (набрал и стёр), не должна гонять запросы на сервер.
   */
  const fingerprint = (): string =>
    JSON.stringify([
      to,
      cc,
      bcc,
      subject,
      currentBodyHtml(),
      attachments.map((a) => a.id),
      attachedMessages.map((m) => m.id),
      draft.requestReadReceipt === true,
      draft.fromExternalId,
    ]);

  /** Слепок последней УДАЧНОЙ записи; null — не сохраняли ни разу. */
  const savedShotRef = useRef<string | null>(null);

  /**
   * Запись прямо сейчас в пути.
   *
   * Ссылка, а не `saveDraft.isPending`, и это не мелочь. Сохранение первым
   * делом переносит тело из редактора в черновик (rememberBody), то есть
   * МЕНЯЕТ состояние окна — и следующая же отрисовка заводит новый таймер,
   * пока признак «идёт запрос» ещё не поднялся. Получалось два запроса на
   * одну правку: второй уходил через три секунды после первого и клал в
   * ящик ту же самую версию письма. Ссылка ставится синхронно, до вызова,
   * и такой гонки не оставляет.
   */
  const savingRef = useRef(false);

  /**
   * Сохранение черновика. Возвращает обещание, чтобы закрытие по Esc могло
   * дождаться результата: раньше окно закрывалось независимо от исхода —
   * сохранение падало, а текст письма пропадал вместе с окном.
   *
   * `silent` — запись по таймеру, о которой человек не просил. Её неудача
   * не рисует полосу с ошибкой и не показывает извещение: набирающий текст
   * человек получал бы красную полосу каждые три секунды, пока не починится
   * сеть, и она перекрывала бы ему письмо. Молчание тут не обман: слепок
   * при неудаче НЕ обновляется, поэтому и предупреждение при закрытии
   * вкладки останется на месте, и сохранение по кнопке скажет правду.
   */
  const save = (options: { silent?: boolean } = {}): Promise<boolean> => {
    rememberBody();
    const shot = fingerprint();
    savingRef.current = true;
    return new Promise((resolve) => {
      saveDraft.mutate(buildPayload(), {
        onSuccess: (r) => {
          savingRef.current = false;
          savedShotRef.current = shot;
          setError(null);
          patch({ savedAt: r.savedAt, draftUid: r.draftUid ?? draft.draftUid });
          resolve(true);
        },
        onError: (err) => {
          savingRef.current = false;
          if (options.silent === true) {
            resolve(false);
            return;
          }
          const text = actionErrorText('Не удалось сохранить черновик', err);
          setError(text);
          /*
           * И общим извещением тоже — потому что у СВЁРНУТОГО окна полосы
           * с ошибкой нет вовсе: свёрнутая плашка рисуется отдельной
           * веткой, где стоят только заголовок и крестик.
           *
           * Как это выглядело: человек сворачивает окно с набранным
           * текстом, жмёт крестик на плашке, сохранение падает (сеть,
           * истёкшая сессия, переполненный ящик) — и не происходит ровно
           * ничего видимого. Он жмёт ещё раз, ещё раз, а потом закрывает
           * вкладку, считая, что интерфейс завис. Текст при этом цел, но
           * знать об этом ему неоткуда.
           */
          showNotice(text);
          resolve(false);
        },
      });
    });
  };

  /**
   * Esc и крестик: сохраняем черновик и закрываем окно ТОЛЬКО если
   * сохранилось — и только если письмо уже собрано целиком.
   *
   * Второе условие появилось не сразу. Ожидание вложений стояло на кнопке
   * «Отправить» и на Ctrl+Enter, а «сохранить и закрыть» его не знало:
   * черновик собирается из УЖЕ загруженных файлов, поэтому Esc, нажатый
   * через секунду после выбора файла, клал в «Черновики» письмо «см.
   * вложение» с нулём вложений. Доехавшая загрузка дописывала файл в уже
   * закрытое окно, то есть в никуда. Та же потеря, от которой чинили
   * отправку, — просто через другую дверь, и дверь эта штатная: Esc и
   * крестик у нас и есть «допишу позже».
   */
  const saveAndClose = async (): Promise<void> => {
    if (waitingForAttachments) {
      showNotice('Ждём вложения — они ещё не доехали. Сохраним, как только доедут');
      return;
    }
    if (await save()) closeCompose(win.id);
  };

  /**
   * Тело письма таким, каким его ЗАСТАЛ человек при открытии окна.
   *
   * Это цитата исходного письма (у ответа и пересылки) и подпись, которую
   * окно подставило само из настроек. Ни того, ни другого человек не писал,
   * и содержимым письма это не считается.
   */
  const untouchedBody = (): string => {
    const signature = preferences.signatures.find((s) => s.id === draft.signatureId);
    return (
      visibleText(signature ? signatureHtml(signature.text) : '') +
      visibleText(win.init.bodyHtml ?? '')
    );
  };

  /**
   * Есть ли в окне что терять. Пустое окно закрывается сразу: заводить
   * черновик из ничего незачем, он только замусорит папку.
   *
   * «Пустое» — это НЕ «без единого символа», и в этом была беда. Окно
   * ответа открывается с уже заполненным «Кому», темой «Re: …», цитатой
   * исходного письма и подписью по умолчанию — по прежней проверке оно
   * оказывалось непустым ВСЕГДА. То есть Esc или крестик на нетронутом
   * ответе (открыл, перечитал, передумал) каждый раз клал в «Черновики»
   * письмо, которого человек не писал; за день папка обрастала десятком
   * таких пустышек, и настоящий недописанный черновик терялся среди них.
   *
   * Поэтому каждое поле сравнивается с тем, чем его наполнило ОТКРЫТИЕ
   * окна, а тело — с цитатой и подписью. Сравнение, а не «непусто»: правка
   * в любую сторону, в том числе подчищенная цитата, — это уже работа
   * человека, и терять её нельзя.
   */
  const hasContent = (): boolean =>
    subject.trim() !== (win.init.subject ?? '').trim() ||
    to.trim() !== (win.init.to ?? '').trim() ||
    cc.trim() !== (win.init.cc ?? '').trim() ||
    bcc.trim() !== (win.init.bcc ?? '').trim() ||
    attachments.length > 0 ||
    attachedMessages.length > 0 ||
    /*
     * Файл, который ЕЩЁ ЕДЕТ, — тоже работа человека, хотя в черновике его
     * пока нет. Без этого условия окно «см. вложение», закрытое через
     * секунду после выбора файла, закрывалось бы молча и сразу, а доехавшая
     * загрузка дописывала бы файл в никуда (см. saveAndClose).
     */
    waitingForAttachments ||
    /*
     * Тело письма берётся из редактора, а у СВЁРНУТОГО окна его в DOM нет
     * вовсе — тогда из черновика (currentBodyHtml умеет и то, и другое).
     * Свёрнутая плашка рисуется отдельной веткой, ref пуст, и проверка по
     * одному только редактору давала «пусто» при любом набранном тексте:
     * крестик на плашке закрывал окно молча, без черновика и без вопроса.
     */
    visibleText(currentBodyHtml()) !== untouchedBody();

  /**
   * Закрытие окна крестиком и по Esc.
   *
   * Раньше крестик звал закрытие напрямую — и написанное письмо исчезало
   * молча, без черновика и без вопроса. При этом Esc в том же окне вёл себя
   * правильно: сохранял черновик и закрывался только при успехе. То есть два
   * жеста «закрыть» делали прямо противоположное, и более очевидный из
   * двух — тот, что уничтожал работу.
   *
   * Теперь оба жеста ведут сюда и делают одно и то же. Раньше Esc шёл мимо
   * этой проверки и сохранял черновик ВСЕГДА — даже из нетронутого
   * окна ответа, где человек не написал ни буквы (см. hasContent).
   */
  const closeWindow = (): void => {
    if (!hasContent()) {
      closeCompose(win.id);
      return;
    }
    void saveAndClose();
  };

  /**
   * Окно открыто НА СУЩЕСТВУЮЩЕМ черновике — его дописывают, а не пишут
   * заново. Отсюда разное поведение «Отменить»: чужой (то есть прежний,
   * заведённый человеком) черновик эта кнопка трогать не должна.
   */
  const continuingDraft = win.init.draftUid !== undefined;

  /**
   * «Отменить» — единственный способ выбросить написанное. Он и должен
   * выбрасывать, иначе выбросить было бы нечем. Но не молча: спрашиваем,
   * когда есть что терять.
   *
   * ------------------------------------------------------------------
   * ПОЧЕМУ ЗДЕСЬ ПОЯВИЛАСЬ УБОРКА
   * ------------------------------------------------------------------
   * С автосохранением написанное уходит в «Черновики» само, через
   * несколько секунд тишины. Значит, прежнее «просто закрыть окно» стало
   * бы неправдой: обещание «Написанное будет потеряно» осталось бы на
   * экране, а письмо — в папке. Человек, выбросивший черновик, находил бы
   * его назавтра в списке.
   *
   * Поэтому черновик, заведённый ЭТИМ окном, убирается в «Корзину» — не
   * стирается насовсем: передумавший найдёт письмо там, как и любое
   * другое удалённое.
   *
   * А вот черновик, который в окне ДОПИСЫВАЛИ, не трогается вовсе: там
   * лежит письмо, написанное раньше и не этим окном, и выбрасывать его
   * по кнопке «Отменить» никто не просил. Слова вопроса в этом случае
   * другие — и это единственные честные слова: изменения к тому моменту
   * уже сохранены.
   */
  const discard = (): void => {
    const savedHere = draft.draftUid !== null && !continuingDraft;
    if (hasContent() || savedHere) {
      const question = continuingDraft
        ? 'Закрыть окно? Письмо останется в «Черновиках» — оно уже сохранено.'
        : 'Закрыть письмо без сохранения? Написанное будет потеряно.';
      if (!window.confirm(question)) return;
    }
    if (savedHere && draft.draftUid !== null) {
      moveMessages.mutate({ ids: [`drafts:${String(draft.draftUid)}`], targetFolderId: 'trash' });
    }
    closeCompose(win.id);
  };

  /**
   * Выбор адреса, с которого уйдёт письмо.
   *
   * Отдельная функция, а не `patch` прямо в меню, из-за отложенной отправки:
   * у чужого адреса её нет (письмо уходит через ЕГО сервер, а очередь — на
   * нашем). Назначенное время здесь снимается сразу и вслух — иначе окно
   * продолжало бы обещать «Уйдёт 10 августа в 09:00» письму, которое уйдёт
   * немедленно.
   */
  const chooseSender = (sender: SenderOption): void => {
    if (sender.externalId !== null && draft.sendAt) {
      patch({ fromExternalId: sender.externalId, sendAt: null });
      showNotice(
        `Отложенная отправка снята: письмо с адреса ${sender.address} уйдёт через его ` +
          'почтовый сервер, а он назначенного времени не знает.',
      );
      return;
    }
    patch({ fromExternalId: sender.externalId });
  };

  /** Что обещает кнопка просьбы уведомить о прочтении в текущем состоянии. */
  const readReceiptHint = draft.requestReadReceipt
    ? 'Не запрашивать уведомление о прочтении'
    : 'Уведомить о прочтении';

  /*
   * Сколько файлов ЕЩЁ ЕДЕТ на сервер.
   *
   * Отправка ждёт этого счётчика, и вот почему. Письмо собирается из
   * идентификаторов уже загруженных вложений: пока файл не доехал, его в
   * черновике просто нет. Кнопка «Отправить» при этом была доступна
   * всегда — единственным условием было «идёт ли сама отправка».
   *
   * Отсюда потеря, которую человек замечает у получателя. Прикрепил файл
   * на двадцать мегабайт, дописал «см. вложение», нажал «Отправить» через
   * пять секунд — письмо ушло БЕЗ файла и без единого предупреждения.
   * Загрузка потом дописывала вложение в уже закрытое окно, то есть в
   * никуда.
   *
   * То же самое с пересылкой: там вложения исходного письма скачиваются и
   * заливаются обратно фоном, и окно открывается сразу.
   */
  const [uploading, setUploading] = useState(0);
  /*
   * Ждём ли мы файлы: свои (прикрепили в этом окне) или чужие
   * (переносятся из пересылаемого письма — их считает сам черновик).
   */
  const waitingForAttachments = uploading > 0 || draft.pendingAttachments > 0;

  const attachFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading((n) => n + 1);
    try {
      const uploaded = await api.uploadAttachment(file);
      patch((current) => ({ attachments: [...current.attachments, uploaded] }));
    } catch (err) {
      // Раньше это был необработанный промис: файл не загружался молча
      setError(actionErrorText(`Не удалось загрузить «${file.name}»`, err));
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  };

  /* --- Автосохранение --------------------------------------------------
   *
   * ЧЕГО НЕ БЫЛО. Черновик уходил на сервер только по кнопке «Сохранить» и
   * при закрытии окна — больше ни от чего. То есть F5, закрытая вкладка,
   * упавший браузер, уснувший телефон, случайный переход по ссылке в
   * письме уничтожали написанное целиком и молча. При этом окно показывало
   * подпись «Сохранено в 14:32», на сервере жила очередь сохранений
   * (DraftSequencer), а разбор адресов в черновике умел даже недописанные
   * строки — то есть весь механизм был готов, и не было ровно одного:
   * того, кто его позовёт.
   *
   * Условия писать черновик намеренно узкие:
   *
   *  - письмо уже отдано в очередь отправки (`pending`) — сохранять нечего
   *    и нельзя: черновик стал бы вторым экземпляром уходящего письма;
   *  - вложения ещё едут — черновик лёг бы без них, и «см. вложение»
   *    оказалось бы письмом без файла (та же беда, от которой закрыты
   *    «Отправить» и «сохранить и закрыть»);
   *  - в окне нет ничего, кроме цитаты и подписи (hasContent) — иначе
   *    каждое открытое и брошенное окно ответа само заводило бы черновик,
   *    и папка обрастала бы письмами, которых человек не писал;
   *  - с прошлой записи ничего не изменилось — незачем.
   */
  useEffect(() => {
    if (draft.pending) return;
    if (waitingForAttachments) return;
    if (savingRef.current) return;
    if (saveDraft.isPending || sendMessage.isPending || sendAsExternal.isPending) return;
    if (!hasContent()) return;
    if (savedShotRef.current === fingerprint()) return;
    const timer = window.setTimeout(() => {
      void save({ silent: true });
    }, AUTOSAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
    // Зависимости — всё, из чего собирается письмо. Функции выше
    // пересоздаются на каждой отрисовке и в список не годятся.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    to,
    cc,
    bcc,
    subject,
    draft.bodyHtml,
    draft.requestReadReceipt,
    draft.fromExternalId,
    draft.pending,
    attachments,
    attachedMessages,
    waitingForAttachments,
    saveDraft.isPending,
    sendMessage.isPending,
    sendAsExternal.isPending,
  ]);

  /**
   * Есть ли прямо сейчас несохранённое. Живёт в ссылке, а не в состоянии:
   * обработчик ухода со страницы ставится один раз, а знать он должен
   * последнее, а не то, что было при его установке.
   */
  const unsavedRef = useRef<() => boolean>(() => false);
  unsavedRef.current = (): boolean =>
    !draft.pending && hasContent() && savedShotRef.current !== fingerprint();

  /**
   * Уход со страницы с несохранённым письмом — вопрос, а не молчание.
   *
   * Автосохранение выше закрывает почти всё, но не первые секунды набора
   * и не случай, когда сервер не отвечает. Ровно там письмо и пропадало
   * без следа: вкладку закрывают не задумываясь. Браузер покажет свой
   * обычный вопрос «Покинуть страницу?» — слова в нём наши не нужны, их
   * всё равно никто не показывает уже лет десять.
   */
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent): void => {
      if (!unsavedRef.current()) return;
      event.preventDefault();
      // Старые браузеры показывают вопрос только с непустым returnValue.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
    };
  }, []);

  /**
   * Письмо отдано на отправку и ждёт своих секунд.
   *
   * Окно всё это время живо, но не показано: в нём лежит письмо целиком,
   * и отмена возвращает именно его — с тем же телом, теми же получателями
   * и теми же вложениями. Пересобирать письмо из ящика (как это делает
   * «дописать черновик») здесь незачем и нечестно: разметка тела, скрытые
   * получатели и имена файлов пережили бы такой оборот не полностью.
   */
  if (draft.pending) {
    const pending = draft.pending;
    return (
      <UndoSendBar
        until={pending.until}
        index={undoIndex}
        busy={undoSend.isPending}
        onUndo={() => {
          undoSend.mutate(
            {
              pendingId: pending.id,
              /*
               * Письмо держит ЭТО окно, и вернёт его себе оно же — с тем
               * же телом, получателями и вложениями. Поэтому сервер не
               * кладёт копию в «Черновики»: она была бы лишней. Из панели
               * «Уйдут позже» этот признак не шлётся, и там письмо
               * возвращается именно в «Черновики» — окна к тому времени
               * давно нет.
               */
              heldByWindow: true,
            },
            {
              onSuccess: (result) => {
                if (result.cancelled) {
                  // Письмо снято с очереди. Возвращаем окно как было; UID
                  // черновика сбрасываем — тот черновик сервер удалил, когда
                  // принял письмо, и ссылаться на него больше нельзя.
                  patch({ pending: null, draftUid: null, savedAt: null });
                  return;
                }
                /*
                 * ПИСЬМО ПРЯМО СЕЙЧАС В РАБОТЕ У ОЧЕРЕДИ — ЭТО НЕ «УЖЕ УШЛО».
                 *
                 * Очередь держит письмо занятым и на неудачной попытке, и на
                 * всей укладке в «Черновики», то есть отмена в эту секунду
                 * просто опоздала на такт. Прежний обработчик отвечал на
                 * такое одинаково с «ушло»: говорил «Письмо уже ушло» и
                 * закрывал окно вместе с текстом — а с окном пропадал и
                 * номер письма в очереди, единственный способ его отменить.
                 * Письмо при этом никуда не ушло и уходить не собиралось.
                 *
                 * Окно остаётся на месте: повторное нажатие сработает.
                 */
                if (result.reason === 'sending' || result.reason === 'draft-failed') {
                  showNotice(
                    result.reason === 'sending'
                      ? 'Письмо прямо сейчас отправляется — попробуйте ещё раз через ' +
                          'несколько секунд'
                      : (result.message ??
                          'Письмо не удалось вернуть — оно осталось в очереди на отправку'),
                  );
                  return;
                }
                /*
                 * Опоздали. Молчание и ложное «отменено» здесь — худшее из
                 * возможного: человек будет уверен, что письма нет, а оно
                 * у получателя. Поэтому говорим прямо и закрываем окно:
                 * держать письмо, которое уже ушло, не за чем.
                 */
                showNotice('Письмо уже ушло — отменить не получилось');
                closeCompose(win.id);
              },
              onError: (err) => {
                // Сеть отвалилась на самой отмене. Обещать, что письмо
                // осталось, нельзя — сервер о нашем нажатии не узнал.
                showNotice(actionErrorText('Не удалось отменить отправку, письмо уйдёт', err));
                closeCompose(win.id);
              },
            },
          );
        }}
        onDismiss={() => closeCompose(win.id)}
      />
    );
  }

  if (win.minimized) {
    return (
      <div className={styles.minimizedBar} style={{ left: minimizedLeft }}>
        <button
          type="button"
          className={styles.minimizedTitle}
          onClick={() => toggleMinimized(win.id)}
        >
          {subject || 'Новое письмо'}
        </button>
        <IconButton label="Закрыть" size="s" onClick={closeWindow}>
          <IconClose size={14} />
        </IconButton>
      </div>
    );
  }

  return (
    <>
      <section
        ref={windowRef as React.RefObject<HTMLElement>}
        className={cx(
          styles.window,
          maximized && styles.maximized,
          !maximized && geometryStyle && styles.floating,
        )}
        /* Каскад задаётся переменной, а не свойством right: на узком экране
           окно раскрывается во весь экран правилом из CSS, а встроенный стиль
           перебил бы его и оставил окно у правого края.

           Как только окно перетащили, каскад уступает место запомненному
           положению: два окна человек расставляет сам, и подвинутое второе
           не должно прыгать обратно под первое. */
        style={
          maximized
            ? undefined
            : ((geometryStyle ?? {
                '--mt-compose-offset': `${offset * 32}px`,
              }) as CSSProperties)
        }
        aria-label="Новое письмо"
        onKeyDown={(e) => {
          /*
           * Esc сохраняет черновик и закрывает окно (как в привычных
           * почтовых интерфейсах). Окно закрывается только после успешного
           * сохранения: иначе упавший запрос уносил бы с собой всё
           * написанное.
           *
           * Путь тот же, что и у крестика: нетронутое окно ответа Esc
           * закрывает БЕЗ черновика. Раньше он звал сохранение напрямую,
           * и «допишу позже» на письме, к которому человек не притронулся,
           * означало ещё одну пустышку в «Черновиках».
           */
          if (e.key === 'Escape') {
            e.stopPropagation();
            closeWindow();
            return;
          }
          /*
           * Ctrl+Enter — отправить. Сочетание, к которому в Рунете привыкли
           * все: оно есть и в привычных почтовых интерфейсах, и в Яндексе, и в Telegram.
           *
           * Обработчик стоит на окне целиком, а не на поле текста: отправить
           * с клавиатуры человек хочет и из строки темы, и из «Кому», где
           * Enter занят выбором подсказки, а Ctrl+Enter — свободен.
           *
           * Условие на занятость намеренно то же, что у кнопки: пока запрос
           * отправки в работе, повторное нажатие ничего не делает — иначе
           * нетерпеливое двойное нажатие отправляло бы письмо дважды.
           */
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            // Ctrl+Enter — тот же путь, что и кнопка: письмо без ещё не
            // доехавшего вложения уходит одинаково молча.
            if (!sendMessage.isPending && !sendAsExternal.isPending && !waitingForAttachments)
              send();
          }
        }}
      >
        {/* Шапка окна: получатель + управление окном.
            За неё же окно и перетаскивают — как любое окно на рабочем столе.
            Двойной щелчок разворачивает и возвращает обратно: привычка та же. */}
        <div
          className={styles.header}
          onPointerDown={(e) => {
            // Кнопки управления окном щёлкают, а не тянут: начни жест с них —
            // и «Закрыть» переставало бы закрывать с первого раза.
            if ((e.target as HTMLElement).closest('button')) return;
            startGesture(e, null);
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            setMaximized((v) => !v);
          }}
        >
          <span className={styles.headerTitle}>{subject || 'Новое письмо'}</span>
          <div className={styles.windowControls}>
            <Tooltip text="Свернуть">
              <IconButton label="Свернуть" size="s" onClick={() => toggleMinimized(win.id)}>
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 18h16v2H4z" fill="currentColor" />
                </svg>
              </IconButton>
            </Tooltip>
            <Tooltip text={maximized ? 'Свернуть в окно' : 'Развернуть'}>
              <IconButton
                label={maximized ? 'Свернуть в окно' : 'Развернуть'}
                size="s"
                onClick={() => setMaximized((v) => !v)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 5h14v14H5V5Zm2 2v10h10V7H7Z" fill="currentColor" fillRule="evenodd" />
                </svg>
              </IconButton>
            </Tooltip>
            <Tooltip text="Закрыть">
              <IconButton label="Закрыть" size="s" onClick={closeWindow}>
                <IconClose size={14} />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        {/*
          Письмо вернулось из очереди отправки: его пробовали отправить,
          почтовый сервер отказал, и попытки кончились. Такой черновик
          человек не создавал — без этой полосы он гадал бы, откуда взялось
          письмо и почему оно лежит в «Черновиках».

          Полоса стоит ПЕРВОЙ, над получателями: чинить обычно надо именно
          адрес, и причина должна быть перед глазами, когда его правят.
        */}
        {win.init.sendFailure && (
          <div className={styles.sendFailure} role="status">
            <b>Письмо не отправлено.</b> {failureSummary({ ...win.init.sendFailure })}
          </div>
        )}

        {/* Кому */}
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Кому</span>
          {/* Поле осталось строкой: подсказка только предлагает адрес, а
              разбор получателей, сохранение и восстановление черновика
              работают ровно с тем же текстом, что и раньше. Ничего за
              человека поле не дописывает — ни по Tab, ни по уходу фокуса
              (см. contacts/RecipientField.tsx). */}
          <RecipientField
            className={styles.fieldInput}
            value={to}
            onChange={(next) => patch({ to: next })}
            placeholder="Введите адрес"
            label="Кому"
            autoFocus
          />
          <span className={styles.fieldLinks}>
            {!showCc && (
              <button
                type="button"
                className={styles.fieldLink}
                onClick={() => patch({ showCc: true })}
              >
                Копия
              </button>
            )}
            {!showBcc && (
              <button
                type="button"
                className={styles.fieldLink}
                onClick={() => patch({ showBcc: true })}
              >
                Скрытая
              </button>
            )}
          </span>
        </div>

        {showCc && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Копия</span>
            <RecipientField
              className={styles.fieldInput}
              value={cc}
              onChange={(next) => patch({ cc: next })}
              label="Копия"
            />
          </div>
        )}
        {showBcc && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Скрытая</span>
            <RecipientField
              className={styles.fieldInput}
              value={bcc}
              onChange={(next) => patch({ bcc: next })}
              label="Скрытая"
            />
          </div>
        )}

        {/* От кого. Список появляется, только когда есть из чего выбирать:
            один адрес в выпадающем списке — лишний повод для нажатия */}
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>От кого</span>
          {senders.length > 1 ? (
            <Dropdown
              align="left"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  className={styles.fromButton}
                  onClick={toggle}
                  aria-label={`Отправить с адреса ${fromLabel}`}
                >
                  <span className={styles.fromText}>{fromLabel}</span>
                  <IconChevronDown size={16} />
                </button>
              )}
            >
              {senders.map((sender) => (
                <MenuItem key={sender.externalId ?? 'own'} onClick={() => chooseSender(sender)}>
                  {senderLabel(sender, account?.displayName ?? null)}
                </MenuItem>
              ))}
            </Dropdown>
          ) : (
            <span className={styles.fieldStatic}>
              {account ? `${account.displayName} <${account.email}>` : '…'}
            </span>
          )}
        </div>

        {/* Отправка с чужого адреса идёт через ЕГО сервер, и наши
            «отменить» и «отправить позже» к ней неприменимы. Сказать об
            этом надо до отправки, а не отказом после */}
        {externalSender && (
          <div className={styles.fromNotice}>
            Письмо уйдёт через сервер {externalSender.address}: отмена отправки и отложенная
            отправка для него недоступны, черновик тоже не сохраняется.
          </div>
        )}

        {/* Тема */}
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Тема</span>
          <input
            className={styles.fieldInput}
            value={subject}
            onChange={(e) => patch({ subject: e.target.value })}
            aria-label="Тема"
          />
        </div>

        {/* Вложения */}
        <div className={styles.attachRow}>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            onChange={(e) => {
              for (const f of Array.from(e.target.files ?? [])) void attachFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className={styles.attachButton}
            onClick={() => fileRef.current?.click()}
          >
            <IconAttach />
            Прикрепить файл
          </button>
          {/* «Из Почты» — прикрепить файл, который уже приходил в другом
              письме. Кнопка была пустышкой (писала в консоль); теперь
              открывает выбор — см. MailAttachmentPicker. */}
          <button type="button" className={styles.attachButton} onClick={() => setPickerOpen(true)}>
            Из Почты
          </button>
          {attachments.map((a) => (
            <span key={a.id} className={styles.attachChip}>
              {/* Имя в отдельном узле: обрезаться многоточием должно ОНО,
                  а не плашка целиком — крестик «Убрать» обязан остаться
                  на экране при любой длине имени. */}
              <span className={styles.attachChipName}>{a.filename}</span>
              <button
                type="button"
                className={styles.attachChipRemove}
                aria-label={`Убрать ${a.filename}`}
                onClick={() =>
                  patch((current) => ({
                    attachments: current.attachments.filter((x) => x.id !== a.id),
                  }))
                }
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
          {/* Письма, вложенные целиком («Переслать как вложение»). Плашка
              отличается значком: файл и письмо ведут себя по-разному, и
              путать их в одном ряду нельзя. */}
          {attachedMessages.map((m) => (
            <span key={m.id} className={cx(styles.attachChip, styles.attachChipMessage)}>
              <IconForward size={14} />
              <span className={styles.attachChipName}>{m.label}</span>
              <button
                type="button"
                className={styles.attachChipRemove}
                aria-label={`Убрать письмо ${m.label}`}
                onClick={() =>
                  patch((current) => ({
                    attachedMessages: current.attachedMessages.filter((x) => x.id !== m.id),
                  }))
                }
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>

        {/*
          Панель форматирования: кнопки 32×32.

          Все значки — из одного набора (сетка 24×24, штрих 1.8, currentColor),
          как в привычных почтовых интерфейсах (эталонные снимки интерфейса). Раньше здесь стояли
          юникодные глифы «⇤ ↔ •• 1. ↶ ↷», цветное эмодзи 🔗, нативный
          `select` со смайликом и комбинирующий «A̶»: соседние кнопки были
          разной оптической плотности, а две — вообще цветные.

          Ж/К/Ч/З остаются буквами: в привычных почтовых интерфейсах начертания подписаны ровно так же.

          Выбор гарнитуры — не `select`, а меню: в 48px нативного селекта
          «Golos Text» не влезало и наезжало на стрелку. в привычных почтовых интерфейсах на его месте
          стоит значок «Tt», и выбор раскрывается меню.

          preventDefault на mousedown сохраняет выделение в редакторе — иначе
          команда применилась бы в пустоту.
        */}
        <div className={styles.formatBar} onMouseDown={(e) => e.preventDefault()}>
          <button
            type="button"
            className={styles.fmtButton}
            title="Жирный"
            onClick={() => exec('bold')}
          >
            <b>Ж</b>
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Наклонный"
            onClick={() => exec('italic')}
          >
            <i>К</i>
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Подчёркнутый"
            onClick={() => exec('underline')}
          >
            <u>Ч</u>
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Зачёркнутый"
            onClick={() => exec('strikeThrough')}
          >
            <s>З</s>
          </button>

          <Dropdown
            menuClassName={styles.fmtMenu}
            trigger={({ toggle }) => (
              <button type="button" className={styles.fmtButton} title="Шрифт" onClick={toggle}>
                <IconFontFamily size={20} />
              </button>
            )}
          >
            {FONT_FAMILIES.map((f) => (
              <MenuItem key={f} onClick={() => exec('fontName', f)}>
                <span style={{ fontFamily: f }}>{f}</span>
              </MenuItem>
            ))}
          </Dropdown>

          <Dropdown
            menuClassName={styles.fmtMenuNarrow}
            trigger={({ toggle }) => (
              <button
                type="button"
                className={cx(styles.fmtButton, styles.fmtButtonWide)}
                title="Размер шрифта"
                onClick={toggle}
              >
                {fontSizeLabel}
              </button>
            )}
          >
            {FONT_SIZES.map(([value, label]) => (
              <MenuItem
                key={value}
                onClick={() => {
                  setFontSize(value);
                  exec('fontSize', value);
                }}
                hint={value === fontSize ? '✓' : undefined}
              >
                {label}
              </MenuItem>
            ))}
          </Dropdown>

          <span className={styles.fmtSeparator} />

          <button
            type="button"
            className={styles.fmtButton}
            title="По левому краю"
            onClick={() => exec('justifyLeft')}
          >
            <IconAlignLeft size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="По центру"
            onClick={() => exec('justifyCenter')}
          >
            <IconAlignCenter size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="По правому краю"
            onClick={() => exec('justifyRight')}
          >
            <IconAlignRight size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Маркированный список"
            onClick={() => exec('insertUnorderedList')}
          >
            <IconListBulleted size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Нумерованный список"
            onClick={() => exec('insertOrderedList')}
          >
            <IconListNumbered size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Отменить"
            onClick={() => exec('undo')}
          >
            <IconUndo size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Повторить"
            onClick={() => exec('redo')}
          >
            <IconRedo size={20} />
          </button>
          <button
            type="button"
            className={styles.fmtButton}
            title="Вставить ссылку"
            onClick={() => {
              const url = window.prompt('Адрес ссылки');
              if (url) exec('createLink', url);
            }}
          >
            <IconLink size={20} />
          </button>

          <Dropdown
            menuClassName={styles.emojiMenu}
            trigger={({ toggle }) => (
              <button
                type="button"
                className={styles.fmtButton}
                title="Вставить смайлик"
                onClick={toggle}
              >
                <IconEmoji size={20} />
              </button>
            )}
          >
            <EmojiGrid onPick={(symbol) => exec('insertText', symbol)} />
          </Dropdown>

          <button
            type="button"
            className={styles.fmtButton}
            title="Очистить форматирование"
            onClick={() => exec('removeFormat')}
          >
            <IconClearFormat size={20} />
          </button>

          {/*
            «Шаблоны» — у ПРАВОГО края панели форматирования: место
            размечено по эталонному интерфейсу (docs/features-reference.md, «Справа: Вставить
            подпись, Шаблоны»). Кнопки нет вовсе, пока сервер не сказал,
            что возможность у него есть.

            Меню стоит ВНУТРИ панели не ради вида: панель гасит `mousedown`,
            и только благодаря этому выделение в редакторе переживает
            нажатие — то есть шаблон вставляется в позицию курсора, а не
            в начало письма.
          */}
          {templates.available && (
            <>
              <span className={styles.fmtSpacer} />
              <Dropdown
                align="right"
                menuClassName={styles.templatesMenu}
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    className={cx(styles.fmtButton, styles.fmtButtonWide)}
                    title="Шаблоны писем"
                    onClick={toggle}
                  >
                    <IconTemplate size={20} />
                    <span className={styles.fmtButtonLabel}>Шаблоны</span>
                  </button>
                )}
              >
                <TemplateMenu
                  items={templates.items}
                  onPick={(template) => void insertTemplate(template)}
                  onSaveCurrent={() => setSaveTemplateOpen(true)}
                />
              </Dropdown>
            </>
          )}
        </div>

        {/* Помощь с ответом. Панели нет вовсе, если помощник выключен */}
        <ComposeAiPanel
          sourceMessageId={win.init.sourceMessageId}
          readAll={readAll}
          readSelectionOrAll={readSelectionOrAll}
          insert={insertAiText}
          replace={replaceAiText}
        />

        {/* Выбор подписи. Список — из общих настроек ящика; пока подписей
            там нет, выбирать нечего и строки не показываем */}
        {preferences.signatures.length > 0 && (
          <div className={styles.signatureRow}>
            <span className={styles.signatureLabel}>Подпись</span>
            <select
              className={styles.signatureSelect}
              aria-label="Подпись"
              value={draft.signatureId ?? ''}
              onChange={(e) => applySignature(e.target.value || null)}
            >
              <option value="">Без подписи</option>
              {preferences.signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Тело письма — contenteditable */}
        <div
          ref={editorRef}
          className={styles.editor}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Текст письма"
          // Набранное запоминается в состоянии окна, а не только в DOM:
          // иначе сворачивание окна стирало бы тело письма.
          onInput={rememberBody}
          onBlur={rememberBody}
          dangerouslySetInnerHTML={{ __html: initialHtml }}
        />

        {error && <div className={styles.error}>{error}</div>}

        {/* Нижняя панель */}
        <div className={styles.footer}>
          {/*
            Оба пути отправки, а не один.

            Письмо от чужого подключённого ящика уходит другой мутацией
            (sendAsExternal), и её здесь не было: кнопка оставалась
            доступной и подписанной «Отправить», пока запрос шёл к чужому
            SMTP — а он медленный. Нетерпеливое второе нажатие отправляло
            письмо ДВАЖДЫ. Обработчик Ctrl+Enter рядом учитывает обе
            мутации и объясняет зачем; кнопка про вторую не знала.
          */}
          <Button
            mode="primary"
            className={styles.sendButton}
            onClick={send}
            disabled={sendMessage.isPending || sendAsExternal.isPending || waitingForAttachments}
          >
            {waitingForAttachments
              ? 'Ждём вложения…'
              : sendMessage.isPending || sendAsExternal.isPending
                ? 'Отправка…'
                : draft.sendAt
                  ? 'Отправить позже'
                  : 'Отправить'}
          </Button>
          <Button mode="secondary" onClick={() => void save()} disabled={saveDraft.isPending}>
            {saveDraft.isPending ? 'Сохранение…' : 'Сохранить'}
          </Button>
          <Button mode="secondary" onClick={discard}>
            Отменить
          </Button>
          {savedAt && (
            <span className={styles.savedNote}>
              Сохранено в{' '}
              {new Date(savedAt).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
          {/* Назначенное время видно всегда, а не только внутри меню:
              письмо, которое уйдёт завтра, не должно выглядеть как обычное */}
          {draft.sendAt && (
            <span className={styles.sendAtNote}>Уйдёт {formatSendAt(draft.sendAt)}</span>
          )}
          <div className={styles.footerSpacer} />
          {/*
            Обе кнопки раньше только писали в консоль браузера. Теперь:
            первая ставит в письмо заголовок Disposition-Notification-To
            (RFC 8098), вторая отдаёт письмо серверной очереди — и оно уйдёт,
            даже если браузер закрыть (apps/api/src/mail/deferred-send.ts).
          */}
          <Tooltip text={readReceiptHint}>
            <IconButton
              label="Уведомить о прочтении"
              // Своя подсказка браузера: без неё всплывающая подсказка
              // говорила бы «не запрашивать», а системная — «уведомить»
              title={readReceiptHint}
              active={draft.requestReadReceipt}
              aria-pressed={draft.requestReadReceipt}
              onClick={() => patch({ requestReadReceipt: !draft.requestReadReceipt })}
            >
              <IconMailRead />
            </IconButton>
          </Tooltip>
          {/*
            При чужом отправителе кнопка на месте, но не работает.
            Убрать её совсем значило бы, что возможность то появляется, то
            исчезает без объяснений; выключенная кнопка объясняет себя сама
            подсказкой — и не даёт назначить время, которого не будет.
            Почему отложенной отправки с чужого адреса нет — см. send().
          */}
          {externalSender ? (
            <Tooltip
              text={`Отложенная отправка недоступна: письмо уйдёт через сервер ${externalSender.address}`}
            >
              <IconButton
                label="Отложенная отправка"
                title={`Отложенная отправка недоступна: письмо уйдёт через сервер ${externalSender.address}`}
                disabled
              >
                <IconEvent />
              </IconButton>
            </Tooltip>
          ) : (
            <Dropdown
              align="right"
              menuClassName={styles.sendLaterMenu}
              trigger={({ toggle }) => (
                <Tooltip text="Отложенная отправка">
                  <IconButton
                    label="Отложенная отправка"
                    active={Boolean(draft.sendAt)}
                    onClick={toggle}
                  >
                    <IconEvent />
                  </IconButton>
                </Tooltip>
              )}
            >
              <SendLaterMenu
                value={draft.sendAt}
                onPick={(iso) => patch({ sendAt: iso })}
                onClear={() => patch({ sendAt: null })}
              />
            </Dropdown>
          )}
        </div>

        {/*
          Уголки для размера. Их четыре, а не один: окно по умолчанию стоит в
          правом нижнем углу экрана, и растягивать его оттуда можно только
          вверх и влево; после перетаскивания в середину экрана удобнее уже
          нижний правый. На развёрнутом во весь экран окне уголков нет —
          тянуть его некуда.
        */}
        {!maximized &&
          (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span
              key={corner}
              className={cx(styles.resizeCorner, styles[`corner_${corner}`])}
              aria-hidden="true"
              onPointerDown={(e) => startGesture(e, corner)}
            />
          ))}
      </section>

      {/* «Сохранить как шаблон». Окно стоит РЯДОМ с окном написания, а не
          внутри, по той же причине, что и выбор вложения ниже: иначе
          Escape в нём всплывал бы до обработчика окна и заодно сохранял
          письмо в черновики и закрывал его. */}
      {saveTemplateOpen && (
        <SaveTemplateDialog
          subject={subject}
          attachmentCount={attachments.length}
          busy={createTemplate.isPending}
          error={createTemplate.isError ? createTemplate.error.message : null}
          onClose={() => setSaveTemplateOpen(false)}
          onSubmit={saveAsTemplate}
        />
      )}

      {/* Выбор вложения из уже пришедших писем. Окно стоит РЯДОМ с окном
          написания, а не внутри: иначе Escape в нём всплывал бы до
          обработчика окна и заодно закрывал бы само письмо. */}
      {pickerOpen && (
        <MailAttachmentPicker
          onClose={() => setPickerOpen(false)}
          onPick={(files) => {
            if (files.length === 0) return;
            patch((current) => ({
              // Одно и то же вложение, выбранное дважды, прикрепится дважды —
              // это разные загрузки с разными id. Сравнение по id защищает
              // только от повторного добавления одной и той же загрузки.
              attachments: [
                ...current.attachments,
                ...files.filter((f) => !current.attachments.some((a) => a.id === f.id)),
              ],
            }));
          }}
        />
      )}
    </>
  );
}
