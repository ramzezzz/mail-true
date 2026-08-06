/**
 * Помощник на странице письма: кнопка «Кратко», плашка резюме,
 * плашка извлечённых данных и перевод письма.
 *
 * Устройство: вся логика собрана в контроллере {@link useMessageAi},
 * а показывают её три отдельных компонента — потому что кнопка живёт
 * в панели действий, плашки в прокручиваемой области, а перевод заменяет
 * тело письма. Каждый компонент сам возвращает null, когда помощник
 * выключен: правило «выключен — не видно ни одной кнопки» не должно
 * зависеть от того, не забыл ли вызывающий поставить условие.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useAiExtract,
  useAiForgetMessage,
  useAiState,
  useAiSummarize,
  useAiTranslate,
} from '../api/aiQueries';
import type {
  AiExtraction,
  AiOutboundDisclosure,
  AiSummarizeRequest,
  AiSummary,
} from '../api/aiTypes';
import { aiRequisiteTitles } from '../api/aiTypes';
import { Button, IconButton, MenuItem, Spinner } from '../components';
import { cx } from '../lib/cx';
import { IconCheck, IconClose, IconCopy, IconSparkles, IconTranslate } from '../mail/icons';
import {
  AI_SETTINGS_PATH,
  aiFeatureVisible,
  aiErrorText,
  aiNeedsConsent,
  aiVisible,
} from './aiVisibility';
import { OutboundDetails } from './OutboundDetails';
import styles from './MessageAi.module.css';

/** Язык, на который переводим по умолчанию. */
const TARGET_LANGUAGE = 'русский';

export interface MessageAiController {
  /** Помощник разрешён администратором — иначе не показываем ничего. */
  enabled: boolean;
  /** Согласие не дано или устарело: кнопки ведут на экран согласия. */
  needsConsent: boolean;
  openSettings(): void;

  summaryVisible: boolean;
  summaryOpen: boolean;
  summaryPending: boolean;
  summary: AiSummary | null;
  summaryError: string | null;
  /**
   * Опись отправленного. null означает, что ответ взят из сохранённого
   * ранее и наружу не уходило ничего, — отдельного флага «из кэша» нет
   * намеренно, чтобы два источника правды не разошлись.
   */
  summaryDisclosure: AiOutboundDisclosure | null;
  /** Резюме всей переписки, а не одного письма. */
  summaryIsThread: boolean;
  toggleSummary(): void;

  extraction: AiExtraction | null;
  extractionPending: boolean;
  extractionDisclosure: AiOutboundDisclosure | null;

  translateVisible: boolean;
  translatePending: boolean;
  translation: string | null;
  translationLanguage: string;
  translationDisclosure: AiOutboundDisclosure | null;
  translationError: string | null;
  translationShown: boolean;
  translate(): void;
  showOriginal(): void;
  showTranslation(): void;

  /** Забыть всё, что помощник насчитал по этому письму. */
  forget(): void;
  forgetPending: boolean;
  /** Сколько записей удалено последним «забыть»; null — забывания не было. */
  forgotten: number | null;
}

export interface MessageAiOptions {
  /** Составной идентификатор письма; undefined — письмо ещё не загружено. */
  messageId: string | undefined;
  /** Все письма цепочки, включая текущее. Больше одного — резюмируем переписку. */
  threadIds?: readonly string[] | undefined;
}

