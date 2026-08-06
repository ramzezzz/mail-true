/**
 * Поддельный сервер ИИ для тестов.
 *
 * Живого сервиса у нас нет, поэтому проверяем весь путь целиком —
 * от подготовки данных до разбора ответа — на настоящем HTTP-сервере
 * с заранее заданными ответами.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReply {
  status?: number;
  /** Тело ответа как объект — будет сериализовано в JSON. */
  json?: unknown;
  /** Тело ответа как строка (для проверки искажённых ответов). */
  body?: string;
  headers?: Record<string, string>;
  /** Задержка перед ответом — для проверки таймаута. */
  delayMs?: number;
  /** Блоки потока SSE (без завершающего пустого перевода строки). */
  sse?: string[];
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: Record<string, unknown> | null;
}

export interface FakeServer {
  /** Адрес для baseUrl в настройках. */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Сообщение из тела запроса к сервису. */
export function requestMessages(request: RecordedRequest): { role: string; content: string }[] {
  const messages = request.body?.['messages'];
  if (!Array.isArray(messages)) return [];
  // Только строки: проверки смотрят, ЧТО ушло наружу, и «[object Object]»
  // вместо содержимого письма спрятало бы настоящую утечку.
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return messages.map((m) => {
    const item = m as Record<string, unknown>;
    return { role: text(item['role']), content: text(item['content']) };
  });
}

/** Весь текст, ушедший наружу в этом запросе. */
export function outboundText(request: RecordedRequest): string {
  return requestMessages(request)
    .map((m) => m.content)
    .join('\n');
}

/** Ответ сервиса в обычном (не потоковом) виде. */
export function completion(content: string, usage?: Record<string, number>): unknown {
  return {
    id: 'test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

/** Блок потока SSE с одной порцией текста. */
export function sseDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}`;
}

export function sseUsage(usage: Record<string, number>): string {
  return `data: ${JSON.stringify({ choices: [], usage })}`;
}

export const SSE_DONE = 'data: [DONE]';

/**
 * Поднимает сервер, отвечающий по плану. Когда план исчерпан,
 * повторяется последний ответ.
 */
export async function startFakeAiServer(plan: FakeReply[]): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        body = null;
      }
      requests.push({
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        raw,
        body,
      });

      const reply = plan[Math.min(index, plan.length - 1)] ?? { status: 200, json: {} };
      index += 1;

      const send = (): void => {
        if (reply.sse) {
          res.writeHead(reply.status ?? 200, {
            'content-type': 'text/event-stream',
            ...reply.headers,
          });
          for (const block of reply.sse) res.write(`${block}\n\n`);
          res.end();
          return;
        }
        const payload = reply.body ?? JSON.stringify(reply.json ?? {});
        res.writeHead(reply.status ?? 200, {
          'content-type': 'application/json',
          ...reply.headers,
        });
        res.end(payload);
      };

      if (reply.delayMs && reply.delayMs > 0) {
        const timer = setTimeout(send, reply.delayMs);
        timer.unref();
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Письмо для тестов: с подписью, цитатой и вложением. */
export function sampleMessage(overrides?: Record<string, unknown>): {
  id: string;
  threadId: string;
  subject: string;
  date: string;
  from: { name: string | null; address: string };
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: { filename: string; mimeType: string; size: number }[];
  headers: Record<string, string>;
} {
  const base = {
    id: 'inbox:42',
    threadId: 'thread-1',
    subject: 'Счёт на оплату № 1024',
    date: '2026-03-12T09:15:00.000Z',
    from: { name: 'Бухгалтерия ООО Ромашка', address: 'buh@romashka.ru' },
    to: [{ name: 'Иван Петров', address: 'ivan@example.org' }],
    cc: [],
    bodyText: [
      'Добрый день!',
      '',
      'Направляем счёт № 1024 от 12.03.2026 на сумму 45 600 руб.',
      'Просим оплатить до 20 марта.',
      '',
      '--',
      'С уважением, Мария Сидорова',
      'Главный бухгалтер, тел. +7 495 123-45-67',
      '',
      '12 марта 2026 г., 08:00, Иван Петров <ivan@example.org> написал(а):',
      '> Здравствуйте, пришлите, пожалуйста, счёт за март.',
      '> Спасибо.',
    ].join('\n'),
    bodyHtml: null,
    attachments: [{ filename: 'schet-1024.pdf', mimeType: 'application/pdf', size: 84_213 }],
    headers: {
      'Received': 'from mx.romashka.ru by mail.true',
      'DKIM-Signature': 'v=1; a=rsa-sha256; d=romashka.ru;',
      'X-Spam-Score': '0.1',
    },
  };
  return { ...base, ...overrides } as ReturnType<typeof sampleMessage>;
}
