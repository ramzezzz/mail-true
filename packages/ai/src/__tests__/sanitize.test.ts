/**
 * Тесты подготовки данных перед отправкой наружу.
 * Это главная проверка приватности: что вырезано, что уходит и совпадает
 * ли опись с содержимым.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_BODY_CHARS,
  describeBodyOnly,
  describeOutbound,
  prepareMessage,
  renderPrepared,
  stripQuotedText,
  stripSignatureBlock,
  truncateBody,
} from '../sanitize.js';
import { htmlToText } from '../text.js';
import { sampleMessage } from './helpers.js';

const context = {
  endpoint: 'http://127.0.0.1:9/v1/chat/completions',
  model: 'test-model',
  providerLabel: 'Тестовый сервис',
  local: true,
};

describe('вырезание подписи', () => {
  it('режет по стандартному разделителю «-- »', () => {
    const input = ['Текст письма.', '', '-- ', 'Иван Иванов', 'ООО Ромашка'].join('\n');
    const result = stripSignatureBlock(input);
    assert.equal(result.text, 'Текст письма.');
    assert.ok(result.removedChars > 0);
  });

  it('режет по обороту «С уважением»', () => {
    const input = [
      'Просьба согласовать смету.',
      '',
      'С уважением,',
      'Мария',
      'тел. +7 495 000',
    ].join('\n');
    const result = stripSignatureBlock(input);
    assert.equal(result.text, 'Просьба согласовать смету.');
    assert.ok(!result.text.includes('Мария'));
    assert.ok(!result.text.includes('+7 495 000'));
  });

  it('режет приписку почтовой программы', () => {
    const input = 'Буду в 15:00.\n\nОтправлено с iPhone';
    assert.equal(stripSignatureBlock(input).text, 'Буду в 15:00.');
  });

  it('не режет «спасибо» в середине длинного письма', () => {
    const lines = ['Спасибо', 'за ответ.'];
    for (let i = 0; i < 20; i += 1) lines.push(`Содержательная строка ${String(i)}.`);
    const result = stripSignatureBlock(lines.join('\n'));
    assert.ok(result.text.includes('Спасибо'));
    assert.equal(result.removedChars, 0);
  });
});

describe('вырезание цитат', () => {
  it('убирает строки, начинающиеся с «>»', () => {
    const input = 'Согласен.\n\n> Предыдущее письмо\n> вторая строка';
    const result = stripQuotedText(input);
    assert.equal(result.text, 'Согласен.');
    assert.ok(!result.text.includes('Предыдущее письмо'));
  });

  it('обрезает всё после строки «… написал(а):»', () => {
    const input = [
      'Готово, посмотрите.',
      '',
      '12 марта 2026 г., 08:00, Иван Петров <ivan@example.org> написал(а):',
      'Здравствуйте, пришлите счёт.',
      'Спасибо.',
    ].join('\n');
    const result = stripQuotedText(input);
    assert.equal(result.text, 'Готово, посмотрите.');
    assert.ok(!result.text.includes('пришлите счёт'));
  });

  it('обрезает вставленную шапку письма в стиле Outlook', () => {
    const input = [
      'Пересылаю.',
      '',
      'От: Анна <anna@example.org>',
      'Отправлено: 1 марта 2026 г. 10:00',
      'Кому: Иван <ivan@example.org>',
      'Тема: Договор',
      '',
      'Текст пересланного письма.',
    ].join('\n');
    const result = stripQuotedText(input);
    assert.equal(result.text, 'Пересылаю.');
    assert.ok(!result.text.includes('anna@example.org'));
  });

  it('обрезает по разделителю «-----Original Message-----»', () => {
    const input = 'Ответ.\n\n-----Original Message-----\nСтарый текст.';
    assert.equal(stripQuotedText(input).text, 'Ответ.');
  });

  it('убирает <blockquote> из HTML', () => {
    const html =
      '<div>Новый ответ.</div><blockquote><p>Старое письмо с адресом old@example.org</p></blockquote>';
    const result = stripQuotedText(htmlToText(html));
    assert.equal(result.text, 'Новый ответ.');
    assert.ok(!result.text.includes('old@example.org'));
  });

  it('не считает цитатой обычное предложение со словом «написал»', () => {
    const input = 'Он написал отчёт вчера.';
    assert.equal(stripQuotedText(input).text, input);
  });
});

describe('prepareMessage', () => {
  it('вырезает подпись и цитату из настоящего письма', () => {
    const prepared = prepareMessage(sampleMessage());
    assert.ok(prepared.body.includes('счёт № 1024'));
    assert.ok(prepared.body.includes('Просим оплатить до 20 марта.'));
    assert.ok(!prepared.body.includes('Мария Сидорова'));
    assert.ok(!prepared.body.includes('+7 495 123-45-67'));
    assert.ok(!prepared.body.includes('пришлите, пожалуйста, счёт'));
  });

  it('вложения не попадают в отправляемое, но перечислены в исключённом', () => {
    const prepared = prepareMessage(sampleMessage());
    const outbound = renderPrepared(prepared);
    assert.ok(!outbound.includes('schet-1024.pdf'));
    assert.deepEqual(prepared.attachmentsExcluded, ['schet-1024.pdf']);
    const note = prepared.removed.find((r) => r.kind === 'attachment');
    assert.ok(note);
    assert.equal(note.count, 1);
  });

  it('служебные заголовки не отправляются', () => {
    const prepared = prepareMessage(sampleMessage());
    const outbound = renderPrepared(prepared);
    assert.ok(!outbound.includes('DKIM-Signature'));
    assert.ok(!outbound.includes('X-Spam-Score'));
    assert.ok(!outbound.includes('mx.romashka.ru'));
    assert.ok(prepared.removed.some((r) => r.kind === 'headers'));
  });

  it('опись в точности соответствует отправляемому тексту', () => {
    const prepared = prepareMessage(sampleMessage());
    const outbound = renderPrepared(prepared);
    const disclosure = describeOutbound(prepared, context);

    // Каждое значение из описи действительно есть в отправляемом тексте.
    for (const field of disclosure.fields) {
      assert.ok(
        outbound.includes(field.value),
        `значение поля ${field.field} отсутствует в отправляемом тексте`,
      );
      assert.equal(field.chars, field.value.length);
    }

    // И наоборот: в отправляемом нет ничего, кроме описанного.
    let rest = outbound;
    for (const field of disclosure.fields) {
      rest = rest.replace(`${field.label}: ${field.value}`, '');
    }
    assert.equal(rest.trim(), '', 'в запрос попало то, чего нет в описи');
    assert.equal(
      disclosure.totalChars,
      disclosure.fields.reduce((sum, f) => sum + f.chars, 0),
    );
    assert.equal(disclosure.endpoint, context.endpoint);
    assert.equal(disclosure.local, true);
  });

  it('опись объединяет несколько писем цепочки', () => {
    const first = prepareMessage(sampleMessage());
    const second = prepareMessage(sampleMessage({ id: 'inbox:43', subject: 'Re: Счёт' }));
    const disclosure = describeOutbound([first, second], context);
    assert.equal(disclosure.attachmentsExcluded.length, 2);
    assert.ok(disclosure.fields.length >= first.parts.length + second.parts.length - 1);
  });

  it('письмо без тела и без темы не приводит к ошибке', () => {
    const prepared = prepareMessage({
      id: 'inbox:1',
      subject: '',
      date: '2026-01-01T00:00:00.000Z',
      from: { name: null, address: 'a@b.c' },
      to: [],
      bodyText: null,
      bodyHtml: null,
    });
    assert.equal(prepared.body, '');
    assert.equal(prepared.attachmentsExcluded.length, 0);
    assert.ok(renderPrepared(prepared).includes('a@b.c'));
  });

  it('HTML-письмо превращается в текст без разметки', () => {
    const prepared = prepareMessage(
      sampleMessage({
        bodyText: null,
        bodyHtml:
          '<html><head><style>p{color:red}</style></head><body><p>Первый абзац.</p>' +
          '<ul><li>Пункт один</li><li>Пункт два</li></ul>' +
          '<script>alert(1)</script></body></html>',
      }),
    );
    assert.ok(!prepared.body.includes('<'));
    assert.ok(!prepared.body.includes('alert'));
    assert.ok(!prepared.body.includes('color:red'));
    assert.ok(prepared.body.includes('Первый абзац.'));
    assert.ok(prepared.body.includes('Пункт один'));
  });
});

describe('урезание длинных писем', () => {
  it('текст короче предела не трогается', () => {
    const result = truncateBody('короткий текст', 100);
    assert.equal(result.text, 'короткий текст');
    assert.equal(result.removedChars, 0);
  });

  it('длинный текст урезается с сохранением начала и конца', () => {
    const head = 'НАЧАЛО ПИСЬМА. Важная суть в первом абзаце.\n\n';
    const middle = 'Много воды. '.repeat(500);
    const tail = '\n\nКОНЕЦ ПИСЬМА: просьба ответить до пятницы.';
    const result = truncateBody(head + middle + tail, 1000);

    assert.ok(result.removedChars > 0);
    assert.ok(result.text.includes('НАЧАЛО ПИСЬМА'));
    assert.ok(result.text.includes('КОНЕЦ ПИСЬМА'));
    assert.ok(result.text.includes('пропущено'));
    assert.ok(result.text.length < head.length + middle.length + tail.length);
    assert.ok(result.text.length <= 1000 + 60);
  });

  it('prepareMessage урезает письмо и отмечает это в описи', () => {
    const long = 'Строка письма с содержанием. '.repeat(2000);
    const prepared = prepareMessage(sampleMessage({ bodyText: long, attachments: [] }), {
      maxBodyChars: 500,
    });
    assert.ok(prepared.body.length <= 560);
    const note = prepared.removed.find((r) => r.kind === 'truncated');
    assert.ok(note);
    assert.ok(note.chars > 0);
  });

  it('предел по умолчанию задан и положителен', () => {
    assert.ok(DEFAULT_MAX_BODY_CHARS > 1000);
  });
});

describe('describeBodyOnly (опись перевода)', () => {
  it('перечисляет вырезанное, а не рапортует «ничего»', () => {
    /*
     * Перевод ЗАМЕНЯЕТ письмо на экране, поэтому опись под ним обязана
     * назвать всё, чего в переводе нет. Раньше она строилась через
     * describePlainText, у которой removed пуст по определению, — и
     * человек читал «вырезано: ничего», хотя из письма убрали и цитату,
     * и подпись.
     */
    const message = sampleMessage({
      bodyText:
        'Добрый день! Отчёт готов.\n\nС уважением,\nПётр Петров\n+7 900 000-00-00\n\n' +
        '10 августа 2026, Иван Иванов <ivan@example.org> написал(а):\n> Пришлите отчёт',
    });
    const prepared = prepareMessage(message);
    const disclosure = describeBodyOnly('Текст письма', prepared, context);

    assert.ok(disclosure.removed.length > 0, 'вырезанное должно быть перечислено');
    // Наружу уходит РОВНО тело: ни темы, ни адресов в запросе перевода нет.
    assert.equal(disclosure.fields.length, 1);
    assert.equal(disclosure.fields[0]?.value, prepared.body);
    assert.equal(disclosure.totalChars, prepared.body.length);
  });

  it('вложения перечисляются как не отправленные', () => {
    const prepared = prepareMessage(
      sampleMessage({
        attachments: [{ filename: 'dogovor.pdf', mimeType: 'application/pdf', size: 1000 }],
      }),
    );
    const disclosure = describeBodyOnly('Текст письма', prepared, context);
    assert.deepEqual(disclosure.attachmentsExcluded, prepared.attachmentsExcluded);
  });
});
