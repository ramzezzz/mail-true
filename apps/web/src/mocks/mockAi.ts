/**
 * Заглушка помощника на основе ИИ: состояние, согласие и правдоподобные
 * русские ответы возможностей. Нужна, чтобы интерфейс помощника было видно
 * в dev-режиме (там по умолчанию моки, см. src/api/index.ts) без бэкенда.
 *
 * По умолчанию здесь `enabled: true` и согласие УЖЕ дано — иначе интерфейс
 * пришлось бы смотреть через экран согласия. В настоящем сервере всё ровно
 * наоборот: помощник выключен, пока администратор его не разрешит,
 * а пользователь не согласится.
 *
 * Поставщик намеренно локальный (`local: true`): это главный сценарий,
 * ради которого почтовый сервер вообще ставят к себе.
 */

import type {
  AiClassification,
  AiConsentRevokeResult,
  AiContinuation,
  AiContinueRequest,
  AiEnvelope,
  AiExtraction,
  AiFeatureKey,
  AiFeatureState,
  AiOutboundDisclosure,
  AiParsedSearchQuery,
  AiRepliesRequest,
  AiReplyTone,
  AiReplyVariants,
  AiRewriteRequest,
  AiRewriteResult,
  AiState,
  AiSummarizeRequest,
  AiSummary,
  AiTranslateRequest,
  AiTranslation,
  AiUsageReport,
} from '../api/aiTypes';

const PROVIDER = {
  label: 'Локальная модель (llama.cpp)',
  model: 'qwen2.5-14b-instruct',
  endpoint: 'http://ai.internal:8080/v1',
  local: true,
} as const;

const FEATURE_INFO: ReadonlyArray<Omit<AiFeatureState, 'enabled'>> = [
  {
    key: 'summary',
    title: 'Краткое резюме',
    description: 'Три-четыре строки вместо длинного письма или всей переписки.',
    sends: 'Тема, отправитель, получатели, дата и текст письма (или всех писем цепочки).',
    allowed: true,
  },
  {
    key: 'classify',
    title: 'Раскладка по смыслу',
    description: 'Метка письма: счёт, доставка, встреча, договор, личное.',
    sends: 'Тема, отправитель, получатели, дата и первые 2000 символов текста письма.',
    allowed: true,
  },
  {
    key: 'reply',
    title: 'Помощь с ответом',
    description:
      'Варианты ответа с разным тоном, продолжение начатой фразы, правка написанного. ' +
      'Ответ попадает в поле ввода как черновик — отправка только вашими руками.',
    sends:
      'Тема, отправитель, получатели, дата и текст письма, на которое вы отвечаете, ' +
      'а также ваш черновик, если он уже начат.',
    allowed: true,
  },
  {
    key: 'extract',
    title: 'Извлечение полезного',
    description: 'Даты и встречи, суммы и реквизиты, задачи и сроки, номера отслеживания.',
    sends: 'Тема, отправитель, получатели, дата и текст письма.',
    allowed: true,
  },
  {
    key: 'translate',
    title: 'Перевод',
    description: 'Перевод письма с сохранением абзацев и списков.',
    sends: 'Только текст письма. Тема, отправитель и получатели не отправляются.',
    allowed: true,
  },
  {
    key: 'search',
    title: 'Поиск обычными словами',
    description:
      '«письма от бухгалтерии про оплату в марте» превращается в параметры поиска. ' +
      'Во что именно превратился запрос, показывается — чтобы можно было поправить.',
    sends: 'Только строка поиска, которую вы набрали. Письма не отправляются.',
    allowed: true,
  },
];

const NEVER_SENT: string[] = [
  'Вложения — ни содержимое, ни фрагменты. Только имена файлов остаются у нас.',
  'Пароль от ящика и любые учётные данные.',
  'Содержимое других писем — только того, по которому нажата кнопка.',
  'Служебные заголовки (Received, DKIM-Signature, X-*).',
  'Подписи отправителя и цитаты предыдущей переписки — они вырезаются до отправки.',
];

/* ------------------------------------------------------------------ */
/* Изменяемое состояние вкладки                                         */
/* ------------------------------------------------------------------ */

interface MockAiState {
  enabled: boolean;
  consentGiven: boolean;
  consentAt: string | null;
  features: Set<AiFeatureKey>;
  tokensUsed: number;
  requestsUsed: number;
  /** Сколько ответов «сохранено» — столько же и удалится при отзыве. */
  cacheEntries: number;
  /** Письма, по которым ответ уже считался: второй раз придёт из кэша. */
  seen: Set<string>;
}

