/**
 * Ответ уходит туда, куда просил отправитель.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * В поле «Кому» безусловно вставлялся адрес из `From`. Заголовок
 * `Reply-To` при этом разбирался сервером, лежал в письме и даже
 * показывался в подробностях — но при нажатии «Ответить» не читался
 * нигде.
 *
 * А существует он ровно для этого случая: письмо приходит с адреса вида
 * `noreply@bank.ru`, а отвечать надо на `support@bank.ru`. Так устроены
 * рассылки, тикет-системы и корпоративные ящики, то есть почти всё, на
 * что человек отвечает по работе.
 *
 * Ответ уходил на адрес, который его не принимает или не читает, и
 * человек об этом не узнавал: письмо «успешно отправлено».
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@mail-true/shared';
import { quoteHtml, replyInit } from '../src/lib/composeFromMessage';

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'inbox:1',
    folderId: 'inbox',
    uid: 1,
    threadId: 't-1',
    from: { name: 'Банк', address: 'noreply@bank.ru' },
    to: [{ name: null, address: 'ya@mail.local' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Выписка по счёту',
    date: '2026-08-06T09:00:00.000Z',
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 1024,
    preview: '',
    messageId: '<1@bank.ru>',
    references: [],
    labels: [],
    ...patch,
  } as unknown as Message;
}

describe('«Ответить» и заголовок Reply-To', () => {
  it('ответ идёт на Reply-To, а не на noreply из From', () => {
    const init = replyInit(
      message({ replyTo: [{ name: 'Поддержка', address: 'support@bank.ru' }] }),
      false,
    );
    expect(init.to).toContain('support@bank.ru');
    expect(init.to).not.toContain('noreply@bank.ru');
  });

  it('несколько адресов в Reply-To попадают все', () => {
    const init = replyInit(
      message({
        replyTo: [
          { name: null, address: 'support@bank.ru' },
          { name: null, address: 'office@bank.ru' },
        ],
      }),
      false,
    );
    expect(init.to).toContain('support@bank.ru');
    expect(init.to).toContain('office@bank.ru');
  });

  it('без Reply-To отвечаем отправителю — как и раньше', () => {
    const init = replyInit(message(), false);
    expect(init.to).toContain('noreply@bank.ru');
  });

  it('в поле попадают только адреса — вид поля «Кому» не меняется', () => {
    // Имена сюда не подставляем намеренно: раньше `From` вставлялся
    // голым адресом, и менять привычный вид поля ради этой правки
    // незачем. Речь о том, КУДА уйдёт ответ, а не как он подписан.
    const init = replyInit(
      message({ replyTo: [{ name: 'Иванов, Иван', address: 'ivan@bank.ru' }] }),
      false,
    );
    expect(init.to).toBe('ivan@bank.ru');
  });
});

/*
 * Цитата уходит в редактор через dangerouslySetInnerHTML, то есть
 * становится разметкой приложения. Имя отправителя приходит из письма как
 * есть: RFC 2047 разрешает в закодированном слове любые символы, и
 * отображаемым именем бывает <img src="http://tracker/px.gif">.
 *
 * Что из этого выходило: тело письма санировано, внешние картинки
 * заблокированы — маячок молчит; человек нажимает «Ответить», имя
 * вклеивается в разметку, браузер грузит картинку, и отправитель узнаёт
 * факт и время прочтения в обход блокировки.
 */
describe('цитата исходного письма', () => {
  it('имя отправителя не становится разметкой', () => {
    const html = quoteHtml(
      message({
        from: { name: '<img src="http://tracker.example/px.gif">', address: 'a@b.c' },
        bodyHtml: '<p>Текст</p>',
      }),
    );
    expect(/<img/i.test(html), 'картинка из имени отправителя попала в письмо').toBe(false);
    expect(html).toContain('&lt;img');
  });

  it('текстовое письмо цитируется текстом, а не разметкой', () => {
    const html = quoteHtml(
      message({
        bodyHtml: null,
        bodyText: 'Первая строка\nВторая строка\nЕсли a < b, то c > d\n<не тег>',
      }),
    );
    // Переводы строк сохранены: раньше цитата схлопывалась в один абзац.
    expect(html).toContain('<br>');
    // Угловые скобки показаны, а не съедены разбором разметки.
    expect(html).toContain('&lt;не тег&gt;');
    expect(html).toContain('a &lt; b');
  });
});
