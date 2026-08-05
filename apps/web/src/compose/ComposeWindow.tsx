/**
 * Окно написания письма (.compose-app mail.ru): 880px, радиус 12px,
 * тень rgba(0,16,61,.16) 0 4px 32px. Поля Кому / От кого / Тема
 * с раскрытием «Копии» и «Скрытой», панель форматирования на
 * contenteditable (без сторонних редакторов), подпись, нижняя панель
 * Отправить / Сохранить / Отменить. Поддерживает свёрнутое состояние
 * и несколько окон одновременно.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useAccount, useSaveDraft, useSendMessage } from '../api/queries';
import { useUiStore, type ComposeDraft, type ComposeWindowState } from '../app/store';
import { Button, Dropdown, IconButton, MenuItem, Tooltip, useDropdownClose } from '../components';
import { parseAddresses } from '../lib/addresses';
import { cx } from '../lib/cx';
import { actionErrorText } from '../lib/errorText';
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconAttach,
  IconClearFormat,
  IconClose,
  IconEmoji,
  IconEvent,
  IconFontFamily,
  IconLink,
  IconListBulleted,
  IconListNumbered,
  IconMailRead,
  IconRedo,
  IconUndo,
} from '../mail/icons';
import { useGeneralSettings } from '../api/settingsQueries';
import {
  DEFAULT_GENERAL_SETTINGS,
  defaultSignature,
  signatureHtml,
} from '../settings/generalSettings';
import { ComposeAiPanel } from './ComposeAiPanel';
import { MailAttachmentPicker } from './MailAttachmentPicker';
import styles from './ComposeWindow.module.css';

/**
 * Метка блока подписи внутри тела письма.
 *
 * Именно атрибут, а не класс: классы здесь из CSS-модулей, их имена
 * пересобираются, и искать блок по ним значило бы зависеть от сборки.
 */
const SIGNATURE_MARK = 'data-mt-signature';