const state: MockAiState = {
  // Переключите на false, чтобы проверить: интерфейс не должен показать
  // ни одной кнопки помощника.
  enabled: true,
  consentGiven: true,
  consentAt: '2026-07-28T09:12:00Z',
  features: new Set<AiFeatureKey>(['summary', 'reply', 'extract', 'translate']),
  tokensUsed: 18_430,
  requestsUsed: 37,
  cacheEntries: 12,
  seen: new Set<string>(),
};

export function mockAiState(): AiState {
  return {
    enabled: state.enabled,
    provider: state.enabled ? { ...PROVIDER } : null,
    consent: {
      given: state.consentGiven,
      at: state.consentAt,
      matchesProvider: true,
      consentedEndpoint: state.consentGiven ? PROVIDER.endpoint : null,
      consentedModel: state.consentGiven ? PROVIDER.model : null,
    },
    features: FEATURE_INFO.map((f) => ({ ...f, enabled: state.features.has(f.key) })),
    neverSent: [...NEVER_SENT],
    budget: {
      periodMs: 24 * 60 * 60 * 1000,
      windowStartedAt: Date.now() - 5 * 60 * 60 * 1000,
      tokensUsed: state.tokensUsed,
      requestsUsed: state.requestsUsed,
      tokensLimit: 200_000,
      requestsLimit: 300,
      tokensLeft: 200_000 - state.tokensUsed,
      requestsLeft: 300 - state.requestsUsed,
    },
  };
}

export function mockAiGiveConsent(features?: AiFeatureKey[]): AiState {
  state.consentGiven = true;
  state.consentAt = new Date().toISOString();
  state.features = new Set(features ?? ['summary', 'reply', 'extract', 'translate']);
  return mockAiState();
}

export function mockAiRevokeConsent(): AiConsentRevokeResult {
  const removedCacheEntries = state.cacheEntries;
  state.consentGiven = false;
  state.consentAt = null;
  state.features = new Set();
  state.cacheEntries = 0;
  state.seen.clear();
  return { ...mockAiState(), removedCacheEntries };
}

export function mockAiSetFeatures(features: AiFeatureKey[]): AiState {
  state.features = new Set(features);
  return mockAiState();
}

export function mockAiForget(messageId: string): { removed: number } {
  const removed = state.seen.delete(messageId) ? 3 : 0;
  state.cacheEntries = Math.max(0, state.cacheEntries - removed);
  return { removed };
}

export function mockAiUsage(): AiUsageReport {
  const full = mockAiState();
  return {
    enabled: full.enabled,
    budget: full.budget,
    totals: {
      requests: state.requestsUsed,
      cachedRequests: 14,
      failedRequests: 1,
      promptTokens: Math.round(state.tokensUsed * 0.78),
      completionTokens: Math.round(state.tokensUsed * 0.22),
      totalTokens: state.tokensUsed,
      outboundChars: state.tokensUsed * 3,
    },
    recent: [],
  };
}

/* ------------------------------------------------------------------ */
/* Опись отправленного и конверт ответа                                 */
/* ------------------------------------------------------------------ */

/**
 * Опись отправленного. В заглушке она одна на все письма, но нарочно
 * подробная: с вырезанной подписью, вырезанными цитатами, исключённым
 * вложением и длинным телом — чтобы в dev-режиме было видно и сам блок,
 * и раскрытие длинного значения.
 */
