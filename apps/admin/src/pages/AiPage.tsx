/**
 * Помощник ИИ: настройки по домену, проверка связи и журнал обращений.
 *
 * Раздел управляет единственной вещью в почтовом сервере, которая
 * отправляет содержимое переписки наружу. Поэтому наверху всегда висит
 * прямая формулировка: включён помощник или нет, на какой адрес уходят
 * тексты писем и покидают ли они периметр.
 *
 * Кнопки прячутся по правам только ради удобства: настоящую проверку
 * делает сервер (domains.read на чтение, domains.write на изменение и
 * проверку связи, audit.read на журнал) — он ответит 403 независимо от
 * того, что нарисовано в интерфейсе.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox } from '@web/components';
import { api } from '../api/client';
import type { AiDomain, AiDomainPatch, AiReference, AiTestDraft, AiTestResult } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Table, TableWrap, tableStyles } from '../components/Table';
import { Badge, ErrorNotice, Field, Notice, Panel, Toolbar, ToolbarSpacer } from '../components/ui';
import {
  AI_PRESETS,
  canEnable,
  isInsidePerimeter,
  endpointOf,
  errorLabel,
  formatCount,
  formatDuration,
  isValidBaseUrl,
  parseLimit,
  parseNumber,
  periodLabel,
  periodOptions,
} from '../lib/ai';
import { formatDateTime } from '../lib/format';
import { AiAuditPanel } from './AiAuditPanel';
import styles from './AiPage.module.css';

/** Имя узла из адреса — для подписи «уйдёт на …». */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return baseUrl.trim();
  }
}

