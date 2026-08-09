/**
 * Живая проверка на настоящем совместимом сервисе.
 *
 * Юнит-тесты работают на поддельном сервере: они проверяют наш код,
 * но не проверяют, договоримся ли мы с реальной моделью. Этот сценарий
 * делает один настоящий вызов.
 *
 * Настройки берутся из переменных окружения:
 *   AI_BASE_URL   — адрес совместимого API (например, http://127.0.0.1:11434/v1
 *                   для локальной модели рядом)
 *   AI_MODEL      — название модели
 *   AI_API_KEY    — ключ доступа (для локальной модели не нужен)
 *   AI_FEATURE    — что проверять: summarize (по умолчанию) | classify | search
 *
 * Запуск: npm run livetest --workspace @mail-true/ai
 */

import { MailAssistant } from './assistant.js';
import type { AiSourceMessage } from './types.js';

const LETTER: AiSourceMessage = {
  id: 'livetest:1',
  threadId: 'livetest',
  subject: 'Счёт на оплату № 1024',
  date: new Date().toISOString(),
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
  ].join('\n'),
  bodyHtml: null,
  attachments: [{ filename: 'schet-1024.pdf', mimeType: 'application/pdf', size: 84_213 }],
  headers: { 'DKIM-Signature': 'v=1; a=rsa-sha256; d=romashka.ru;' },
};

async function main(): Promise<number> {
  const baseUrl = process.env['AI_BASE_URL'];
  const model = process.env['AI_MODEL'];
  if (!baseUrl || !model) {
    console.error('Не заданы AI_BASE_URL и/или AI_MODEL — живая проверка пропущена.');
    return 2;
  }

  const apiKey = process.env['AI_API_KEY'];
  const created = MailAssistant.create({
    provider: {
      enabled: true,
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
      providerLabel: 'Живая проверка',
      // Признак «внутри периметра» здесь не задаётся: он выводится
      // из адреса самим пакетом (см. perimeter.ts).
      timeoutMs: 600_000,
      maxRetries: 1,
      // Модели с «размышлением» тратят часть предела на рассуждение.
      maxOutputTokens: Number.parseInt(process.env['AI_MAX_TOKENS'] ?? '2048', 10) || 2048,
    },
  });

  if (!created.ok) {
    console.error(`Настройки неверны: ${created.message}`);
    for (const issue of created.issues) console.error(`  - ${issue}`);
    return 1;
  }

  const assistant = created.assistant;
  const feature = process.env['AI_FEATURE'] ?? 'summarize';
  const ctx = { accountId: 'livetest@example.org' };

  console.log(`Адрес:  ${assistant.endpoint}`);
  console.log(`Модель: ${assistant.model}`);

  const disclosure = assistant.previewOutbound(LETTER);
  console.log('\nЧто уйдёт наружу:');
  for (const field of disclosure.fields) {
    console.log(`  ${field.label} (${String(field.chars)} симв.): ${field.value.slice(0, 90)}`);
  }
  console.log('Что вырезано:');
  for (const removed of disclosure.removed) {
    console.log(`  ${removed.kind}: ${removed.note} (${String(removed.count)})`);
  }
  console.log(`Вложения не отправляются: ${disclosure.attachmentsExcluded.join(', ') || 'нет'}`);

  const started = Date.now();
  const result =
    feature === 'classify'
      ? await assistant.classifyMessage(LETTER, ctx)
      : feature === 'search'
        ? await assistant.parseSearchQuery('письма от бухгалтерии про оплату в марте', ctx)
        : await assistant.summarizeMessage(LETTER, ctx);

  console.log(`\nВозможность: ${feature}, ${String(Date.now() - started)} мс`);

  if (!result.ok) {
    console.error(`ОТКАЗ (${result.error.kind}): ${result.error.message}`);
    if (result.error.details) console.error(`  подробности: ${result.error.details}`);
    return 1;
  }

  console.log('Результат:');
  console.log(JSON.stringify(result.value, null, 2));
  console.log(
    `Расход: ${String(result.usage.totalTokens)} токенов` +
      `${result.usage.estimated ? ' (оценка)' : ''}`,
  );

  const totals = await assistant.auditTotals();
  console.log(
    `Журнал: обращений ${String(totals.requests)}, символов наружу ${String(totals.outboundChars)}`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('Непредвиденная ошибка живой проверки:', error);
    process.exitCode = 1;
  });
