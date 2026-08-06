/**
 * Помощник на основе ИИ: главное правило — «выключен, значит не видно».
 *
 * Проверяем именно его: при `enabled: false` ни один компонент помощника
 * не рисует ни байта разметки. Плюс правила видимости отдельных
 * возможностей и разбор ошибок API.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../src/api/http';
import type { AiOutboundDisclosure, AiState, AiSummary } from '../src/api/aiTypes';
import { OutboundDetails } from '../src/ai/OutboundDetails';
import { aiErrorText, aiFeatureVisible, aiNeedsConsent, aiVisible } from '../src/ai/aiVisibility';
import {
  AiMessageBanners,
  AiSummaryButton,
  AiTranslateMenuItem,
  AiTranslatedBody,
  type MessageAiController,
} from '../src/ai/MessageAi';
import { AiSettingsView } from '../src/pages/AiSettingsPage';

/* ------------------------------------------------------------------ */
/* Заготовки состояния                                                  */
/* ------------------------------------------------------------------ */

function state(patch: Partial<AiState> = {}): AiState {
  return {
    enabled: true,
    provider: {
      label: 'Локальная модель',
      model: 'qwen2.5-14b-instruct',
      endpoint: 'http://ai.internal:8080/v1',
      local: true,
    },
    consent: {
      given: true,
      at: '2026-07-28T09:12:00Z',
      matchesProvider: true,
      consentedEndpoint: 'http://ai.internal:8080/v1',
      consentedModel: 'qwen2.5-14b-instruct',
    },
    features: [
      {
        key: 'summary',
        title: 'Краткое резюме',
        description: 'Три-четыре строки вместо длинного письма.',
        sends: 'Тема, отправитель, получатели, дата и текст письма.',
        allowed: true,
        enabled: true,
      },
      {
        key: 'translate',
        title: 'Перевод',
        description: 'Перевод письма с сохранением абзацев.',
        sends: 'Только текст письма.',
        allowed: true,
        enabled: true,
      },
      {
        key: 'classify',
        title: 'Раскладка по смыслу',
        description: 'Метка письма.',
        sends: 'Тема и первые 2000 символов.',
        allowed: false,
        enabled: false,
      },
    ],
    neverSent: ['Вложения не отправляются.'],
    budget: null,
    ...patch,
  };
}

const summary: AiSummary = {
  summary: 'Поставщик прислал счёт и просит оплатить до 12 августа.',
  bullets: ['Счёт № 1043', 'Оплатить до 12 августа'],
  actionRequired: true,
};

function disclosure(patch: Partial<AiOutboundDisclosure> = {}): AiOutboundDisclosure {
  return {
    endpoint: 'http://ai.internal:8080/v1',
    model: 'qwen2.5-14b-instruct',
    providerLabel: 'Локальная модель',
    local: true,
    fields: [
      { field: 'subject', label: 'Тема', value: 'Счёт № 1043', chars: 11 },
      { field: 'body', label: 'Текст письма', value: 'Оплатить до 12 августа.', chars: 23 },
    ],
    removed: [{ kind: 'signature', count: 1, chars: 148, note: 'Подпись отправителя вырезана' }],
    attachmentsExcluded: ['Счёт-1043.pdf'],
    totalChars: 1234,
    approxTokens: 411,
    ...patch,
  };
}

/** Контроллер-заготовка: показ отделён от логики, поэтому его можно собрать руками. */
function controller(patch: Partial<MessageAiController> = {}): MessageAiController {
  return {
    enabled: true,
    needsConsent: false,
    openSettings: () => {},

    summaryVisible: true,
    summaryOpen: true,
    summaryPending: false,
    summary,
    summaryError: null,
    summaryDisclosure: disclosure(),
    summaryIsThread: false,
    toggleSummary: () => {},

    extraction: null,
    extractionPending: false,
    extractionDisclosure: disclosure(),

    translateVisible: true,
    translatePending: false,
    translation: null,
    translationLanguage: '',
    translationDisclosure: disclosure(),
    translationError: null,
    translationShown: false,
    translate: () => {},
    showOriginal: () => {},
    showTranslation: () => {},

    forget: () => {},
    forgetPending: false,
    forgotten: null,
    ...patch,
  };
}