export function useMessageAi({ messageId, threadIds }: MessageAiOptions): MessageAiController {
  const navigate = useNavigate();
  const { data: state } = useAiState();
  const summarize = useAiSummarize();
  const extract = useAiExtract();
  const translate = useAiTranslate();
  const forget = useAiForgetMessage();

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [translationShown, setTranslationShown] = useState(false);

  const enabled = aiVisible(state);
  const needsConsent = aiNeedsConsent(state);
  const summaryVisible = aiFeatureVisible(state, 'summary');
  const extractVisible = aiFeatureVisible(state, 'extract');
  const translateVisible = aiFeatureVisible(state, 'translate');

  const ids = useMemo(() => [...(threadIds ?? [])], [threadIds]);
  const isThread = ids.length > 1;

  // Сменилось письмо — забываем всё, что насчитано по предыдущему.
  const resetSummarize = summarize.reset;
  const resetExtract = extract.reset;
  const resetTranslate = translate.reset;
  const resetForget = forget.reset;
  useEffect(() => {
    setSummaryOpen(false);
    setTranslationShown(false);
    resetSummarize();
    resetExtract();
    resetTranslate();
    resetForget();
  }, [messageId, resetSummarize, resetExtract, resetTranslate, resetForget]);

  const openSettings = useCallback(() => {
    void navigate(AI_SETTINGS_PATH);
  }, [navigate]);

  const toggleSummary = useCallback(() => {
    if (!messageId) return;
    if (needsConsent) {
      openSettings();
      return;
    }
    if (summaryOpen) {
      setSummaryOpen(false);
      return;
    }
    setSummaryOpen(true);
    if (summarize.data || summarize.isPending) return;

    const request: AiSummarizeRequest = isThread ? { messageIds: ids } : { messageId };
    summarize.mutate(request);
    // Извлечение полезного считаем заодно с резюме: пользователь нажал
    // одну кнопку, и оба ответа относятся к одному и тому же письму.
    if (extractVisible && !extract.data && !extract.isPending) extract.mutate(messageId);
  }, [
    messageId,
    needsConsent,
    openSettings,
    summaryOpen,
    summarize,
    isThread,
    ids,
    extractVisible,
    extract,
  ]);

  const doTranslate = useCallback(() => {
    if (!messageId) return;
    if (needsConsent) {
      openSettings();
      return;
    }
    setTranslationShown(true);
    if (translate.data || translate.isPending) return;
    translate.mutate({ messageId, targetLanguage: TARGET_LANGUAGE });
  }, [messageId, needsConsent, openSettings, translate]);

  /**
   * Забыть насчитанное по этому письму. После удаления сбрасываем и то,
   * что показано на экране: иначе пользователь видел бы «удалённое» резюме.
   */
  const doForget = useCallback(() => {
    if (!messageId) return;
    forget.mutate(messageId, {
      onSuccess: () => {
        resetSummarize();
        resetExtract();
        resetTranslate();
        setSummaryOpen(false);
        setTranslationShown(false);
      },
    });
  }, [messageId, forget, resetSummarize, resetExtract, resetTranslate]);

  return {
    enabled,
    needsConsent,
    openSettings,

    summaryVisible,
    summaryOpen,
    summaryPending: summarize.isPending,
    summary: summarize.data?.value ?? null,
    summaryError: summarize.error ? aiErrorText(summarize.error) : null,
    summaryDisclosure: summarize.data?.disclosure ?? null,
    summaryIsThread: isThread,
    toggleSummary,

    extraction: extract.data?.value ?? null,
    extractionPending: extract.isPending,
    extractionDisclosure: extract.data?.disclosure ?? null,

    translateVisible,
    translatePending: translate.isPending,
    translation: translate.data?.value.text ?? null,
    translationLanguage: translate.data?.value.detectedLanguage ?? '',
    translationDisclosure: translate.data?.disclosure ?? null,
    translationError: translate.error ? aiErrorText(translate.error) : null,
    translationShown,
    translate: doTranslate,
    showOriginal: () => setTranslationShown(false),
    showTranslation: () => setTranslationShown(true),

    forget: doForget,
    forgetPending: forget.isPending,
    forgotten: forget.data?.removed ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Кнопка «Кратко» в панели действий                                    */
/* ------------------------------------------------------------------ */

export function AiSummaryButton({ controller }: { controller: MessageAiController }) {
  if (!controller.summaryVisible) return null;
  return (
    <Button
      mode="tertiary"
      before={<IconSparkles />}
      onClick={controller.toggleSummary}
      aria-expanded={controller.summaryOpen}
      title={controller.summaryIsThread ? 'Кратко о всей переписке' : 'Кратко о письме'}
    >
      Кратко
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Пункт «Перевести письмо» в меню «Ещё действия»                       */
/* ------------------------------------------------------------------ */

export function AiTranslateMenuItem({ controller }: { controller: MessageAiController }) {
  if (!controller.translateVisible) return null;
  const shown = controller.translationShown && controller.translation !== null;
  return (
    <MenuItem
      before={<IconTranslate />}
      onClick={shown ? controller.showOriginal : controller.translate}
    >
      {shown ? 'Показать оригинал' : 'Перевести письмо'}
    </MenuItem>
  );
}

/* ------------------------------------------------------------------ */
/* Плашки: резюме и извлечённые данные                                  */
/* ------------------------------------------------------------------ */

export function AiMessageBanners({ controller }: { controller: MessageAiController }) {
  if (!controller.enabled) return null;
  return (
    <>
      {controller.summaryOpen && <SummaryBanner controller={controller} />}
      {controller.summaryOpen && <ExtractionBanner controller={controller} />}
      {controller.translatePending && (
        <div className={styles.banner}>
          <div className={styles.pending}>
            <Spinner size={16} label="Идёт перевод" />
            Переводим письмо…
          </div>
        </div>
      )}
      {controller.translationError && !controller.translatePending && (
        <div className={styles.banner}>
          <div className={styles.error}>{controller.translationError}</div>
        </div>
      )}
      {controller.forgotten !== null && (
        <div className={styles.banner}>
          <div className={styles.note}>
            Помощник забыл это письмо. Удалено записей: {controller.forgotten}.
          </div>
        </div>
      )}
    </>
  );
}

function SummaryBanner({ controller }: { controller: MessageAiController }) {
  const title = controller.summaryIsThread ? 'Кратко о переписке' : 'Кратко о письме';
  return (
    <section className={styles.banner} aria-label={title}>
      <div className={styles.bannerHead}>
        <span className={styles.bannerIcon}>
          <IconSparkles />
        </span>
        <span className={styles.bannerTitle}>{title}</span>
        <IconButton
          label="Скрыть резюме"
          size="s"
          className={styles.bannerClose}
          onClick={controller.toggleSummary}
        >
          <IconClose size={14} />
        </IconButton>
      </div>

      {controller.summaryPending && (
        <div className={styles.pending}>
          <Spinner size={16} label="Готовим резюме" />
          Готовим резюме…
        </div>
      )}

      {controller.summaryError && !controller.summaryPending && (
        <div className={styles.error}>{controller.summaryError}</div>
      )}

      {controller.summary && !controller.summaryPending && (
        <>
          <p className={styles.summaryText}>{controller.summary.summary}</p>
          {controller.summary.bullets.length > 0 && (
            <ul className={styles.bullets}>
              {controller.summary.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {controller.summary.actionRequired && (
            <span className={styles.actionRequired}>От вас ждут ответа или действия</span>
          )}
          {/* Опись отправленного; для ответа из кэша — строка про кэш */}
          <OutboundDetails disclosure={controller.summaryDisclosure} />
          <div className={styles.note}>
            <button
              type="button"
              className={styles.noteButton}
              onClick={controller.forget}
              disabled={controller.forgetPending}
            >
              Забыть результаты по этому письму
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function ExtractionBanner({ controller }: { controller: MessageAiController }) {
  const data = controller.extraction;
  if (controller.extractionPending) return null;
  if (!data) return null;

  const found =
    data.events.length +
    data.amounts.length +
    data.requisites.length +
    data.tasks.length +
    data.tracking.length;
  // Ничего не нашлось — плашки нет вовсе, пустая рамка только мешает.
  if (found === 0) return null;

  return (
    <section className={styles.banner} aria-label="Найдено в письме">
      <div className={styles.bannerHead}>
        <span className={styles.bannerIcon}>
          <IconSparkles />
        </span>
        <span className={styles.bannerTitle}>Найдено в письме</span>
      </div>

      <div className={styles.groups}>
        {data.events.length > 0 && (
          <Group title="Даты и встречи">
            {data.events.map((e, i) => (
              <CopyItem
                key={`${e.title}-${i}`}
                value={e.title}
                label={
                  [formatWhen(e.startsAt), e.location].filter(Boolean).join(', ') || 'Без даты'
                }
              />
            ))}
          </Group>
        )}

        {data.amounts.length > 0 && (
          <Group title="Суммы">
            {data.amounts.map((a, i) => (
              <CopyItem
                key={`${a.amount}-${i}`}
                value={`${a.amount}${a.currency ? ` ${a.currency}` : ''}`}
                label={a.purpose || 'Сумма'}
              />
            ))}
          </Group>
        )}

        {data.requisites.length > 0 && (
          <Group title="Реквизиты">
            {data.requisites.map((r, i) => (
              <CopyItem
                key={`${r.value}-${i}`}
                value={r.value}
                label={r.label || aiRequisiteTitles[r.kind]}
              />
            ))}
          </Group>
        )}

        {data.tasks.length > 0 && (
          <Group title="Задачи и сроки">
            {data.tasks.map((t, i) => (
              <CopyItem
                key={`${t.title}-${i}`}
                value={t.title}
                label={
                  [formatWhen(t.dueAt), t.assignee].filter(Boolean).join(', ') || 'Срок не указан'
                }
              />
            ))}
          </Group>
        )}

        {data.tracking.length > 0 && (
          <Group title="Отслеживание">
            {data.tracking.map((t, i) => (
              <CopyItem
                key={`${t.number}-${i}`}
                value={t.number}
                label={t.carrier ?? 'Перевозчик не указан'}
              />
            ))}
          </Group>
        )}
      </div>

      <OutboundDetails disclosure={controller.extractionDisclosure} />
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <div className={styles.groupTitle}>{title}</div>
      <div className={styles.items}>{children}</div>
    </div>
  );
}

/** Значение, которое копируется одним нажатием. */
function CopyItem({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <button type="button" className={styles.item} onClick={copy} title={`Скопировать: ${value}`}>
      <span className={styles.itemBody}>
        <span className={styles.itemValue}>{value}</span>
        <span className={styles.itemLabel}>{copied ? 'Скопировано' : label}</span>
      </span>
      <span className={cx(styles.itemIcon, copied && styles.itemCopied)}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Перевод вместо тела письма                                           */
/* ------------------------------------------------------------------ */

export function AiTranslatedBody({ controller }: { controller: MessageAiController }) {
  if (!controller.enabled || !controller.translationShown || !controller.translation) return null;
  return (
    <>
      <div className={styles.translationBar}>
        <span className={styles.bannerIcon}>
          <IconTranslate />
        </span>
        Переведено на {TARGET_LANGUAGE}
        {controller.translationLanguage ? ` с «${controller.translationLanguage}»` : ''}
        <span className={styles.translationBarSpacer} />
        <button type="button" className={styles.noteButton} onClick={controller.showOriginal}>
          Показать оригинал
        </button>
      </div>
      <div className={styles.translationOutbound}>
        <OutboundDetails disclosure={controller.translationDisclosure} />
      </div>
      {/* Текст от модели выводим как текст: чужой HTML в письмо не вставляем */}
      <pre className={styles.translationBody}>{controller.translation}</pre>
    </>
  );
}

/* ------------------------------------------------------------------ */

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