export function mockAiOutbound(_messageId: string): AiOutboundDisclosure {
  const body =
    'Добрый день!\n\n' +
    'Направляем счёт № 1043 от 3 августа 2026 года на оплату продления лицензий ' +
    'на следующий год. Сумма к оплате — 148 500,00 ₽, в том числе НДС 20% ' +
    '(24 750,00 ₽). Счёт приложен к письму отдельным файлом.\n\n' +
    'Оплату просим произвести до 12 августа. После поступления средств доступ ' +
    'будет продлён автоматически, дополнительных действий с вашей стороны ' +
    'не потребуется. Если оплата задержится, напишите нам — продлим доступ ' +
    'вручную на время прохождения платежа.\n\n' +
    'Реквизиты для оплаты указаны в счёте; они же продублированы в подписи.';
  return {
    endpoint: PROVIDER.endpoint,
    model: PROVIDER.model,
    providerLabel: PROVIDER.label,
    local: PROVIDER.local,
    fields: [
      { field: 'subject', label: 'Тема', value: 'Счёт № 1043 на продление лицензий', chars: 33 },
      { field: 'from', label: 'Отправитель', value: 'buh@postavshchik.ru', chars: 19 },
      { field: 'to', label: 'Получатели', value: 'demo@mail.true', chars: 14 },
      { field: 'date', label: 'Дата', value: '3 августа 2026, 10:24', chars: 21 },
      { field: 'body', label: 'Текст письма', value: body, chars: body.length },
    ],
    removed: [
      { kind: 'signature', count: 1, chars: 148, note: 'Подпись отправителя вырезана' },
      { kind: 'quote', count: 2, chars: 612, note: 'Цитаты предыдущей переписки вырезаны' },
      { kind: 'headers', count: 9, chars: 740, note: 'Служебные заголовки не отправлялись' },
      {
        kind: 'html-markup',
        count: 1,
        chars: 2_140,
        note: 'Разметка письма отброшена, ушёл только текст',
      },
      { kind: 'attachment', count: 1, chars: 184_320, note: 'Вложение не отправлялось' },
    ],
    attachmentsExcluded: ['Счёт-1043.pdf'],
    totalChars: 87 + body.length,
    approxTokens: Math.round((87 + body.length) / 3),
  };
}

/** Конверт ответа: второй раз по тому же ключу приходит из кэша. */
function envelope<T>(key: string, value: T): AiEnvelope<T> {
  const cached = state.seen.has(key);
  if (!cached) {
    state.seen.add(key);
    state.cacheEntries += 1;
    state.requestsUsed += 1;
    state.tokensUsed += 640;
  }
  return {
    value,
    cached,
    usage: {
      promptTokens: cached ? 0 : 520,
      completionTokens: cached ? 0 : 120,
      totalTokens: cached ? 0 : 640,
      estimated: true,
    },
    disclosure: cached ? null : mockAiOutbound(key),
    durationMs: cached ? 4 : 1180,
  };
}

/* ------------------------------------------------------------------ */
/* Возможности                                                          */
/* ------------------------------------------------------------------ */

export function mockAiSummarize(request: AiSummarizeRequest): AiEnvelope<AiSummary> {
  const thread = 'messageIds' in request;
  const key = thread ? `thread:${request.messageIds.join(',')}` : `summary:${request.messageId}`;
  const value: AiSummary = thread
    ? {
        summary:
          'Переписка о продлении лицензий: поставщик выставил счёт, бухгалтерия ' +
          'уточнила реквизиты, оплата согласована до 12 августа.',
        bullets: [
          'Счёт № 1043 на 148 500 ₽ выставлен 3 августа',
          'Реквизиты уточнены и подтверждены',
          'Крайний срок оплаты — 12 августа',
          'После оплаты доступ продлевается автоматически',
        ],
        actionRequired: true,
      }
    : {
        summary:
          'Поставщик прислал счёт на продление лицензий и просит оплатить его ' +
          'до 12 августа. К письму приложен PDF со счётом.',
        bullets: [
          'Счёт № 1043 от 3 августа',
          'Сумма — 148 500 ₽, включая НДС',
          'Оплатить до 12 августа',
        ],
        actionRequired: true,
      };
  return envelope(key, value);
}

export function mockAiClassify(messageId: string): AiEnvelope<AiClassification> {
  return envelope(`classify:${messageId}`, {
    category: 'invoice',
    confidence: 0.92,
    reason: 'В письме есть номер счёта, сумма с НДС и срок оплаты.',
    labels: ['счёт', 'оплата'],
  });
}

export function mockAiExtract(messageId: string): AiEnvelope<AiExtraction> {
  return envelope(`extract:${messageId}`, {
    events: [
      {
        title: 'Крайний срок оплаты счёта № 1043',
        startsAt: '2026-08-12T00:00:00+03:00',
        endsAt: null,
        location: null,
        source: 'Оплату просим произвести до 12 августа',
      },
    ],
    amounts: [
      {
        amount: '148 500,00',
        currency: 'RUB',
        purpose: 'Итого к оплате',
        source: 'Итого: 148 500,00 ₽',
      },
      {
        amount: '24 750,00',
        currency: 'RUB',
        purpose: 'НДС 20%',
        source: 'в том числе НДС 24 750,00 ₽',
      },
    ],
    requisites: [
      { kind: 'inn', value: '7701234567', label: 'ИНН поставщика' },
      { kind: 'bic', value: '044525225', label: 'БИК банка' },
      { kind: 'account', value: '40702810400000012345', label: 'Расчётный счёт' },
      { kind: 'invoice-number', value: '1043', label: 'Номер счёта' },
    ],
    tasks: [
      {
        title: 'Оплатить счёт № 1043',
        dueAt: '2026-08-12T00:00:00+03:00',
        assignee: 'Бухгалтерия',
        source: 'Оплату просим произвести до 12 августа',
      },
    ],
    tracking: [
      {
        number: 'RA123456785RU',
        carrier: 'Почта России',
        url: 'https://www.pochta.ru/tracking#RA123456785RU',
      },
    ],
  });
}