/* ------------------------------------------------------------------ */

describe('правила видимости помощника', () => {
  it('состояние не загружено — помощника нет', () => {
    expect(aiVisible(undefined)).toBe(false);
    expect(aiFeatureVisible(undefined, 'summary')).toBe(false);
    expect(aiNeedsConsent(undefined)).toBe(false);
  });

  it('администратор выключил — не видно ни одной возможности', () => {
    const off = state({ enabled: false });
    expect(aiVisible(off)).toBe(false);
    expect(aiFeatureVisible(off, 'summary')).toBe(false);
    expect(aiFeatureVisible(off, 'translate')).toBe(false);
  });

  it('запрещённая администратором возможность не показывается', () => {
    expect(aiFeatureVisible(state(), 'classify')).toBe(false);
  });

  it('выключенная пользователем возможность не показывается', () => {
    const s = state();
    const summaryFeature = s.features[0]!;
    summaryFeature.enabled = false;
    expect(aiFeatureVisible(s, 'summary')).toBe(false);
  });

  it('без согласия кнопки видны — они ведут на экран согласия', () => {
    const s = state({
      consent: {
        given: false,
        at: null,
        matchesProvider: true,
        consentedEndpoint: null,
        consentedModel: null,
      },
    });
    expect(aiNeedsConsent(s)).toBe(true);
    expect(aiFeatureVisible(s, 'summary')).toBe(true);
  });

  it('администратор сменил сервис — согласие спрашивается заново', () => {
    const s = state();
    s.consent.matchesProvider = false;
    expect(aiNeedsConsent(s)).toBe(true);
  });
});

