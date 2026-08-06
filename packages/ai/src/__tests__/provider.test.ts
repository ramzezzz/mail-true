/**
 * Тесты слоя поставщика на настоящем HTTP-сервере:
 * повторы, таймаут, сетевая ошибка, разбор искажённых ответов, поток.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { providerConfigSchema } from '../config.js';
import { CompatibleChatProvider, parseChatCompletion, parseSseBlock } from '../provider.js';
import {
  SSE_DONE,
  completion,
  sseDelta,
  sseUsage,
  startFakeAiServer,
  type FakeReply,
} from './helpers.js';

const noSleep = async (): Promise<void> => {
  await Promise.resolve();
};

function makeProvider(
  baseUrl: string,
  overrides?: Record<string, unknown>,
): CompatibleChatProvider {
  const config = providerConfigSchema.parse({
    enabled: true,
    baseUrl,
    model: 'test-model-7b',
    apiKey: 'test-secret-key-123',
    timeoutMs: 2000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  });
  return new CompatibleChatProvider(config, { sleep: noSleep });
}

const ask = { messages: [{ role: 'user' as const, content: 'Привет' }] };

async function withServer(
  plan: FakeReply[],
  body: (server: Awaited<ReturnType<typeof startFakeAiServer>>) => Promise<void>,
): Promise<void> {
  const server = await startFakeAiServer(plan);
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

describe('обычный вызов', () => {
  it('успешный ответ: текст и точный расход токенов', async () => {
    await withServer(
      [
        {
          json: completion('Ответ модели', {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          }),
        },
      ],
      async (server) => {
        const result = await makeProvider(server.baseUrl).chat(ask);
        assert.ok(result.ok);
        assert.equal(result.value.text, 'Ответ модели');
        assert.equal(result.value.usage.totalTokens, 150);
        assert.equal(result.value.usage.estimated, false);
        assert.equal(result.value.attempts, 1);
      },
    );
  });

  it('адрес, ключ и название модели берутся из настроек', async () => {
    await withServer([{ json: completion('ок') }], async (server) => {
      await makeProvider(server.baseUrl).chat(ask);
      const request = server.requests[0];
      assert.ok(request);
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers['authorization'], 'Bearer test-secret-key-123');
      assert.equal(request.body?.['model'], 'test-model-7b');
    });
  });

  it('без счётчиков сервиса расход оценивается', async () => {
    await withServer([{ json: completion('короткий ответ') }], async (server) => {
      const result = await makeProvider(server.baseUrl).chat(ask);
      assert.ok(result.ok);
      assert.equal(result.value.usage.estimated, true);
      assert.ok(result.value.usage.totalTokens > 0);
    });
  });
});

describe('повторные попытки', () => {
  it('после 503 запрос повторяется и удаётся', async () => {
    await withServer(
      [{ status: 503, body: 'service unavailable' }, { json: completion('со второй попытки') }],
      async (server) => {
        const result = await makeProvider(server.baseUrl).chat(ask);
        assert.ok(result.ok);
        assert.equal(result.value.attempts, 2);
        assert.equal(server.requests.length, 2);
      },
    );
  });

  it('после исчерпания попыток возвращается отказ, а не исключение', async () => {
    await withServer([{ status: 500, body: 'oops' }], async (server) => {
      const result = await makeProvider(server.baseUrl).chat(ask);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.kind, 'http');
        assert.equal(result.error.retryable, true);
      }
      assert.equal(server.requests.length, 3); // 1 + 2 повтора
    });
  });

  it('код 400 не повторяется', async () => {
    await withServer(
      [{ status: 400, body: '{"error":{"message":"bad model"}}' }],
      async (server) => {
        const result = await makeProvider(server.baseUrl).chat(ask);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.retryable, false);
        assert.equal(server.requests.length, 1);
      },
    );
  });

  it('код 429 распознаётся как ограничение частоты', async () => {
    await withServer([{ status: 429, body: 'too many' }], async (server) => {
      const result = await makeProvider(server.baseUrl, { maxRetries: 0 }).chat(ask);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.kind, 'rate-limited');
        assert.equal(result.error.status, 429);
      }
    });
  });

  it('код 401 сообщает о неверном ключе и не повторяется', async () => {
    await withServer([{ status: 401, body: 'unauthorized' }], async (server) => {
      const result = await makeProvider(server.baseUrl).chat(ask);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, 'not-configured');
      assert.equal(server.requests.length, 1);
    });
  });
});

describe('таймаут и сеть', () => {
  it('медленный сервис даёт отказ вида timeout', async () => {
    await withServer([{ delayMs: 3000, json: completion('поздно') }], async (server) => {
      const result = await makeProvider(server.baseUrl, {
        timeoutMs: 120,
        maxRetries: 0,
      }).chat(ask);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.kind, 'timeout');
        assert.equal(result.error.retryable, true);
      }
    });
  });

  it('недоступный адрес даёт отказ вида network', async () => {
    // Порт 1 на локальном интерфейсе заведомо не слушает.
    const result = await makeProvider('http://127.0.0.1:1/v1', { maxRetries: 0 }).chat(ask);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, 'network');
      assert.equal(result.error.retryable, true);
    }
  });

  it('отмена снаружи даёт отказ вида aborted', async () => {
    await withServer([{ delayMs: 2000, json: completion('поздно') }], async (server) => {
      const controller = new AbortController();
      const promise = makeProvider(server.baseUrl, { maxRetries: 0 }).chat(ask, controller.signal);
      controller.abort();
      const result = await promise;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, 'aborted');
    });
  });
});

describe('разбор ответа сервиса', () => {
  it('не JSON', () => {
    const result = parseChatCompletion('<html>502 Bad Gateway</html>', 'prompt');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'bad-response');
  });

  it('пустой список вариантов', () => {
    const result = parseChatCompletion('{"choices":[]}', 'prompt');
    assert.equal(result.ok, false);
  });

  it('повреждённый вариант', () => {
    const result = parseChatCompletion('{"choices":[null]}', 'prompt');
    assert.equal(result.ok, false);
  });

  it('ошибка в теле при коде 200', () => {
    const result = parseChatCompletion('{"error":{"message":"нет такой модели"}}', 'prompt');
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.message.includes('нет такой модели'));
  });

  it('содержимое массивом частей', () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: [{ text: 'часть 1 ' }, { text: 'часть 2' }] } }],
    });
    const result = parseChatCompletion(raw, 'prompt');
    assert.ok(result.ok);
    assert.equal(result.value.text, 'часть 1 часть 2');
  });

  it('пустой ответ модели', () => {
    const result = parseChatCompletion(JSON.stringify(completion('   ')), 'prompt');
    assert.equal(result.ok, false);
  });

  it('искажённый ответ сервиса не роняет вызов', async () => {
    await withServer([{ body: 'не json вовсе' }], async (server) => {
      const result = await makeProvider(server.baseUrl).chat(ask);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, 'bad-response');
    });
  });
});

describe('потоковая выдача', () => {
  it('текст приходит по частям, в конце — расход токенов', async () => {
    await withServer(
      [
        {
          sse: [
            sseDelta('Добрый '),
            sseDelta('день! '),
            sseDelta('Счёт получен.'),
            sseUsage({ prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 }),
            SSE_DONE,
          ],
        },
      ],
      async (server) => {
        const deltas: string[] = [];
        let final = '';
        let total = 0;

        for await (const event of makeProvider(server.baseUrl).stream(ask)) {
          if (event.type === 'delta') deltas.push(event.text);
          if (event.type === 'done') {
            final = event.text;
            total = event.usage.totalTokens;
          }
          assert.notEqual(event.type, 'error');
        }

        assert.deepEqual(deltas, ['Добрый ', 'день! ', 'Счёт получен.']);
        assert.equal(final, 'Добрый день! Счёт получен.');
        assert.equal(total, 102);
        assert.equal(server.requests[0]?.body?.['stream'], true);
      },
    );
  });

  it('битый блок в потоке пропускается, поток не падает', async () => {
    await withServer(
      [{ sse: [sseDelta('часть'), 'data: {это не json}', sseDelta(' вторая'), SSE_DONE] }],
      async (server) => {
        let final = '';
        for await (const event of makeProvider(server.baseUrl).stream(ask)) {
          if (event.type === 'done') final = event.text;
        }
        assert.equal(final, 'часть вторая');
      },
    );
  });

  it('ошибка сервиса в потоке приходит событием, а не исключением', async () => {
    await withServer([{ status: 500, body: 'сломалось' }], async (server) => {
      const events: string[] = [];
      for await (const event of makeProvider(server.baseUrl).stream(ask)) {
        events.push(event.type);
      }
      assert.deepEqual(events, ['error']);
    });
  });

  it('недоступный сервис в потоке даёт событие error', async () => {
    const events: string[] = [];
    for await (const event of makeProvider('http://127.0.0.1:1/v1').stream(ask)) {
      events.push(event.type);
    }
    assert.deepEqual(events, ['error']);
  });
});

describe('parseSseBlock', () => {
  it('распознаёт маркер завершения', () => {
    assert.equal(parseSseBlock('data: [DONE]'), 'done');
  });

  it('игнорирует комментарии и пустые блоки', () => {
    assert.equal(parseSseBlock(': heartbeat'), null);
    assert.equal(parseSseBlock(''), null);
  });

  it('читает finish_reason', () => {
    const block = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}`;
    const parsed = parseSseBlock(block);
    assert.notEqual(parsed, null);
    assert.notEqual(parsed, 'done');
    if (parsed !== null && parsed !== 'done') assert.equal(parsed.finishReason, 'length');
  });
});
