/**
 * Сквозные тесты помощника на поддельном сервере: проверяется весь путь —
 * подготовка данных, кэш, предел расходов, журнал и устойчивость к отказам.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MailAssistant, disabledAssistant } from '../assistant.js';
import { InMemoryAuditLog } from '../audit.js';
import { MemoryAiCache } from '../cache.js';
import type { ChatProvider, ChatResult, StreamEvent } from '../provider.js';
import { ZERO_USAGE, aiFail, type AiOutcome, type OutboundDisclosure } from '../types.js';
import {
  SSE_DONE,
  completion,
  outboundText,
  sampleMessage,
  sseDelta,
  startFakeAiServer,
  type FakeReply,
  type FakeServer,
} from './helpers.js';

const ctx = { accountId: 'ivan@example.org' };

interface Rig {
  server: FakeServer;
  assistant: MailAssistant;
  audit: InMemoryAuditLog;
  cache: MemoryAiCache;
  close(): Promise<void>;
}

async function rig(
  plan: FakeReply[],
  overrides?: { provider?: Record<string, unknown>; limits?: Record<string, unknown> },
): Promise<Rig> {
  const server = await startFakeAiServer(plan);
  const audit = new InMemoryAuditLog();
  const cache = new MemoryAiCache();
  const created = MailAssistant.create({
    provider: {
      enabled: true,
      baseUrl: server.baseUrl,
      model: 'local-model',
      providerLabel: 'Локальная модель',
      // Признак «внутри периметра» здесь не задаётся: baseUrl поддельного
      // сервера — 127.0.0.1, и пакет выводит его сам.
      maxRetries: 0,
      retryBaseDelayMs: 1,
      timeoutMs: 2000,
      ...overrides?.provider,
    },
    ...(overrides?.limits ? { limits: overrides.limits } : {}),
    deps: { audit, cache, providerDeps: { sleep: async (): Promise<void> => undefined } },
  });
  assert.ok(created.ok, created.ok ? '' : created.issues.join('; '));

  return {
    server,
    assistant: created.assistant,
    audit,
    cache,
    close: () => server.close(),
  };
}

const summaryReply = (text = 'Счёт № 1024 на 45 600 руб., оплатить до 20 марта.'): FakeReply => ({
  json: completion(
    JSON.stringify({ summary: text, bullets: ['Сумма 45 600 руб.'], actionRequired: true }),
    { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
  ),
});

describe('помощник выключен', () => {
  it('по умолчанию настройки дают выключенного помощника', () => {
    const created = MailAssistant.create({
      provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
    });
    assert.ok(created.ok);
    assert.equal(created.assistant.enabled, false);
  });

  it('вызов выключенного помощника возвращает понятный отказ', async () => {
    const result = await disabledAssistant().summarizeMessage(sampleMessage(), ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, 'disabled');
      assert.equal(result.error.retryable, false);
    }
  });

  it('неверные настройки не приводят к исключению', () => {
    const created = MailAssistant.create({ provider: { baseUrl: 'не адрес', model: '' } });
    assert.equal(created.ok, false);
    if (!created.ok) assert.ok(created.issues.length >= 2);
  });
});

describe('резюме письма', () => {
  it('успешный разбор и опись отправленного', async () => {
    const r = await rig([summaryReply()]);
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(result.ok);
      assert.equal(result.value.summary, 'Счёт № 1024 на 45 600 руб., оплатить до 20 марта.');
      assert.equal(result.value.actionRequired, true);
      assert.equal(result.usage.totalTokens, 340);
      assert.equal(result.cached, false);

      const disclosure = result.disclosure;
      assert.ok(disclosure);
      assert.equal(disclosure.model, 'local-model');
      assert.equal(disclosure.local, true);
      assert.equal(disclosure.providerLabel, 'Локальная модель');
      assert.deepEqual(disclosure.attachmentsExcluded, ['schet-1024.pdf']);
    } finally {
      await r.close();
    }
  });

  it('наружу уходит ровно то, что перечислено в описи', async () => {
    const r = await rig([summaryReply()]);
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(result.ok);
      const disclosure = result.disclosure;
      assert.ok(disclosure);

      const request = r.server.requests[0];
      assert.ok(request);
      const sent = outboundText(request);

      // Всё из описи действительно ушло.
      for (const field of disclosure.fields) {
        assert.ok(sent.includes(field.value), `не отправлено поле ${field.field}`);
      }

      // А вырезанное — не ушло.
      assert.ok(!sent.includes('schet-1024.pdf'), 'имя вложения ушло наружу');
      assert.ok(!sent.includes('Мария Сидорова'), 'подпись ушла наружу');
      assert.ok(!sent.includes('+7 495 123-45-67'), 'телефон из подписи ушёл наружу');
      assert.ok(!sent.includes('пришлите, пожалуйста, счёт'), 'цитата ушла наружу');
      assert.ok(!sent.includes('DKIM-Signature'), 'служебный заголовок ушёл наружу');
      assert.ok(!sent.includes('mx.romashka.ru'), 'служебный заголовок ушёл наружу');
    } finally {
      await r.close();
    }
  });

  it('previewOutbound показывает опись без отправки', async () => {
    const r = await rig([summaryReply()]);
    try {
      const disclosure = r.assistant.previewOutbound(sampleMessage());
      assert.ok(disclosure.totalChars > 0);
      assert.deepEqual(disclosure.attachmentsExcluded, ['schet-1024.pdf']);
      assert.equal(r.server.requests.length, 0, 'наружу ушёл запрос при простом показе описи');
    } finally {
      await r.close();
    }
  });

  it('пустое письмо не отправляется наружу', async () => {
    const r = await rig([summaryReply()]);
    try {
      const result = await r.assistant.summarizeMessage(
        sampleMessage({ subject: '', bodyText: null, bodyHtml: null }),
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, 'invalid-input');
      assert.equal(r.server.requests.length, 0);
    } finally {
      await r.close();
    }
  });
});

describe('кэш', () => {
  it('повторный запрос не идёт наружу', async () => {
    const r = await rig([summaryReply()]);
    try {
      const first = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(first.ok);
      assert.equal(first.cached, false);

      const second = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(second.ok);
      assert.equal(second.cached, true);
      assert.equal(second.disclosure, null, 'у ответа из кэша не должно быть описи отправленного');
      assert.deepEqual(second.value, first.value);
      assert.equal(second.usage.totalTokens, 0, 'ответ из кэша не стоит токенов');

      assert.equal(r.server.requests.length, 1, 'повторный запрос ушёл наружу');
    } finally {
      await r.close();
    }
  });

  it('skipCache заставляет обратиться к сервису заново', async () => {
    const r = await rig([summaryReply(), summaryReply('второй ответ')]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const second = await r.assistant.summarizeMessage(sampleMessage(), {
        ...ctx,
        skipCache: true,
      });
      assert.ok(second.ok);
      assert.equal(second.value.summary, 'второй ответ');
      assert.equal(r.server.requests.length, 2);
    } finally {
      await r.close();
    }
  });

  it('изменившееся письмо считается заново', async () => {
    const r = await rig([summaryReply(), summaryReply('письмо изменилось')]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const changed = await r.assistant.summarizeMessage(
        sampleMessage({ bodyText: 'Совершенно другой текст письма, ничего общего.' }),
        ctx,
      );
      assert.ok(changed.ok);
      assert.equal(r.server.requests.length, 2);
    } finally {
      await r.close();
    }
  });

  it('другая возможность — другой ключ кэша', async () => {
    const r = await rig([
      summaryReply(),
      { json: completion(JSON.stringify({ category: 'invoice', confidence: 0.95 })) },
    ]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const classified = await r.assistant.classifyMessage(sampleMessage(), ctx);
      assert.ok(classified.ok);
      assert.equal(classified.value.category, 'invoice');
      assert.equal(r.server.requests.length, 2);
    } finally {
      await r.close();
    }
  });

  it('forgetMessage удаляет всё, что насчитано по письму', async () => {
    const r = await rig([summaryReply(), summaryReply('пересчитано')]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const removed = await r.assistant.forgetMessage('inbox:42');
      assert.equal(removed, 1);

      const again = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(again.ok);
      assert.equal(again.value.summary, 'пересчитано');
      assert.equal(r.server.requests.length, 2);
    } finally {
      await r.close();
    }
  });
});

describe('ограничение расходов', () => {
  it('при исчерпании предела вызов отклоняется и наружу не идёт', async () => {
    const r = await rig([summaryReply(), summaryReply()], {
      limits: { maxRequestsPerPeriod: 1 },
    });
    try {
      const first = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(first.ok);

      const second = await r.assistant.summarizeMessage(
        sampleMessage({ id: 'inbox:43', bodyText: 'Другое письмо целиком.' }),
        ctx,
      );
      assert.equal(second.ok, false);
      if (!second.ok) {
        assert.equal(second.error.kind, 'budget-exceeded');
        assert.equal(second.error.retryable, false);
        assert.ok(second.error.message.length > 10, 'сообщение об исчерпании должно быть понятным');
      }
      assert.equal(r.server.requests.length, 1, 'запрос ушёл наружу вопреки пределу');
    } finally {
      await r.close();
    }
  });

  it('предел по токенам за период останавливает вызовы', async () => {
    /*
     * Потолок ответа входит в резерв: раньше оценивался только текст
     * запроса, и предел прорывался ровно на длину ответа. Поэтому здесь
     * потолок задан явно (64), иначе стандартные 1024 токена ответа
     * съели бы весь предел ещё на первом вызове — и это было бы честно.
     */
    const r = await rig([summaryReply()], {
      provider: { maxOutputTokens: 64 },
      limits: { maxTokensPerPeriod: 400 },
    });
    try {
      const first = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(first.ok);

      const snapshot = await r.assistant.budgetSnapshot(ctx.accountId);
      assert.equal(snapshot.tokensUsed, 340, 'резерв обязан смениться фактическим расходом');
      assert.equal(snapshot.tokensLeft, 60);

      const second = await r.assistant.summarizeMessage(
        sampleMessage({ id: 'inbox:44', bodyText: 'Ещё одно длинное письмо про оплату счетов.' }),
        ctx,
      );
      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.error.kind, 'budget-exceeded');
      assert.equal(r.server.requests.length, 1);
    } finally {
      await r.close();
    }
  });

  it('слишком большой запрос отклоняется до отправки', async () => {
    const r = await rig([summaryReply()], { limits: { maxTokensPerRequest: 10 } });
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, 'budget-exceeded');
      assert.equal(r.server.requests.length, 0);
    } finally {
      await r.close();
    }
  });

  it('предел на обращение сравнивается с письмом, а не со стоимостью вызова', async () => {
    /*
     * Предел «токенов на одно обращение» отвечает на вопрос «не слишком
     * ли длинное письмо мы отдаём модели». Когда с ним сравнили резерв —
     * то есть письмо ПЛЮС потолок ответа, — нижней границей стали 1024
     * токена независимо от длины письма: администратор, поставивший
     * разумную тысячу, получал отказ на каждую кнопку, включая письмо в
     * одну строку. Тысяча против письма на две строки обязана проходить.
     */
    const r = await rig([summaryReply()], { limits: { maxTokensPerRequest: 1000 } });
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(result.ok, result.ok ? '' : `помощник отказал: ${result.error.message}`);
      assert.equal(r.server.requests.length, 1, 'запрос до модели не дошёл');
    } finally {
      await r.close();
    }
  });

  it('но в счёт периода потолок ответа входит: он тоже оплачивается', async () => {
    // Обратная сторона того же: предел ЗА ПЕРИОД обязан считать ответ,
    // иначе он прорывался бы на длину ответа при каждом вызове.
    const r = await rig([summaryReply()], {
      limits: { maxTokensPerRequest: 1000, maxTokensPerPeriod: 400 },
    });
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.equal(result.ok, false, 'резерв без потолка ответа пропустил вызов');
      if (!result.ok) assert.equal(result.error.kind, 'budget-exceeded');
      assert.equal(r.server.requests.length, 0);
    } finally {
      await r.close();
    }
  });

  it('ответ из кэша предел не расходует', async () => {
    const r = await rig([summaryReply()], { limits: { maxRequestsPerPeriod: 1 } });
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const cached = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(cached.ok);
      assert.equal(cached.cached, true);
    } finally {
      await r.close();
    }
  });
});