describe('компоненты помощника при выключенном помощнике', () => {
  const off = controller({
    enabled: false,
    summaryVisible: false,
    translateVisible: false,
    summaryOpen: false,
    translationShown: false,
  });

  it('кнопка «Кратко» не рисует ничего', () => {
    expect(renderToStaticMarkup(<AiSummaryButton controller={off} />)).toBe('');
  });

  it('пункт «Перевести письмо» не рисует ничего', () => {
    expect(renderToStaticMarkup(<AiTranslateMenuItem controller={off} />)).toBe('');
  });

  it('плашки не рисуют ничего', () => {
    expect(renderToStaticMarkup(<AiMessageBanners controller={off} />)).toBe('');
  });

  it('перевод не подменяет тело письма', () => {
    const withTranslation = controller({
      enabled: false,
      translationShown: true,
      translation: 'Добрый день!',
    });
    expect(renderToStaticMarkup(<AiTranslatedBody controller={withTranslation} />)).toBe('');
  });

  it('раздел настроек не рисует ничего', () => {
    const html = renderToStaticMarkup(
      <AiSettingsView
        state={state({ enabled: false })}
        busy={false}
        removedCacheEntries={null}
        error={null}
        onAccept={() => {}}
        onRevoke={() => {}}
        onSaveFeatures={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('раздел настроек молчит и пока состояние не загружено', () => {
    const html = renderToStaticMarkup(
      <AiSettingsView
        state={undefined}
        busy={false}
        removedCacheEntries={null}
        error={null}
        onAccept={() => {}}
        onRevoke={() => {}}
        onSaveFeatures={() => {}}
      />,
    );
    expect(html).toBe('');
  });
});

describe('компоненты помощника при включённом помощнике', () => {
  it('кнопка «Кратко» появляется', () => {
    const html = renderToStaticMarkup(<AiSummaryButton controller={controller()} />);
    expect(html).toContain('Кратко');
  });

  it('плашка показывает резюме и пункты', () => {
    const html = renderToStaticMarkup(<AiMessageBanners controller={controller()} />);
    expect(html).toContain('Кратко о письме');
    expect(html).toContain('Счёт № 1043');
    expect(html).toContain('От вас ждут ответа');
  });

  it('ответ из кэша честно об этом сообщает и описи не показывает', () => {
    const html = renderToStaticMarkup(
      <AiMessageBanners controller={controller({ summaryDisclosure: null })} />,
    );
    expect(html).toContain('наружу ничего не отправлялось');
    expect(html).not.toContain('Что ушло наружу');
  });

  it('к живому ответу приложена опись отправленного', () => {
    const html = renderToStaticMarkup(<AiMessageBanners controller={controller()} />);
    expect(html).toContain('Что ушло наружу');
    expect(html).toContain('Счёт-1043.pdf');
    // Разделитель разрядов у ru-RU — неразрывный пробел, поэтому регулярка
    expect(html).toMatch(/1\s234/);
  });

  it('результаты по письму можно забыть, и об этом честно сообщается', () => {
    const html = renderToStaticMarkup(<AiMessageBanners controller={controller()} />);
    expect(html).toContain('Забыть результаты по этому письму');

    const after = renderToStaticMarkup(
      <AiMessageBanners controller={controller({ summaryOpen: false, forgotten: 3 })} />,
    );
    expect(after).toContain('Удалено записей: 3');
  });

  it('плашка извлечённых данных не показывается, если ничего не нашлось', () => {
    const html = renderToStaticMarkup(
      <AiMessageBanners
        controller={controller({
          extraction: { events: [], amounts: [], requisites: [], tasks: [], tracking: [] },
        })}
      />,
    );
    expect(html).not.toContain('Найдено в письме');
  });

  it('найденные значения показываются кнопками для копирования', () => {
    const html = renderToStaticMarkup(
      <AiMessageBanners
        controller={controller({
          extraction: {
            events: [],
            amounts: [
              { amount: '148 500,00', currency: 'RUB', purpose: 'Итого к оплате', source: '' },
            ],
            requisites: [{ kind: 'inn', value: '7701234567', label: '' }],
            tasks: [],
            tracking: [],
          },
        })}
      />,
    );
    expect(html).toContain('Найдено в письме');
    expect(html).toContain('148 500,00 RUB');
    expect(html).toContain('7701234567');
    expect(html).toContain('ИНН');
    expect(html).toContain('Скопировать');
  });

  it('перевод заменяет тело письма и даёт вернуть оригинал', () => {
    const html = renderToStaticMarkup(
      <AiTranslatedBody
        controller={controller({ translationShown: true, translation: 'Добрый день!' })}
      />,
    );
    expect(html).toContain('Добрый день!');
    expect(html).toContain('Показать оригинал');
  });
});

describe('опись отправленного', () => {
  it('ответ из кэша: описи нет, есть строка про кэш', () => {
    const html = renderToStaticMarkup(<OutboundDetails disclosure={null} />);
    expect(html).toContain('Ответ сохранён ранее, наружу ничего не отправлялось.');
    expect(html).not.toContain('Что ушло наружу');
    expect(html).not.toContain('<details');
  });

  it('живой ответ: видно вложение, поля, вырезанное и итог', () => {
    const html = renderToStaticMarkup(<OutboundDetails disclosure={disclosure()} />);
    expect(html).toContain('Что ушло наружу');
    // имя исключённого вложения
    expect(html).toContain('Счёт-1043.pdf');
    // totalChars с разделителем разрядов ru-RU (неразрывный пробел)
    expect(html).toMatch(/1\s234/);
    expect(html).toContain('Текст письма');
    expect(html).toContain('Подпись отправителя вырезана');
    expect(html).toContain('Итого отправлено');
    expect(html).not.toContain('наружу ничего не отправлялось');
  });

  it('локальная модель названа прямо', () => {
    const html = renderToStaticMarkup(<OutboundDetails disclosure={disclosure()} />);
    expect(html).toContain('письмо не покидало периметр');
    expect(html).toContain('http://ai.internal:8080/v1');
  });

  it('внешний сервис назван прямо', () => {
    const html = renderToStaticMarkup(
      <OutboundDetails
        disclosure={disclosure({ local: false, providerLabel: 'Внешний сервис' })}
      />,
    );
    expect(html).toContain('ушло за пределы вашего сервера');
    expect(html).toContain('Внешний сервис');
  });

  it('длинное значение обрезается, но раскрывается', () => {
    const long = 'а'.repeat(500);
    const html = renderToStaticMarkup(
      <OutboundDetails
        disclosure={disclosure({
          fields: [{ field: 'body', label: 'Текст письма', value: long, chars: long.length }],
        })}
      />,
    );
    expect(html).toContain('Показать целиком');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(long);
  });

  it('склонение по числу — не «1 символов»', () => {
    const html = renderToStaticMarkup(
      <OutboundDetails disclosure={disclosure({ totalChars: 1, approxTokens: 2 })} />,
    );
    expect(html).toContain('1 символ,');
    expect(html).toContain('2 токена');
  });
});

describe('экран согласия', () => {
  const props = {
    busy: false,
    removedCacheEntries: null,
    error: null,
    onAccept: () => {},
    onRevoke: () => {},
    onSaveFeatures: () => {},
  };

  it('для локальной модели главное сказано прямо', () => {
    const html = renderToStaticMarkup(<AiSettingsView state={state()} {...props} />);
    expect(html).toContain('письма не покидают периметр');
    expect(html).toContain('http://ai.internal:8080/v1');
    expect(html).toContain('qwen2.5-14b-instruct');
  });

  it('для внешнего сервиса предупреждение другое', () => {
    const html = renderToStaticMarkup(
      <AiSettingsView
        state={state({
          provider: {
            label: 'Внешний сервис',
            model: 'gpt-4o-mini',
            endpoint: 'https://api.example.com/v1',
            local: false,
          },
        })}
        {...props}
      />,
    );
    expect(html).toContain('Это внешний сервис');
    expect(html).toContain('уйдёт за пределы вашего сервера');
  });

  it('показывает только разрешённые администратором возможности', () => {
    const html = renderToStaticMarkup(<AiSettingsView state={state()} {...props} />);
    expect(html).toContain('Краткое резюме');
    expect(html).toContain('Перевод');
    expect(html).not.toContain('Раскладка по смыслу');
  });

  it('перечисляет, что не отправляется никогда, и объясняет хранение', () => {
    const html = renderToStaticMarkup(<AiSettingsView state={state()} {...props} />);
    expect(html).toContain('Вложения не отправляются.');
    expect(html).toContain('Ответы сервиса сохраняются на нашем сервере');
  });

  it('говорит, где проверить обещания на деле', () => {
    const html = renderToStaticMarkup(<AiSettingsView state={state()} {...props} />);
    expect(html).toContain('Точный состав отправленного показывается рядом с каждым');
    expect(html).toContain('Что ушло наружу');
  });

  it('честно показывает, сколько записей удалено при отзыве', () => {
    const html = renderToStaticMarkup(
      <AiSettingsView state={state()} {...props} removedCacheEntries={12} />,
    );
    expect(html).toContain('Удалено записей: 12');
  });

  it('при смене сервиса объясняет, почему спрашивают заново', () => {
    const s = state();
    s.consent.matchesProvider = false;
    const html = renderToStaticMarkup(<AiSettingsView state={s} {...props} />);
    expect(html).toContain('Администратор сменил сервис');
    expect(html).toContain('Включить помощника');
  });
});

describe('ошибки API', () => {
  it('ApiError несёт и код, и человеческий текст', () => {
    const error = new ApiError(
      429,
      '/api/ai/summarize',
      'Израсходовано 200 000 токенов',
      'AI_BUDGET_EXCEEDED',
    );
    expect(error.code).toBe('AI_BUDGET_EXCEEDED');
    expect(error.message).toBe('Израсходовано 200 000 токенов');
  });

  it('код без человеческого текста остаётся совместимым со старым вызовом', () => {
    const error = new ApiError(500, '/api/messages', 'Internal Server Error');
    expect(error.code).toBeNull();
    expect(error.message).toBe('Internal Server Error');
  });

  it('сообщение про лимит показывается дословно', () => {
    const error = new ApiError(
      429,
      '/api/ai/summarize',
      'Израсходовано 200 000 токенов',
      'AI_BUDGET_EXCEEDED',
    );
    expect(aiErrorText(error)).toBe('Израсходовано 200 000 токенов');
  });

  it('отказ сервиса сворачивается в понятную фразу', () => {
    const error = new ApiError(502, '/api/ai/summarize', 'upstream said no', 'AI_UPSTREAM');
    expect(aiErrorText(error)).toBe('Подсказки временно недоступны');
  });
});