export function mockAiTranslate(request: AiTranslateRequest): AiEnvelope<AiTranslation> {
  const key = 'messageId' in request ? `translate:${request.messageId}` : `translate-text`;
  const text =
    'messageId' in request
      ? 'Добрый день!\n\nНаправляем счёт на продление лицензий на следующий год. ' +
        'Просим оплатить его до 12 августа — после поступления средств доступ ' +
        'будет продлён автоматически.\n\nС уважением,\nотдел продаж'
      : `Перевод на «${request.targetLanguage}»: ${request.text}`;
  return envelope(key, { text, detectedLanguage: 'en' });
}

const REPLY_BODIES: Record<AiReplyTone, string> = {
  short: 'Добрый день! Счёт получил, передал в бухгалтерию. Оплатим до 12 августа.',
  detailed:
    'Добрый день!\n\nСпасибо, счёт № 1043 получили. Передали его в бухгалтерию, ' +
    'оплата запланирована на эту неделю — не позже 12 августа. ' +
    'Как только платёж пройдёт, пришлём платёжное поручение.\n\nС уважением,',
  formal:
    'Уважаемые коллеги!\n\nПодтверждаем получение счёта № 1043 от 3 августа 2026 года. ' +
    'Оплата будет произведена в установленный срок — до 12 августа 2026 года. ' +
    'Копию платёжного поручения направим дополнительно.\n\nС уважением,',
};

export function mockAiReplies(request: AiRepliesRequest): AiEnvelope<AiReplyVariants> {
  const tones = request.tones ?? (['short', 'detailed', 'formal'] as AiReplyTone[]);
  return envelope(`replies:${request.messageId}:${tones.join(',')}:${request.instruction ?? ''}`, {
    variants: tones.map((tone) => ({ tone, body: REPLY_BODIES[tone] })),
  });
}

export function mockAiContinue(request: AiContinueRequest): AiEnvelope<AiContinuation> {
  return envelope(`continue:${request.draft.slice(-40)}`, {
    continuation:
      ' и передам его в бухгалтерию сегодня же. Оплату проведём до 12 августа, ' +
      'платёжное поручение пришлю следом.',
  });
}

export function mockAiRewrite(request: AiRewriteRequest): AiEnvelope<AiRewriteResult> {
  const source = request.text.trim();
  const result: Record<AiRewriteRequest['mode'], AiRewriteResult> = {
    shorten: {
      text: source.split(/\s+/).slice(0, 24).join(' ') + (source.length > 140 ? '…' : ''),
      changes: ['Убраны повторы', 'Длинные обороты заменены короткими'],
    },
    soften: {
      text: `Если вас не затруднит, ${source.charAt(0).toLowerCase()}${source.slice(1)}`,
      changes: ['Категоричные формулировки смягчены', 'Добавлена вежливая просьба'],
    },
    fix: {
      text: source.replace(/\s+/g, ' ').replace(/ ,/g, ',').replace(/\s+\./g, '.'),
      changes: ['Исправлены пробелы перед знаками препинания'],
    },
  };
  return envelope(`rewrite:${request.mode}:${source.slice(0, 40)}`, result[request.mode]);
}

export function mockAiSearchQuery(query: string): AiEnvelope<AiParsedSearchQuery> {
  return envelope(`search:${query}`, {
    from: ['buh@'],
    to: [],
    subject: ['оплат'],
    text: ['счёт'],
    dateFrom: '2026-03-01',
    dateTo: '2026-03-31',
    hasAttachments: null,
    unreadOnly: null,
    folder: null,
    explanation:
      'Ищем письма от адресов, содержащих «buh@», со словом «оплат» в теме ' +
      'и словом «счёт» в тексте, отправленные в марте 2026 года.',
  });
}