describe('журнал обращений', () => {
  it('пишет когда, какое письмо, какая возможность и сколько токенов', async () => {
    const r = await rig([summaryReply()]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const entries = await r.assistant.auditList();
      assert.equal(entries.length, 1);

      const entry = entries[0];
      assert.ok(entry);
      assert.equal(entry.accountId, 'ivan@example.org');
      assert.equal(entry.messageId, 'inbox:42');
      assert.equal(entry.feature, 'summarize.message');
      assert.equal(entry.model, 'local-model');
      assert.equal(entry.local, true);
      assert.equal(entry.usage.totalTokens, 340);
      assert.equal(entry.cached, false);
      assert.equal(entry.ok, true);
      assert.ok(entry.outboundChars > 0);
      assert.ok(entry.at.endsWith('Z'));
      assert.ok(entry.endpoint.includes('/v1/chat/completions'));
    } finally {
      await r.close();
    }
  });

  it('ответ из кэша помечен и не добавляет токенов в итог', async () => {
    const r = await rig([summaryReply()]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      await r.assistant.summarizeMessage(sampleMessage(), ctx);

      const totals = await r.assistant.auditTotals();
      assert.equal(totals.requests, 2);
      assert.equal(totals.cachedRequests, 1);
      assert.equal(totals.totalTokens, 340);
    } finally {
      await r.close();
    }
  });

  it('неудачный вызов тоже попадает в журнал', async () => {
    const r = await rig([{ status: 500, body: 'сломалось' }]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      const entries = await r.assistant.auditList({ accountId: ctx.accountId });
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.ok, false);
      assert.equal(entries[0]?.errorKind, 'http');
    } finally {
      await r.close();
    }
  });

  it('журнал фильтруется по письму и возможности', async () => {
    const r = await rig([
      summaryReply(),
      { json: completion(JSON.stringify({ category: 'invoice' })) },
    ]);
    try {
      await r.assistant.summarizeMessage(sampleMessage(), ctx);
      await r.assistant.classifyMessage(sampleMessage(), ctx);
      const onlyClassify = await r.assistant.auditList({ feature: 'classify' });
      assert.equal(onlyClassify.length, 1);
      const byMessage = await r.assistant.auditList({ messageId: 'inbox:42' });
      assert.equal(byMessage.length, 2);
    } finally {
      await r.close();
    }
  });
});

