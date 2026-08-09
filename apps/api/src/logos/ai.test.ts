/**
 * Подсказка логотипа у помощника ИИ — самый тихий путь наружу.
 *
 * Она спрашивает про КАЖДЫЙ незнакомый домен в списке писем, то есть при
 * внешнем сервисе постепенно раскрывает ему круг корреспондентов. Раньше
 * этот модуль собирал провайдера сам и звал его напрямую, минуя службу, —
 * и обходил разом всё, что стоит на пути обычного обращения: согласие
 * пользователя (запросы шли и до него, и ПОСЛЕ ОТЗЫВА), список
 * возможностей, разрешённых администратором домена, предел расходов и
 * журнал обращений.
 *
 * Здесь закреплено главное свойство: наружу не уходит ничего, пока служба
 * не разрешила, — и уходит ровно доменное имя, без письма.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import { AiLogoHints } from './ai.js';
import type { AiService } from '../ai/service.js';

const logger = {
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as unknown as Logger;

test('без разрешения службы наружу не уходит ни одного запроса', async () => {
  let asked = 0;
  const ai = {
    forFeature: () => {
      asked += 1;
      // Так отвечает служба, когда согласия нет, оно отозвано, возможность
      // выключена администратором или помощник не настроен вовсе.
      return Promise.reject(new Error('Требуется согласие'));
    },
  } as unknown as AiService;

  const hints = new AiLogoHints({ ai, email: 'ivan@example.com', logger });
  assert.equal(await hints.hint('partner.example'), null);
  assert.equal(asked, 1, 'разрешение обязано спрашиваться у службы');
});

test('спрашивается возможность «логотипы», а не какая-нибудь другая', async () => {
  /*
   * Возможность своя, потому что цена у неё своя: это единственный путь,
   * который ходит наружу САМ, без нажатия человека. Провести её под чужим
   * именем (например, «поиск») значило бы включать её вместе с тем, к чему
   * человек согласия не давал.
   */
  const features: string[] = [];
  const ai = {
    forFeature: (_email: string, feature: string) => {
      features.push(feature);
      return Promise.reject(new Error('выключено'));
    },
  } as unknown as AiService;

  await new AiLogoHints({ ai, email: 'ivan@example.com', logger }).hint('partner.example');
  assert.deepEqual(features, ['logos']);
});

test('наружу уходит домен, а сам ответ проверяется на чужой адрес', async () => {
  const sent: string[] = [];
  const ai = {
    forFeature: () =>
      Promise.resolve({
        assistant: {
          logoHint: (domain: string) => {
            sent.push(domain);
            // Модель назвала ЧУЖОЙ домен — так и бывает: она порождает
            // правдоподобный текст, а не знает логотипы.
            return Promise.resolve({ ok: true, value: { url: 'https://sberbank.ru/logo.png' } });
          },
        },
        domain: {},
      }),
  } as unknown as AiService;

  const hints = new AiLogoHints({ ai, email: 'ivan@example.com', logger });
  assert.equal(
    await hints.hint('sberbank-security.xyz'),
    null,
    'ответ с чужим доменом обязан отбрасываться: иначе рядом с письмом мошенника встанет чужой логотип',
  );
  assert.deepEqual(sent, ['sberbank-security.xyz'], 'наружу уходит только домен');
});

test('адрес внутри того же домена принимается', async () => {
  const ai = {
    forFeature: () =>
      Promise.resolve({
        assistant: {
          logoHint: () =>
            Promise.resolve({ ok: true, value: { url: 'https://cdn.example.com/logo.svg' } }),
        },
        domain: {},
      }),
  } as unknown as AiService;

  assert.equal(
    await new AiLogoHints({ ai, email: 'ivan@example.com', logger }).hint('example.com'),
    'https://cdn.example.com/logo.svg',
  );
});

test('честное «не знаю» — это null, а не выдуманный адрес', async () => {
  const ai = {
    forFeature: () =>
      Promise.resolve({
        assistant: { logoHint: () => Promise.resolve({ ok: true, value: { url: null } }) },
        domain: {},
      }),
  } as unknown as AiService;

  assert.equal(
    await new AiLogoHints({ ai, email: 'ivan@example.com', logger }).hint('example.com'),
    null,
  );
});