export function AiPage() {
  const { can } = useSession();
  const canWrite = can('domains.write');
  const canReadAudit = can('audit.read');

  const reference = useQuery({ queryKey: ['ai-reference'], queryFn: () => api.aiReference() });
  const domains = useQuery({ queryKey: ['ai-domains'], queryFn: () => api.aiDomains() });

  const [selected, setSelected] = useState<number | null>(null);
  const items = domains.data?.items ?? [];
  const current = items.find((item) => item.domainId === selected) ?? items[0] ?? null;

  return (
    <>
      <PageTitle
        title="Помощник ИИ"
        subtitle="Кому разрешён, какой сервис обрабатывает письма и сколько это стоит"
      />

      <ErrorNotice error={domains.error ?? reference.error} />

      {current && <OutboundWarning domain={current} />}

      {items.length === 0 && !domains.isLoading && !domains.error && (
        <Notice tone="info">
          Доменов пока нет. Сначала добавьте домен в разделе «Домены и DNS» — настройки помощника
          задаются отдельно для каждого домена.
        </Notice>
      )}

      {items.length > 0 && (
        <Toolbar>
          <select
            className="mt-select"
            style={{ width: 280 }}
            value={current ? String(current.domainId) : ''}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {items.map((item) => (
              <option key={item.domainId} value={item.domainId}>
                {item.domain} — {item.enabled ? 'включён' : 'выключен'}
              </option>
            ))}
          </select>
          <ToolbarSpacer />
          {current && (
            <span className={styles.muted}>
              Настройки изменены {formatDateTime(current.updatedAt)}
            </span>
          )}
        </Toolbar>
      )}

      {current && reference.data && (
        <DomainSettings
          // Ключ перерисовывает форму после сохранения и при смене домена:
          // черновик всегда начинается с того, что действительно в базе.
          key={`${String(current.domainId)}:${current.updatedAt}`}
          domain={current}
          reference={reference.data}
          canWrite={canWrite}
        />
      )}

      {canReadAudit && reference.data && <AiAuditPanel features={reference.data.features} />}
      {!canReadAudit && (
        <Notice tone="info">
          Журнал обращений показывается тем, у кого есть право на чтение журналов.
        </Notice>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Предупреждение о том, что уходит наружу                              */
/* ------------------------------------------------------------------ */

function OutboundWarning({ domain }: { domain: AiDomain }) {
  const endpoint = endpointOf(domain.baseUrl, domain.chatPath);

  if (!domain.enabled) {
    return (
      <Notice tone="info">
        Помощник для домена <b>{domain.domain}</b> выключен. Тексты писем никуда не отправляются,
        кнопок помощника пользователи не видят.
      </Notice>
    );
  }

  if (!domain.local) {
    return (
      <Notice tone="error">
        <b>Помощник включён, и модель находится за пределами сервера.</b> Пока он включён, темы,
        адреса отправителя и получателей и тексты писем домена <b>{domain.domain}</b> уходят на{' '}
        <code className="mt-mono">{endpoint}</code> — это сервис «{domain.providerLabel}». Письма
        покидают ваш сервер. Если это нежелательно, укажите модель внутри периметра или выключите
        помощника.
      </Notice>
    );
  }

  return (
    <Notice tone="success">
      Помощник включён. Тексты писем домена <b>{domain.domain}</b> отправляются на{' '}
      <code className="mt-mono">{endpoint}</code> и сервер не покидают: этот адрес ведёт во
      внутреннюю сеть. Признак больше не задаётся вручную — он следует из самого адреса, поэтому
      «внутри периметра» здесь означает то, что написано, а не то, что кто-то отметил галочкой.
    </Notice>
  );
}

/* ------------------------------------------------------------------ */
/* Настройки домена                                                     */
/* ------------------------------------------------------------------ */

/** Черновик формы: числа держим строками, чтобы поле можно было очистить. */
interface Draft {
  enabled: boolean;
  baseUrl: string;
  chatPath: string;
  model: string;
  providerLabel: string;
  /** Новый ключ доступа; пусто — сохранённый не трогаем. */
  apiKey: string;
  /** Стереть сохранённый ключ при сохранении. */
  clearKey: boolean;
  maxBodyChars: string;
  timeoutMs: string;
  maxOutputTokens: string;
  periodMs: number;
  maxTokensPerPeriod: string;
  maxRequestsPerPeriod: string;
  maxTokensPerRequest: string;
  /** true — разрешены все возможности (на сервере это null). */
  allowAll: boolean;
  allowed: string[];
}

function toDraft(domain: AiDomain): Draft {
  return {
    enabled: domain.enabled,
    baseUrl: domain.baseUrl ?? '',
    chatPath: domain.chatPath,
    model: domain.model ?? '',
    providerLabel: domain.providerLabel,
    apiKey: '',
    clearKey: false,
    maxBodyChars: String(domain.maxBodyChars),
    timeoutMs: String(domain.timeoutMs),
    maxOutputTokens: String(domain.maxOutputTokens),
    periodMs: domain.periodMs,
    maxTokensPerPeriod: domain.maxTokensPerPeriod === null ? '' : String(domain.maxTokensPerPeriod),
    maxRequestsPerPeriod:
      domain.maxRequestsPerPeriod === null ? '' : String(domain.maxRequestsPerPeriod),
    maxTokensPerRequest:
      domain.maxTokensPerRequest === null ? '' : String(domain.maxTokensPerRequest),
    allowAll: domain.featuresAllowed === null,
    allowed: domain.featuresAllowed ?? [],
  };
}

function DomainSettings({
  domain,
  reference,
  canWrite,
}: {
  domain: AiDomain;
  reference: AiReference;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(domain));
  const [flash, setFlash] = useState<string | null>(null);
  const [test, setTest] = useState<AiTestResult | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setFlash(null);
  };

  /* --- Что подключаем: готовый вариант, адрес и периметр -------------- */

  const [presetId, setPresetId] = useState('');
  const presetHint = AI_PRESETS.find((item) => item.id === presetId)?.hint ?? '';

  /**
   * Периметр — вывод из адреса, а не отдельная галочка и не поле запроса.
   * Здесь он считается ТОЛЬКО ради подсказки в форме: настоящий ответ даёт
   * сервер (apps/api/src/ai/admin.ts), и прислать ему «внутри периметра»
   * нельзя — раньше это поле принималось от клиента, и запрос мимо формы
   * заставлял экран согласия обещать пользователям почты то, чего нет.
   */
  const inside = isInsidePerimeter(draft.baseUrl);

  const applyPreset = (id: string): void => {
    setPresetId(id);
    const preset = AI_PRESETS.find((item) => item.id === id);
    if (!preset || preset.baseUrl === '') return;
    setDraft((previous) => ({
      ...previous,
      baseUrl: preset.baseUrl,
      // Название модели — только если человек ещё не вписал своё:
      // затирать набранное выбором из списка нельзя.
      model: previous.model.trim() === '' ? preset.model : previous.model,
    }));
    setFlash(null);
  };

  /* Разбор числовых полей: границы те же, что в схеме сервера. */
  const maxBodyChars = parseNumber(draft.maxBodyChars, 200, 200_000);
  const timeoutMs = parseNumber(draft.timeoutMs, 1000, 600_000);
  const maxOutputTokens = parseNumber(draft.maxOutputTokens, 64, 32_000);
  const tokensPerPeriod = parseLimit(draft.maxTokensPerPeriod);
  const requestsPerPeriod = parseLimit(draft.maxRequestsPerPeriod);
  const tokensPerRequest = parseLimit(draft.maxTokensPerRequest);

  const problems: string[] = [];
  if (draft.enabled && !canEnable(draft.baseUrl, draft.model)) {
    problems.push(
      'Чтобы включить помощника, нужны адрес сервиса и название модели — без них база не примет настройки.',
    );
  }
  if (draft.baseUrl.trim() !== '' && !isValidBaseUrl(draft.baseUrl)) {
    problems.push('Адрес сервиса должен начинаться с http:// или https://');
  }
  if (draft.chatPath.trim() === '') problems.push('Путь метода не может быть пустым');
  if (draft.providerLabel.trim() === '') {
    problems.push('Название сервиса не может быть пустым: его видит пользователь');
  }
  if (maxBodyChars === null) problems.push('Длина текста письма — целое число от 200 до 200 000');
  if (timeoutMs === null) problems.push('Время ожидания ответа — от 1000 до 600 000 мс');
  if (maxOutputTokens === null) problems.push('Длина ответа — от 64 до 32 000 токенов');
  if (!tokensPerPeriod.ok) problems.push('Предел токенов за период — целое число или пусто');
  if (!requestsPerPeriod.ok) problems.push('Предел обращений за период — целое число или пусто');
  if (!tokensPerRequest.ok) problems.push('Предел токенов на обращение — целое число или пусто');
  if (draft.apiKey !== '' && !reference.canStoreApiKey) {
    problems.push('Ключ доступа сохранить негде — уберите его из поля');
  }

  const buildPatch = (): AiDomainPatch => {
    // Числа уже проверены: сюда попадаем только когда problems пуст.
    const body: AiDomainPatch = {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl.trim() === '' ? null : draft.baseUrl.trim(),
      chatPath: draft.chatPath.trim(),
      model: draft.model.trim() === '' ? null : draft.model.trim(),
      providerLabel: draft.providerLabel.trim(),
      // `local` не отправляем: сервер выводит его из адреса сам.
      maxBodyChars: maxBodyChars ?? domain.maxBodyChars,
      timeoutMs: timeoutMs ?? domain.timeoutMs,
      maxOutputTokens: maxOutputTokens ?? domain.maxOutputTokens,
      periodMs: draft.periodMs,
      maxTokensPerPeriod: tokensPerPeriod.ok ? tokensPerPeriod.value : domain.maxTokensPerPeriod,
      maxRequestsPerPeriod: requestsPerPeriod.ok
        ? requestsPerPeriod.value
        : domain.maxRequestsPerPeriod,
      maxTokensPerRequest: tokensPerRequest.ok
        ? tokensPerRequest.value
        : domain.maxTokensPerRequest,
      featuresAllowed: draft.allowAll ? null : draft.allowed,
    };
    // Ключ доступа трогаем только если его действительно меняют:
    // отсутствие поля означает «оставить как есть».
    if (draft.clearKey) body.apiKey = null;
    else if (draft.apiKey.trim() !== '') body.apiKey = draft.apiKey.trim();
    return body;
  };

  const save = useMutation({
    mutationFn: () => api.updateAiDomain(domain.domainId, buildPatch()),
    onSuccess: () => {
      setFlash('Настройки сохранены');
      setTest(null);
      void queryClient.invalidateQueries({ queryKey: ['ai-domains'] });
    },
  });

  /**
   * Проверка связи — по тому, что СЕЙЧАС В ФОРМЕ, а не по записанному.
   *
   * Настройки поставщика подбирают перебором: не тот адрес, не та
   * модель, не тот ключ. Раньше проверить можно было только сохранённое,
   * то есть каждую пробу приходилось записывать поверх рабочих настроек
   * — одна неудачная, и помощник у всего домена сломан, пока человек не
   * вспомнит, что было раньше.
   *
   * Пустые поля не шлём вовсе: пустой ключ означал бы «проверь без
   * ключа», а человек имел в виду «оставь сохранённый». Незаполненное
   * поле ключа — самый частый случай: в браузер ключ не приезжает.
   */
  const runTest = useMutation({
    mutationFn: () => {
      const draft2: AiTestDraft = {};
      if (draft.baseUrl.trim() !== '') draft2.baseUrl = draft.baseUrl.trim();
      if (draft.chatPath.trim() !== '') draft2.chatPath = draft.chatPath.trim();
      if (draft.model.trim() !== '') draft2.model = draft.model.trim();
      if (draft.providerLabel.trim() !== '') draft2.providerLabel = draft.providerLabel.trim();
      if (draft.apiKey !== '') draft2.apiKey = draft.apiKey;
      return api.aiTest(domain.domainId, draft2);
    },
    onSuccess: (result) => setTest(result),
  });

  /*
   * Список моделей спрашивается у поставщика по нажатию, а не при
   * открытии страницы. Причина простая: это сетевой запрос наружу, и
   * делать его при каждом заходе в раздел — значит стучаться к
   * поставщику без всякой на то просьбы.
   *
   * Спрашивается то, что ЗАПИСАНО в базе: ключ доступа живёт на сервере
   * и в браузер не приезжает, поэтому список по несохранённому адресу
   * взять неоткуда.
   */
  const models = useMutation({
    mutationFn: () => api.aiModels(domain.domainId),
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(domain));

  return (
    <>
      {flash && <Notice tone="success">{flash}</Notice>}
      <ErrorNotice error={save.error ?? runTest.error ?? models.error} />

      {/* --- Подключение --- */}
      <div className={styles.panelGap}>
        <Panel title={`Подключение для домена ${domain.domain}`}>
          <div className={styles.switchRow}>
            <Checkbox
              label="Помощник включён для домена"
              checked={draft.enabled}
              disabled={!canWrite}
              onChange={(event) => set('enabled', event.target.checked)}
            />
          </div>

          {/*
            ЧТО ПОДКЛЮЧАЕМ — выбором, а не догадкой.

            Поле называлось «Адрес совместимого API», и это всё, что о нём
            можно было узнать: совместимого с чем, что туда писать —
            «claude», «chatgpt», «ollama»? Совместимость тут одна —
            OpenAI Chat Completions, тот самый формат, ради которого рядом
            стоит «Путь метода». Поэтому список того, что действительно
            подходит, с готовыми адресами.
          */}
          {canWrite && (
            <Field
              label="Что подключаем"
              hint="Выбор подставит адрес и пример модели. Дальше их можно поправить руками."
            >
              <select
                className="mt-select"
                value={presetId}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value="">— выбрать —</option>
                {AI_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {presetHint !== '' && <p className={styles.presetHint}>{presetHint}</p>}

          {/*
            Периметр ВЫЧИСЛЯЕТСЯ из адреса, а не объявляется галочкой.
            Галочка не проверяла ничего: меняла только текст, который
            видит пользователь почты, — «письма не покидают периметр»
            против «уйдёт наружу». То есть позволяла указать чужой сервис
            и сказать людям неправду ровно там, где они решают, доверить
            ли письмо.
          */}
          <div className={styles.perimeter}>
            {draft.baseUrl.trim() === '' ? (
              <Badge tone="muted">адрес не задан</Badge>
            ) : inside ? (
              <>
                <Badge tone="ok">внутри периметра</Badge> Модель отвечает по адресу внутренней сети
                — переписка не уходит за пределы сервера, и пользователю это видно.
              </>
            ) : (
              <>
                <Badge tone="warn">внешний сервис</Badge> Содержимое писем уйдёт на{' '}
                <span className="mt-mono">{hostOf(draft.baseUrl)}</span>. Пользователь увидит это
                перед тем, как согласиться.
              </>
            )}
          </div>

          <div className={styles.grid}>
            <div className={styles.wide}>
              <Field
                label="Адрес совместимого API"
                hint="Формат OpenAI Chat Completions. Локальная модель — http://host.docker.internal:11434/v1 (Ollama), внешний сервис — https://api.openai.com/v1."
              >
                <input
                  className="mt-input mt-mono"
                  placeholder="http://127.0.0.1:11434/v1"
                  value={draft.baseUrl}
                  disabled={!canWrite}
                  onChange={(event) => set('baseUrl', event.target.value)}
                />
              </Field>
            </div>

            <Field label="Путь метода" hint="По умолчанию /chat/completions">
              <input
                className="mt-input mt-mono"
                value={draft.chatPath}
                disabled={!canWrite}
                onChange={(event) => set('chatPath', event.target.value)}
              />
            </Field>

            <Field
              label="Название модели"
              hint={
                models.data?.ok === false
                  ? models.data.message
                  : models.data?.ok
                    ? `Поставщик назвал моделей: ${String(models.data.models.length)}`
                    : 'Можно вписать руками или взять список у самого поставщика.'
              }
            >
              {/*
                input + datalist, а не select: список у поставщика может
                оказаться пустым или неполным (обёртки над несколькими
                сервисами называют не всё, что принимают), и запереть
                человека в выпадающем списке значило бы отнять
                работающую настройку ради удобства.
              */}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="mt-input mt-mono"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder="qwen2.5:7b"
                  list={`ai-models-${String(domain.domainId)}`}
                  value={draft.model}
                  disabled={!canWrite}
                  onChange={(event) => set('model', event.target.value)}
                />
                <Button
                  mode="secondary"
                  disabled={!canWrite || models.isPending || domain.baseUrl === null}
                  onClick={() => models.mutate()}
                >
                  {models.isPending ? 'Спрашиваем…' : 'Список'}
                </Button>
              </div>
              <datalist id={`ai-models-${String(domain.domainId)}`}>
                {(models.data?.models ?? []).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>

            <Field
              label="Название сервиса для пользователя"
              hint="Эту строку человек увидит перед тем, как согласиться."
            >
              <input
                className="mt-input"
                value={draft.providerLabel}
                disabled={!canWrite}
                onChange={(event) => set('providerLabel', event.target.value)}
              />
            </Field>

            <div className={styles.wide}>
              <ApiKeyField
                draft={draft}
                domain={domain}
                reference={reference}
                canWrite={canWrite}
                set={set}
              />
            </div>
          </div>

          <p className={styles.muted} style={{ margin: 0 }}>
            Полный адрес запроса:{' '}
            <code className="mt-mono">
              {endpointOf(
                draft.baseUrl.trim() === '' ? null : draft.baseUrl.trim(),
                draft.chatPath,
              )}
            </code>
          </p>
        </Panel>
      </div>

      {/* --- Предел расходов --- */}
      <div className={styles.panelGap}>
        <Panel title="Предел расходов">
          <p className={styles.muted} style={{ marginTop: 0 }}>
            Пустое поле — без предела. Когда предел исчерпан, помощник отвечает понятным отказом, а
            почта продолжает работать как обычно.
          </p>
          <div className={styles.grid}>
            <Field label="Окно учёта" hint={`Сейчас: ${periodLabel(draft.periodMs)}`}>
              <select
                className="mt-select"
                value={String(draft.periodMs)}
                disabled={!canWrite}
                onChange={(event) => set('periodMs', Number(event.target.value))}
              >
                {periodOptions(domain.periodMs).map((option) => (
                  <option key={option.ms} value={option.ms}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Токенов за период" hint="Пусто — без предела">
              <input
                className="mt-input"
                inputMode="numeric"
                placeholder="без предела"
                value={draft.maxTokensPerPeriod}
                disabled={!canWrite}
                onChange={(event) => set('maxTokensPerPeriod', event.target.value)}
              />
            </Field>

            <Field label="Обращений за период" hint="Пусто — без предела">
              <input
                className="mt-input"
                inputMode="numeric"
                placeholder="без предела"
                value={draft.maxRequestsPerPeriod}
                disabled={!canWrite}
                onChange={(event) => set('maxRequestsPerPeriod', event.target.value)}
              />
            </Field>

            <Field label="Токенов на одно обращение" hint="Пусто — без предела">
              <input
                className="mt-input"
                inputMode="numeric"
                placeholder="без предела"
                value={draft.maxTokensPerRequest}
                disabled={!canWrite}
                onChange={(event) => set('maxTokensPerRequest', event.target.value)}
              />
            </Field>

            <Field
              label="Сколько символов письма отправлять"
              hint="От 200 до 200 000. Длинные письма обрезаются до этой длины."
            >
              <input
                className="mt-input"
                inputMode="numeric"
                value={draft.maxBodyChars}
                disabled={!canWrite}
                onChange={(event) => set('maxBodyChars', event.target.value)}
              />
            </Field>

            <Field
              label="Ждать ответа, мс"
              hint={
                timeoutMs === null
                  ? 'От 1000 до 600 000 мс'
                  : `Это ${formatDuration(timeoutMs)}. Дольше — пользователь получит отказ по времени.`
              }
            >
              <input
                className="mt-input"
                inputMode="numeric"
                value={draft.timeoutMs}
                disabled={!canWrite}
                onChange={(event) => set('timeoutMs', event.target.value)}
              />
            </Field>

            {/*
              Про минимумы сказано ПРЯМО, а не в коде.

              Число из этого поля — не окончательное: у перевода, разбора
              письма и разбора поискового запроса есть свой нижний предел,
              и работает max(это поле, минимум возможности). Иначе выходил
              обман: администратор ставит 256, чтобы держать расход в узде,
              а перевод резервирует 2000 из дневного предела домена — и
              нигде об этом ни слова. Обойтись без минимумов нельзя:
              перевод письма в 256 токенов — это обрубок на полуслове, за
              который тоже заплачено.
            */}
            <Field
              label="Длина ответа, токенов"
              hint="От 64 до 32 000. У перевода, разбора письма и разбора поискового запроса свой минимум (2000, 1500 и 600): если здесь меньше, для них берётся он"
            >
              <input
                className="mt-input"
                inputMode="numeric"
                value={draft.maxOutputTokens}
                disabled={!canWrite}
                onChange={(event) => set('maxOutputTokens', event.target.value)}
              />
            </Field>
          </div>
        </Panel>
      </div>

      {/* --- Возможности --- */}
      <div className={styles.panelGap}>
        <Panel title="Какие возможности разрешены в домене">
          <div className={styles.switchRow}>
            <Checkbox
              label="Разрешить все возможности"
              checked={draft.allowAll}
              disabled={!canWrite}
              onChange={(event) => {
                // Снятие флажка не должно означать «запретить всё»: показываем
                // список в том виде, в каком он сейчас работает — разрешено
                // всё, — а дальше администратор снимает лишнее.
                if (!event.target.checked && draft.allowed.length === 0) {
                  setDraft((previous) => ({
                    ...previous,
                    allowAll: false,
                    allowed: reference.features.map((feature) => feature.key),
                  }));
                  setFlash(null);
                  return;
                }
                set('allowAll', event.target.checked);
              }}
            />
          </div>
          <p className={styles.muted} style={{ marginTop: 0 }}>
            Если снять этот флажок, разрешёнными останутся только отмеченные ниже. Пустой список —
            это «ни одной возможности»: помощник будет включён, но пользователь не увидит ни одной
            кнопки. Чтобы разрешить всё, поставьте флажок выше, а не отмечайте все подряд.
          </p>

          {!draft.allowAll && draft.allowed.length === 0 && (
            <Notice tone="error">
              Не отмечено ни одной возможности — пользователи домена не получат от помощника ничего.
            </Notice>
          )}

          <div className={styles.features}>
            {reference.features.map((feature) => {
              const checked = draft.allowAll || draft.allowed.includes(feature.key);
              return (
                <div key={feature.key} className={styles.feature}>
                  <Checkbox
                    checked={checked}
                    disabled={!canWrite || draft.allowAll}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...draft.allowed, feature.key]
                        : draft.allowed.filter((key) => key !== feature.key);
                      set('allowed', [...new Set(next)]);
                    }}
                  />
                  <div>
                    <div className={styles.featureTitle}>{feature.title}</div>
                    <p className={styles.featureText}>{feature.description}</p>
                    <p className={styles.featureText}>Уходит наружу: {feature.sends}</p>
                    <p className={styles.featureText}>
                      В журнале: <span className="mt-mono">{feature.technical.join(', ')}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <p className={styles.muted} style={{ marginBottom: 4 }}>
            Что не отправляется никогда:
          </p>
          <ul className={styles.list}>
            {reference.neverSent.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* --- Сохранение и проверка --- */}
      {problems.length > 0 && (
        <Notice tone="error">
          <ul className={styles.list} style={{ margin: 0 }}>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}

      {canWrite && (
        <div className={styles.actions}>
          <Button
            disabled={problems.length > 0 || save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Сохраняем…' : 'Сохранить настройки'}
          </Button>
          <Button
            mode="secondary"
            disabled={!domain.enabled || runTest.isPending || dirty}
            onClick={() => runTest.mutate()}
          >
            {runTest.isPending ? 'Проверяем…' : 'Проверить связь'}
          </Button>
          <span className={styles.muted}>
            {!domain.enabled
              ? 'Проверка связи доступна после того, как помощник включён и настройки сохранены.'
              : dirty
                ? 'Сначала сохраните изменения — проверяется то, что записано в базе.'
                : 'Проверка делает один настоящий вызов сервиса на служебном тексте. Письма при этом не отправляются.'}
          </span>
        </div>
      )}

      {test && <TestResult result={test} />}
    </>
  );
}

/** Поле ключа доступа: ввод нового, подсказка о сохранённом, стирание. */
function ApiKeyField({
  draft,
  domain,
  reference,
  canWrite,
  set,
}: {
  draft: Draft;
  domain: AiDomain;
  reference: AiReference;
  canWrite: boolean;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const stored = domain.hasApiKey
    ? `Ключ сохранён${domain.apiKeyHint ? ` (${domain.apiKeyHint})` : ''}. Прочитать его нельзя ни администратору, ни через API — только заменить или стереть.`
    : 'Ключ не сохранён. Локальной модели он обычно и не нужен.';

  return (
    <Field
      label="Ключ доступа к сервису"
      hint={
        reference.canStoreApiKey ? (
          <>{stored} Пустое поле — сохранённый ключ остаётся как есть.</>
        ) : (
          <>{reference.apiKeyReason ?? 'Сохранить ключ сейчас нельзя.'}</>
        )
      }
    >
      <div className={styles.actions} style={{ marginBottom: 0 }}>
        <input
          className="mt-input mt-mono"
          type="password"
          autoComplete="new-password"
          placeholder={draft.clearKey ? 'ключ будет стёрт при сохранении' : 'новый ключ'}
          style={{ flex: '1 1 240px' }}
          value={draft.apiKey}
          disabled={!canWrite || !reference.canStoreApiKey || draft.clearKey}
          onChange={(event) => set('apiKey', event.target.value)}
        />
        {canWrite && domain.hasApiKey && !draft.clearKey && (
          <Button
            mode="secondary"
            size="s"
            onClick={() => {
              set('apiKey', '');
              set('clearKey', true);
            }}
          >
            Стереть ключ
          </Button>
        )}
        {canWrite && draft.clearKey && (
          <Button mode="secondary" size="s" onClick={() => set('clearKey', false)}>
            Не стирать
          </Button>
        )}
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------------ */
/* Результат проверки связи                                             */
/* ------------------------------------------------------------------ */

function TestResult({ result }: { result: AiTestResult }) {
  if (!result.ok) {
    return (
      <div className={styles.panelGap}>
        <Panel title="Проверка связи не прошла">
          <Notice tone="error">{result.message}</Notice>
          <TableWrap>
            <Table>
              <tbody>
                <tr>
                  <td className={tableStyles.nowrap} style={{ width: 200 }}>
                    Причина
                  </td>
                  <td>{errorLabel(result.reason)}</td>
                </tr>
                {result.status !== null && result.status !== undefined && (
                  <tr>
                    <td className={tableStyles.nowrap}>Код ответа сервиса</td>
                    <td className="mt-mono">{result.status}</td>
                  </tr>
                )}
                {result.durationMs !== undefined && (
                  <tr>
                    <td className={tableStyles.nowrap}>Заняло</td>
                    <td>{formatDuration(result.durationMs)}</td>
                  </tr>
                )}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      </div>
    );
  }

  return (
    <div className={styles.panelGap}>
      <Panel title="Проверка связи прошла">
        <TableWrap>
          <Table>
            <tbody>
              <tr>
                <td className={tableStyles.nowrap} style={{ width: 200 }}>
                  Адрес
                </td>
                <td className="mt-mono" style={{ wordBreak: 'break-all' }}>
                  {result.endpoint}
                </td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Модель</td>
                <td className="mt-mono">{result.model}</td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Внутри периметра</td>
                <td>
                  <Badge tone={result.local ? 'ok' : 'warn'}>
                    {result.local ? 'да, письма не покидают сервер' : 'нет, данные уходят наружу'}
                  </Badge>
                </td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Токенов</td>
                <td>
                  {formatCount(result.usage.totalTokens)} (запрос{' '}
                  {formatCount(result.usage.promptTokens)}, ответ{' '}
                  {formatCount(result.usage.completionTokens)})
                  {result.usage.estimated && ' — сервис не сообщил расход, число получено оценкой'}
                </td>
              </tr>
              <tr>
                <td className={tableStyles.nowrap}>Заняло</td>
                <td>{formatDuration(result.durationMs)}</td>
              </tr>
            </tbody>
          </Table>
        </TableWrap>
        <p className={styles.muted} style={{ marginBottom: 4 }}>
          Что ответила модель:
        </p>
        <p className={styles.summary}>{result.summary}</p>
      </Panel>
    </div>
  );
}