describe('устойчивость', () => {
  it('недоступный сервис даёт отказ, а не исключение', async () => {
    const created = MailAssistant.create({
      provider: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'm',
        maxRetries: 0,
      },
      deps: { providerDeps: { sleep: async (): Promise<void> => undefined } },
    });
    assert.ok(created.ok);
    const result = await created.assistant.summarizeMessage(sampleMessage(), ctx);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'network');
  });

  it('таймаут сервиса даёт отказ вида timeout', async () => {
    const r = await rig([{ delayMs: 3000, json: completion('{}') }], {
      provider: { timeoutMs: 120 },
    });
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, 'timeout');
    } finally {
      await r.close();
    }
  });

  it('искажённый ответ модели не роняет вызов и не попадает в кэш', async () => {
    const r = await rig([{ json: completion('Извините, я не понял задание.') }, summaryReply()]);
    try {
      const bad = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.equal(bad.error.kind, 'bad-response');

      // Повторный вызов действительно идёт наружу — неудача не закэширована.
      const good = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(good.ok);
      assert.equal(r.server.requests.length, 2);
    } finally {
      await r.close();
    }
  });

  it('ответ в ограждении ```json разбирается', async () => {
    const r = await rig([
      {
        json: completion('```json\n{"summary":"Всё в порядке","bullets":[]}\n```'),
      },
    ]);
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(result.ok);
      assert.equal(result.value.summary, 'Всё в порядке');
    } finally {
      await r.close();
    }
  });

  it('неполный ответ модели дополняется значениями по умолчанию', async () => {
    const r = await rig([{ json: completion('{"summary":"Только суть"}') }]);
    try {
      const result = await r.assistant.summarizeMessage(sampleMessage(), ctx);
      assert.ok(result.ok);
      assert.deepEqual(result.value.bullets, []);
      assert.equal(result.value.actionRequired, false);
    } finally {
      await r.close();
    }
  });
});