interface ComposeWindowProps {
  win: ComposeWindowState;
  /** Порядковый номер развёрнутого окна — для каскада. */
  offset: number;
  /** Сдвиг свёрнутой плашки от левого края, px. */
  minimizedLeft?: number;
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

export function ComposeWindow({ win, offset, minimizedLeft = 16 }: ComposeWindowProps) {
  const { data: account } = useAccount();
  // Подписи живут в общих настройках ящика. Раньше сюда подставлялось
  // `account.signature`, а его /api/account отдаёт пустой строкой — в письмо
  // уезжал пустой блок, и выбрать одну из заведённых подписей было негде.
  const { data: settings, isPending: settingsPending } = useGeneralSettings();
  const preferences = settings ?? DEFAULT_GENERAL_SETTINGS;
  const closeCompose = useUiStore((s) => s.closeCompose);
  const toggleMinimized = useUiStore((s) => s.toggleComposeMinimized);
  const updateDraft = useUiStore((s) => s.updateComposeDraft);
  const sendMessage = useSendMessage();
  const saveDraft = useSaveDraft();

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

  const { to, cc, bcc, subject, showCc, showBcc, attachments, savedAt } = draft;

  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Открыт ли выбор вложения из уже пришедших писем («Из Почты»). */
  const [pickerOpen, setPickerOpen] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Начальное содержимое редактора.
   *
   * Пересчитывается только когда редактор действительно создаётся заново —
   * при открытии окна и при возврате из свёрнутого вида. В свёрнутом виде
   * редактора в DOM нет, поэтому его содержимое берётся из черновика:
   * так набранный текст возвращается на место вместе с окном. Внутри одного
   * показа значение неизменно — иначе React переписывал бы innerHTML на
   * каждое нажатие клавиши и курсор прыгал бы в начало.
   */
  const initialHtml = useMemo(() => {
    if (draft.bodyInitialized) return draft.bodyHtml;
    // Блок подписи заводится пустым: настройки с подписями приходят своим
    // запросом и почти всегда позже открытия окна. Текст в него положит
    // эффект ниже — место под него нужно уже сейчас, чтобы подпись встала
    // над цитатой, а не в конец письма.
    return `<div><br></div><div ${SIGNATURE_MARK} class="${styles.signature}"></div>${win.init.bodyHtml ?? ''}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id, win.minimized]);

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
  }, [
    draft.signatureApplied,
    settingsPending,
    win.minimized,
    preferences,
    applySignature,
    patch,
  ]);

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
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

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

  const buildPayload = () => {
    const payload: Parameters<typeof sendMessage.mutate>[0] = {
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
    return payload;
  };

  const send = () => {
    const payload = buildPayload();
    if (payload.to.length === 0) {
      setError('Укажите хотя бы одного получателя');
      return;
    }
    setError(null);
    rememberBody();
    sendMessage.mutate(payload, {
      onSuccess: () => closeCompose(win.id),
      // Не отправилось — окно остаётся с текстом, а причина видна
      onError: (err) => setError(actionErrorText('Не удалось отправить письмо', err)),
    });
  };

  /**
   * Сохранение черновика. Возвращает обещание, чтобы закрытие по Esc могло
   * дождаться результата: раньше окно закрывалось независимо от исхода —
   * сохранение падало, а текст письма пропадал вместе с окном.
   */
  const save = (): Promise<boolean> => {
    rememberBody();
    return new Promise((resolve) => {
      saveDraft.mutate(buildPayload(), {
        onSuccess: (r) => {
          setError(null);
          patch({ savedAt: r.savedAt, draftUid: r.draftUid ?? draft.draftUid });
          resolve(true);
        },
        onError: (err) => {
          setError(actionErrorText('Не удалось сохранить черновик', err));
          resolve(false);
        },
      });
    });
  };

  /** Esc и крестик: сохраняем черновик и закрываем окно ТОЛЬКО если сохранилось. */
  const saveAndClose = async (): Promise<void> => {
    if (await save()) closeCompose(win.id);
  };

  /**
   * Есть ли в окне что терять. Пустое окно закрывается сразу: заводить
   * черновик из ничего незачем, он только замусорит папку.
   */
  const hasContent = (): boolean =>
    subject.trim() !== '' ||
    to.trim() !== '' ||
    cc.trim() !== '' ||
    bcc.trim() !== '' ||
    attachments.length > 0 ||
    // Смотрим на видимый текст, а не на разметку: у пустого редактора
    // innerHTML не пустой — браузер держит там <br> или неразрывный пробел,
    // и по разметке любое только что открытое окно считалось бы непустым.
    (editorRef.current?.textContent ?? '').replace(/ /g, ' ').trim() !== '';

  /**
   * Закрытие крестиком.
   *
   * Раньше крестик звал закрытие напрямую — и написанное письмо исчезало
   * молча, без черновика и без вопроса. При этом Esc в том же окне вёл себя
   * правильно: сохранял черновик и закрывался только при успехе. То есть два
   * жеста «закрыть» делали прямо противоположное, и более очевидный из
   * двух — тот, что уничтожал работу.
   *
   * Теперь крестик — это тот же Esc. Пустое окно закрывается сразу.
   */
  const closeByCross = (): void => {
    if (!hasContent()) {
      closeCompose(win.id);
      return;
    }
    void saveAndClose();
  };

  /**
   * «Отменить» — единственный способ выбросить написанное. Он и должен
   * выбрасывать, иначе выбросить было бы нечем. Но не молча: спрашиваем,
   * когда есть что терять.
   */
  const discard = (): void => {
    if (hasContent() && !window.confirm('Закрыть письмо без сохранения? Написанное будет потеряно.')) {
      return;
    }
    closeCompose(win.id);
  };

  const attachFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const uploaded = await api.uploadAttachment(file);
      patch((current) => ({ attachments: [...current.attachments, uploaded] }));
    } catch (err) {
      // Раньше это был необработанный промис: файл не загружался молча
      setError(actionErrorText(`Не удалось загрузить «${file.name}»`, err));
    }
  };

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
        <IconButton label="Закрыть" size="s" onClick={closeByCross}>
          <IconClose size={14} />
        </IconButton>
      </div>
    );
  }

  return (
    <>
      <section
        className={cx(styles.window, maximized && styles.maximized)}
        /* Каскад задаётся переменной, а не свойством right: на узком экране
           окно раскрывается во весь экран правилом из CSS, а встроенный стиль
           перебил бы его и оставил окно у правого края. */
        style={maximized ? undefined : ({ '--mt-compose-offset': `${offset * 32}px` } as CSSProperties)}
        aria-label="Новое письмо"
        onKeyDown={(e) => {
          // Esc сохраняет черновик и закрывает окно (как в mail.ru).
          // Окно закрывается только после успешного сохранения: иначе
          // упавший запрос уносил бы с собой всё написанное.
          if (e.key === 'Escape') {
            e.stopPropagation();
            void saveAndClose();
          }
        }}
      >
        {/* Шапка окна: получатель + управление окном */}
        <div className={styles.header}>
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
                  <path
                    d="M5 5h14v14H5V5Zm2 2v10h10V7H7Z"
                    fill="currentColor"
                    fillRule="evenodd"
                  />
                </svg>
              </IconButton>
            </Tooltip>
            <Tooltip text="Закрыть">
              <IconButton label="Закрыть" size="s" onClick={closeByCross}>
                <IconClose size={14} />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        {/* Кому */}
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Кому</span>
          <input
            className={styles.fieldInput}
            value={to}
            onChange={(e) => patch({ to: e.target.value })}
            placeholder="Введите адрес"
            aria-label="Кому"
            autoFocus
          />
          <span className={styles.fieldLinks}>
            {!showCc && (
              <button type="button" className={styles.fieldLink} onClick={() => patch({ showCc: true })}>
                Копия
              </button>
            )}
            {!showBcc && (
              <button type="button" className={styles.fieldLink} onClick={() => patch({ showBcc: true })}>
                Скрытая
              </button>
            )}
          </span>
        </div>

        {showCc && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Копия</span>
            <input
              className={styles.fieldInput}
              value={cc}
              onChange={(e) => patch({ cc: e.target.value })}
              aria-label="Копия"
            />
          </div>
        )}
        {showBcc && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>Скрытая</span>
            <input
              className={styles.fieldInput}
              value={bcc}
              onChange={(e) => patch({ bcc: e.target.value })}
              aria-label="Скрытая"
            />
          </div>
        )}

        {/* От кого */}
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>От кого</span>
          <span className={styles.fieldStatic}>
            {account ? `${account.displayName} <${account.email}>` : '…'}
          </span>
        </div>

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
          <button type="button" className={styles.attachButton} onClick={() => fileRef.current?.click()}>
            <IconAttach />
            Прикрепить файл
          </button>
          {/* «Из Почты» — прикрепить файл, который уже приходил в другом
              письме. Кнопка была пустышкой (писала в консоль); теперь
              открывает выбор — см. MailAttachmentPicker. */}
          <button
            type="button"
            className={styles.attachButton}
            onClick={() => setPickerOpen(true)}
          >
            Из Почты
          </button>
          {attachments.map((a) => (
            <span key={a.id} className={styles.attachChip}>
              {a.filename}
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
        </div>

        {/*
          Панель форматирования: кнопки 32×32.

          Все значки — из одного набора (сетка 24×24, штрих 1.8, currentColor),
          как у mail.ru (research/mailru/03-compose.png). Раньше здесь стояли
          юникодные глифы «⇤ ↔ •• 1. ↶ ↷», цветное эмодзи 🔗, нативный
          `select` со смайликом и комбинирующий «A̶»: соседние кнопки были
          разной оптической плотности, а две — вообще цветные.

          Ж/К/Ч/З остаются буквами: у mail.ru начертания подписаны ровно так же.

          Выбор гарнитуры — не `select`, а меню: в 48px нативного селекта
          «Golos Text» не влезало и наезжало на стрелку. У mail.ru на его месте
          стоит значок «Tt», и выбор раскрывается меню.

          preventDefault на mousedown сохраняет выделение в редакторе — иначе
          команда применилась бы в пустоту.
        */}
        <div className={styles.formatBar} onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className={styles.fmtButton} title="Жирный" onClick={() => exec('bold')}>
            <b>Ж</b>
          </button>
          <button type="button" className={styles.fmtButton} title="Наклонный" onClick={() => exec('italic')}>
            <i>К</i>
          </button>
          <button type="button" className={styles.fmtButton} title="Подчёркнутый" onClick={() => exec('underline')}>
            <u>Ч</u>
          </button>
          <button type="button" className={styles.fmtButton} title="Зачёркнутый" onClick={() => exec('strikeThrough')}>
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

          <button type="button" className={styles.fmtButton} title="По левому краю" onClick={() => exec('justifyLeft')}>
            <IconAlignLeft size={20} />
          </button>
          <button type="button" className={styles.fmtButton} title="По центру" onClick={() => exec('justifyCenter')}>
            <IconAlignCenter size={20} />
          </button>
          <button type="button" className={styles.fmtButton} title="По правому краю" onClick={() => exec('justifyRight')}>
            <IconAlignRight size={20} />
          </button>
          <button type="button" className={styles.fmtButton} title="Маркированный список" onClick={() => exec('insertUnorderedList')}>
            <IconListBulleted size={20} />
          </button>
          <button type="button" className={styles.fmtButton} title="Нумерованный список" onClick={() => exec('insertOrderedList')}>
            <IconListNumbered size={20} />
          </button>
          <button type="button" className={styles.fmtButton} title="Отменить" onClick={() => exec('undo')}>
            <IconUndo size={20} />
          </button>
          <button type="button" className={styles.fmtButton} title="Повторить" onClick={() => exec('redo')}>
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

          <button type="button" className={styles.fmtButton} title="Очистить форматирование" onClick={() => exec('removeFormat')}>
            <IconClearFormat size={20} />
          </button>
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
          <Button mode="primary" className={styles.sendButton} onClick={send} disabled={sendMessage.isPending}>
            {sendMessage.isPending ? 'Отправка…' : 'Отправить'}
          </Button>
          <Button mode="secondary" onClick={() => void save()} disabled={saveDraft.isPending}>
            {saveDraft.isPending ? 'Сохранение…' : 'Сохранить'}
          </Button>
          <Button mode="secondary" onClick={discard}>
            Отменить
          </Button>
          {savedAt && (
            <span className={styles.savedNote}>
              Сохранено в {new Date(savedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <div className={styles.footerSpacer} />
          <Tooltip text="Уведомить о прочтении">
            <IconButton
              label="Уведомить о прочтении"
              onClick={() => console.info('Уведомления о прочтении появятся вместе с бэкендом')}
            >
              <IconMailRead />
            </IconButton>
          </Tooltip>
          <Tooltip text="Отложенная отправка">
            <IconButton
              label="Отложенная отправка"
              onClick={() => console.info('Отложенная отправка появится вместе с бэкендом')}
            >
              <IconEvent />
            </IconButton>
          </Tooltip>
        </div>
      </section>

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