describe('остальные возможности', () => {
  it('резюме цепочки объединяет письма и опись', async () => {
    const r = await rig([summaryReply('Договорились об оплате до 20 марта.')]);
    try {
      const result = await r.assistant.summarizeThread(
        [sampleMessage(), sampleMessage({ id: 'inbox:43', subject: 'Re: Счёт на оплату № 1024' })],
        ctx,
      );
      assert.ok(result.ok);
      assert.equal(result.disclosure?.attachmentsExcluded.length, 2);
      const sent = outboundText(
        r.server.requests[0] ?? { url: '', method: '', headers: {}, raw: '', body: null },
      );
      assert.ok(sent.includes('Письмо 1'));
      assert.ok(sent.includes('Письмо 2'));
    } finally {
      await r.close();
    }
  });

  it('варианты ответа с разным тоном', async () => {
    const r = await rig([
      {
        json: completion(
          JSON.stringify({
            variants: [
              { tone: 'short', body: 'Оплатим до 20 марта.' },
              { tone: 'formal', body: 'Уважаемая Мария, счёт получен, оплата будет произведена.' },
            ],
          }),
        ),
      },
    ]);
    try {
      const result = await r.assistant.suggestReplies(sampleMessage(), ctx, {
        tones: ['short', 'formal'],
      });
      assert.ok(result.ok);
      assert.equal(result.value.variants.length, 2);
      assert.equal(result.value.variants[0]?.tone, 'short');
    } finally {
      await r.close();
    }
  });

  it('продолжение начатой фразы', async () => {
    const r = await rig([{ json: completion('{"continuation":" до 20 марта включительно."}') }]);
    try {
      const result = await r.assistant.continueWriting(
        { draft: 'Добрый день! Мы оплатим счёт', message: sampleMessage() },
        ctx,
      );
      assert.ok(result.ok);
      assert.equal(result.value.continuation, ' до 20 марта включительно.');
      const sent = outboundText(
        r.server.requests[0] ?? { url: '', method: '', headers: {}, raw: '', body: null },
      );
      assert.ok(sent.includes('Мы оплатим счёт'));
    } finally {
      await r.close();
    }
  });

  it('правка текста: сократить', async () => {
    const r = await rig([
      { json: completion('{"text":"Оплатим до 20 марта.","changes":["убраны повторы"]}') },
    ]);
    try {
      const result = await r.assistant.rewriteText(
        'Мы, безусловно, обязательно и непременно оплатим этот счёт до 20 марта.',
        'shorten',
        ctx,
      );
      assert.ok(result.ok);
      assert.equal(result.value.text, 'Оплатим до 20 марта.');
      assert.equal(result.disclosure?.fields.length, 1);
    } finally {
      await r.close();
    }
  });

  it('извлечение полезного даёт структуру, а не текст', async () => {
    const r = await rig([
      {
        json: completion(
          JSON.stringify({
            amounts: [{ amount: '45 600', currency: 'RUB', purpose: 'итого' }],
            tasks: [{ title: 'Оплатить счёт № 1024', dueAt: '2026-03-20' }],
            tracking: [{ number: 'RB123456789RU', carrier: 'Почта России' }],
          }),
        ),
      },
    ]);
    try {
      const result = await r.assistant.extractData(sampleMessage(), ctx);
      assert.ok(result.ok);
      assert.equal(result.value.amounts[0]?.amount, '45 600');
      assert.equal(result.value.tasks[0]?.dueAt, '2026-03-20');
      assert.equal(result.value.tracking[0]?.number, 'RB123456789RU');
      assert.deepEqual(result.value.events, []);
      assert.deepEqual(result.value.requisites, []);
    } finally {
      await r.close();
    }
  });

  it('перевод возвращает текст и язык оригинала', async () => {
    const r = await rig([
      { json: completion('{"text":"Invoice No. 1024","detectedLanguage":"ru"}') },
    ]);
    try {
      const result = await r.assistant.translateMessage(sampleMessage(), 'en', ctx);
      assert.ok(result.ok);
      assert.equal(result.value.detectedLanguage, 'ru');
    } finally {
      await r.close();
    }
  });

  it('поиск обычными словами обязательно возвращает пояснение', async () => {
    const r = await rig([
      {
        json: completion(
          JSON.stringify({
            from: ['бухгалтерия'],
            text: ['оплата'],
            dateFrom: '2026-03-01',
            dateTo: '2026-03-31',
            explanation: 'письма от бухгалтерии со словом «оплата» за март 2026 года',
          }),
        ),
      },
    ]);
    try {
      const result = await r.assistant.parseSearchQuery(
        'письма от бухгалтерии про оплату в марте',
        ctx,
      );
      assert.ok(result.ok);
      assert.equal(
        result.value.explanation,
        'письма от бухгалтерии со словом «оплата» за март 2026 года',
      );
      assert.deepEqual(result.value.from, ['бухгалтерия']);
      assert.equal(result.value.dateFrom, '2026-03-01');
      assert.equal(result.value.hasAttachments, null);
    } finally {
      await r.close();
    }
  });

  it('пустой поисковый запрос наружу не уходит', async () => {
    const r = await rig([summaryReply()]);
    try {
      const result = await r.assistant.parseSearchQuery('   ', ctx);
      assert.equal(result.ok, false);
      assert.equal(r.server.requests.length, 0);
    } finally {
      await r.close();
    }
  });
});

describe('потоковый черновик ответа', () => {
  it('пожелание к ответу входит в опись: наружу не должно уйти больше показанного', async () => {
    /*
     * Опись отправляется человеку ПЕРВЫМ событием потока, а пожелание
     * дописывалось в текст запроса ПОСЛЕ неё — то есть показывалось
     * меньше, чем уходило к сервису ИИ, и в журнале тоже. Обещание
     * модуля «опись не может разойтись с содержимым» этим и нарушалось.
     */
    const r = await rig([{ sse: [sseDelta('Хорошо.'), SSE_DONE] }]);
    try {
      const instruction = 'Ответь коротко и предложи созвон';
      let disclosure: OutboundDisclosure | null = null;

      for await (const event of r.assistant.streamReply(sampleMessage(), ctx, { instruction })) {
        if (event.type === 'disclosure') disclosure = event.disclosure;
      }

      assert.ok(disclosure, 'опись не пришла');
      const field = disclosure.fields.find((f) => f.field === 'instruction');
      assert.ok(field, 'пожелание к ответу не названо в описи, а уходит наружу');
      assert.equal(field.value, instruction);

      // И в журнале объём совпадает с показанным.
      const entries = await r.assistant.auditList();
      assert.equal(entries[0]?.outboundChars, disclosure.totalChars);
    } finally {
      await r.close();
    }
  });

  it('первым идёт опись, затем текст по частям', async () => {
    const r = await rig([
      { sse: [sseDelta('Добрый день! '), sseDelta('Счёт получен.'), SSE_DONE] },
    ]);
    try {
      const kinds: string[] = [];
      let text = '';
      let disclosed = 0;

      for await (const event of r.assistant.streamReply(sampleMessage(), ctx)) {
        kinds.push(event.type);
        if (event.type === 'disclosure') disclosed = event.disclosure.totalChars;
        if (event.type === 'done') text = event.text;
      }

      assert.equal(kinds[0], 'disclosure');
      assert.ok(disclosed > 0);
      assert.equal(text, 'Добрый день! Счёт получен.');
      assert.ok(kinds.includes('delta'));

      const entries = await r.assistant.auditList();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.ok, true);
    } finally {
      await r.close();
    }
  });

  it('выключенный помощник отдаёт событие error', async () => {
    const events: string[] = [];
    for await (const event of disabledAssistant().streamReply(sampleMessage(), ctx)) {
      events.push(event.type);
    }
    assert.deepEqual(events, ['error']);
  });

  it('исчерпанный предел останавливает поток до отправки', async () => {
    const r = await rig([{ sse: [sseDelta('не должно уйти'), SSE_DONE] }], {
      limits: { maxTokensPerRequest: 5 },
    });
    try {
      const events: string[] = [];
      for await (const event of r.assistant.streamReply(sampleMessage(), ctx)) {
        events.push(event.type);
      }
      assert.deepEqual(events, ['disclosure', 'error']);
      assert.equal(r.server.requests.length, 0);
    } finally {
      await r.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Периметр: обещание, которое читает пользователь почты                */
/* ------------------------------------------------------------------ */

describe('модель внутри периметра', () => {
  /**
   * Признак «письма не покидают сервер» показывается человеку на экране
   * согласия и ложится в опись отправленного и в журнал обращений.
   * Пока он приходил булевым полем настроек, его можно было выставить
   * при любом адресе — и почта обещала людям то, чего нет.
   */
  it('выводится из адреса, а не из присланного флага', () => {
    const outside = MailAssistant.create({
      provider: {
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        // Ровно то, что раньше присылал запрос мимо формы админки.
        local: true,
      } as unknown as Parameters<typeof MailAssistant.create>[0]['provider'],
    });
    assert.ok(outside.ok);
    assert.equal(
      outside.assistant.local,
      false,
      'внешний сервис не может назваться внутренним, что бы ни прислали',
    );
    assert.equal(outside.assistant.previewOutbound(sampleMessage()).local, false);

    const inside = MailAssistant.create({
      provider: { enabled: true, baseUrl: 'http://ollama:11434/v1', model: 'qwen2.5:7b' },
    });
    assert.ok(inside.ok);
    assert.equal(inside.assistant.local, true, 'сосед по сети контейнеров — внутри периметра');
  });
});

/* ------------------------------------------------------------------ */
/* «Забыть результаты по этому письму» и сводка переписки               */
/* ------------------------------------------------------------------ */

describe('забыть насчитанное по письму', () => {
  /**
   * Сводка переписки лежала в кэше под идентификатором ЦЕПОЧКИ
   * (`t-<base64url(Message-ID)>`), а удаление искало по идентификатору
   * ПИСЬМА (`папка:uid`) — шаблоны не совпадали никогда. Человек жал
   * «Забыть», видел «Удалено записей: N», жал «Кратко» — и получал ту же
   * старую сводку из кэша, которая живёт 30 суток.
   */
  it('удаление по письму убирает и сводку всей переписки', async () => {
    const r = await rig([summaryReply('Первая сводка.'), summaryReply('Пересчитано.')]);
    try {
      const thread = [
        sampleMessage({ id: 'inbox:42', threadId: 't-cm9vdEBtYWls' }),
        sampleMessage({ id: 'inbox:43', threadId: 't-cm9vdEBtYWls' }),
      ];

      const first = await r.assistant.summarizeThread(thread, ctx);
      assert.ok(first.ok);
      assert.equal(first.cached, false);
      assert.equal(r.server.requests.length, 1);

      // Пока не забыли — берётся из кэша, наружу ничего не идёт.
      const cached = await r.assistant.summarizeThread(thread, ctx);
      assert.ok(cached.ok);
      assert.equal(cached.cached, true);
      assert.equal(r.server.requests.length, 1);

      // Забываем по ОДНОМУ письму цепочки — именно так делает интерфейс.
      const removed = await r.assistant.forgetMessage('inbox:42');
      assert.ok(removed > 0, 'сводка переписки должна попасть под удаление');

      const afresh = await r.assistant.summarizeThread(thread, ctx);
      assert.ok(afresh.ok);
      assert.equal(afresh.cached, false, 'забытая сводка не должна воскреснуть из кэша');
      assert.equal(afresh.value.summary, 'Пересчитано.');
      assert.equal(r.server.requests.length, 2);
    } finally {
      await r.close();
    }
  });

  it('удаление по любому письму цепочки, не только по первому', async () => {
    const r = await rig([summaryReply('Сводка.'), summaryReply('Ещё раз.')]);
    try {
      const thread = [sampleMessage({ id: 'inbox:42' }), sampleMessage({ id: 'inbox:43' })];
      assert.ok((await r.assistant.summarizeThread(thread, ctx)).ok);
      assert.ok((await r.assistant.forgetMessage('inbox:43')) > 0);
      const again = await r.assistant.summarizeThread(thread, ctx);
      assert.ok(again.ok);
      assert.equal(again.cached, false);
    } finally {
      await r.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Обрыв потока и учёт расхода                                          */
/* ------------------------------------------------------------------ */

/** Поставщик, отдающий заранее заданные события потока. */
class ScriptedProvider implements ChatProvider {
  readonly endpoint = 'http://127.0.0.1:11434/v1/chat/completions';
  readonly model = 'local-model';
  readonly #events: StreamEvent[];

  constructor(events: StreamEvent[]) {
    this.#events = events;
  }

  chat(): Promise<AiOutcome<ChatResult>> {
    return Promise.resolve(aiFail('network', 'в этом тесте не используется'));
  }

  async *stream(): AsyncGenerator<StreamEvent, void, void> {
    for (const event of this.#events) {
      await Promise.resolve();
      yield event;
    }
  }
}

function streamingAssistant(events: StreamEvent[]): {
  assistant: MailAssistant;
  audit: InMemoryAuditLog;
} {
  const audit = new InMemoryAuditLog();
  const created = MailAssistant.create({
    provider: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      maxOutputTokens: 512,
    },
    deps: { audit, cache: new MemoryAiCache(), provider: new ScriptedProvider(events) },
  });
  assert.ok(created.ok);
  return { assistant: created.assistant, audit };
}

describe('обрыв потокового черновика', () => {
  /**
   * Расход записывался ТОЛЬКО по событию `done`. При обрыве (человек
   * закрыл вкладку, маршрут дёрнул abort) поставщик отдаёт `error`,
   * `done` не наступает — и не росли ни токены, ни счётчик обращений,
   * хотя модель текст уже сгенерировала и поставщик его тарифицировал.
   * Повторяя обрыв, можно было тратить бюджет домена без следа в учёте.
   */
  it('прерванный поток всё равно попадает в предел расходов', async () => {
    const { assistant, audit } = streamingAssistant([
      { type: 'delta', text: 'Добрый день! Счёт получен, ' },
      { type: 'delta', text: 'оплатим до пятницы.' },
      { type: 'error', error: aiFail('aborted', 'Запрос отменён', { retryable: false }).error },
    ]);

    for await (const event of assistant.streamReply(sampleMessage(), ctx)) {
      void event;
    }

    const snapshot = await assistant.budgetSnapshot(ctx.accountId);
    assert.equal(snapshot.requestsUsed, 1, 'обращение обязано попасть в счётчик');
    assert.ok(snapshot.tokensUsed > 0, 'сгенерированный текст оплачен — он обязан быть в учёте');

    const entries = await audit.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, false);
    assert.ok(
      (entries[0]?.usage.totalTokens ?? 0) > 0,
      'в журнале обращений расход прерванного вызова не должен быть нулевым',
    );
  });

  it('брошенный на середине поток учитывается так же', async () => {
    // Ровно то, что делает маршрут, когда соединение с браузером
    // оборвалось: перебор прекращается, событий `done` и `error` нет.
    const { assistant, audit } = streamingAssistant([
      { type: 'delta', text: 'Добрый день!' },
      { type: 'delta', text: ' Отвечаю по пунктам…' },
      { type: 'done', text: 'не дойдёт', usage: ZERO_USAGE, finishReason: 'stop' },
    ]);

    for await (const event of assistant.streamReply(sampleMessage(), ctx)) {
      if (event.type === 'delta') break;
    }

    const snapshot = await assistant.budgetSnapshot(ctx.accountId);
    assert.equal(snapshot.requestsUsed, 1);
    assert.ok(snapshot.tokensUsed > 0);
    assert.equal((await audit.list()).length, 1, 'запись в журнале должна быть ровно одна');
  });

  it('отказ до первой буквы предел не расходует', async () => {
    // Модель ничего не сделала: занимать чужой предел таким отказом
    // нечестно — резерв возвращается целиком.
    const { assistant } = streamingAssistant([
      { type: 'error', error: aiFail('network', 'Не удалось связаться с сервисом ИИ').error },
    ]);

    for await (const event of assistant.streamReply(sampleMessage(), ctx)) {
      void event;
    }

    const snapshot = await assistant.budgetSnapshot(ctx.accountId);
    assert.equal(snapshot.requestsUsed, 0);
    assert.equal(snapshot.tokensUsed, 0);
  });
});
