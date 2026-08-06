/**
 * Заглушечные данные для разработки без бэкенда.
 * Папки повторяют реальный ящик mail.ru (см. docs/design-system.md):
 * системные — по имени, пользовательские — по числовому id,
 * автокатегории вложены во «Входящие».
 */

import type { Account, Folder, Message, MessageSummary } from '@mail-true/shared';

export const mockAccount: Account = {
  id: 'acc-1',
  email: 'demo@mail.true',
  displayName: 'Демо Пользователь',
  avatarUrl: null,
  quotaUsedBytes: 3.2 * 1024 ** 3,
  quotaLimitBytes: 8 * 1024 ** 3,
  signature: '—\nОтправлено из Mail.True',
  createdAt: '2024-01-15T09:00:00Z',
};

export const mockFolders: Folder[] = [
  folder('inbox', 'INBOX', 'Входящие', 'inbox', null, 0, 7, 132, true),
  folder('social', 'INBOX/Social', 'Социальные сети', 'custom', 'inbox', 1, 2, 25, true),
  folder('newsletters', 'INBOX/Newsletters', 'Рассылки', 'custom', 'inbox', 1, 4, 58, true),
  folder('news', 'INBOX/News', 'Новости', 'custom', 'inbox', 1, 0, 14, true),
  folder('receipts', 'INBOX/Receipts', 'Чеки', 'custom', 'inbox', 1, 1, 9, true),
  folder('1', 'Важное', 'Важное', 'custom', null, 0, 0, 6, false),
  folder('archive', 'Archive', 'Архив', 'archive', null, 0, 0, 0, true),
  folder('sent', 'Sent', 'Отправленные', 'sent', null, 0, 0, 41, true),
  folder('drafts', 'Drafts', 'Черновики', 'drafts', null, 0, 0, 3, true),
  folder('spam', 'Spam', 'Спам', 'spam', null, 0, 12, 12, true),
  folder('trash', 'Trash', 'Корзина', 'trash', null, 0, 0, 17, true),
];

function folder(
  id: string,
  path: string,
  name: string,
  role: Folder['role'],
  parentId: string | null,
  depth: number,
  unreadCount: number,
  totalCount: number,
  system: boolean,
): Folder {
  return { id, path, name, role, parentId, depth, unreadCount, totalCount, system, uidValidity: 1 };
}

/* ------------------------------------------------------------------ */
/* Письма                                                               */
/* ------------------------------------------------------------------ */

interface Seed {
  from: [string | null, string];
  subject: string;
  snippet: string;
  hoursAgo: number;
  unread?: boolean;
  flagged?: boolean;
  attachments?: string[];
  /** Метки: категории («finance», «official»…) и «reliable» — надёжный отправитель. */
  labels?: string[];
  /** Ключ цепочки: письма с одним ключом собираются в один тред. */
  thread?: string;
}

const inboxSeeds: Seed[] = [
  {
    from: ['Команда Mail.True', 'team@mail.true'],
    subject: 'Добро пожаловать в Mail.True!',
    snippet: 'Ваш ящик готов к работе. Настройте подпись, темы оформления и сборщики почты — всё в разделе «Настройки».',
    hoursAgo: 1,
    unread: true,
    labels: ['reliable'],
  },
  {
    from: ['Анна Смирнова', 'a.smirnova@example.com'],
    subject: 'Отчёт за июль',
    snippet: 'Привет! Отправляю финальную версию отчёта, посмотри вкладку «Сводка» — там основные цифры по кварталу.',
    hoursAgo: 3,
    unread: true,
    // Таблица и текстовый файл рядом — на этом письме видно оба исхода
    // предпросмотра: XLSX смотреть нечем (только скачать), TXT открывается.
    attachments: ['Отчёт_июль.xlsx', 'Примечания.txt'],
  },
  {
    from: ['GitHub', 'noreply@github.com'],
    subject: '[mail-true] Pull request #42: Слой дизайн-токенов',
    snippet: 'Merged: build-tokens генерирует tokens.css из выгрузки живого интерфейса. 12 files changed, 1450 insertions.',
    hoursAgo: 5,
    unread: true,
    labels: ['registration'],
  },
  {
    from: ['Сергей Ковалёв', 's.kovalev@example.com'],
    subject: 'Re: Встреча по проекту',
    snippet: 'Договорились, тогда в четверг в 15:00. Ссылку на звонок пришлю за час до встречи.',
    hoursAgo: 8,
    flagged: true,
    thread: 'meeting',
  },
  {
    from: ['Кинотеатр «Октябрь»', 'tickets@example-cinema.ru'],
    subject: 'Ваши билеты на 9 августа',
    snippet: 'Электронные билеты во вложении. Сеанс начинается в 19:30, зал 4, места 7 и 8.',
    hoursAgo: 26,
    attachments: ['Билеты.pdf'],
    labels: ['order'],
  },
  {
    from: ['Марина Лебедева', 'm.lebedeva@example.com'],
    subject: 'Фотографии с выходных',
    snippet: 'Наконец-то разобрала фотографии! Самые удачные приложила, остальные скину ссылкой на облако.',
    hoursAgo: 30,
    unread: true,
    attachments: ['IMG_2041.jpg', 'IMG_2054.jpg', 'IMG_2060.jpg'],
  },
  {
    from: ['Госуслуги', 'no-reply@gosuslugi.ru'],
    subject: 'Напоминание о записи к врачу',
    snippet: 'Вы записаны на приём 12 августа в 10:20. Не забудьте взять с собой полис ОМС.',
    hoursAgo: 50,
    labels: ['official', 'reliable'],
  },
  {
    from: ['Дмитрий Волков', 'd.volkov@example.com'],
    subject: 'Черновик статьи — нужен твой взгляд',
    snippet: 'Дописал раздел про виртуализацию списков. Глянь, пожалуйста, не слишком ли занудно получилось?',
    hoursAgo: 55,
    unread: true,
  },
  {
    from: ['Aviasales', 'hello@aviasales.ru'],
    subject: 'Цены на Сочи упали на 23%',
    snippet: 'Билеты туда-обратно от 8 940 ₽. Подборка удобных рейсов на сентябрь внутри.',
    hoursAgo: 72,
    labels: ['travel'],
  },
  {
    from: ['Банк «Пример»', 'notify@example-bank.ru'],
    subject: 'Выписка по счёту за июль',
    snippet: 'Сформирована ежемесячная выписка по вашему счёту. Документ во вложении, защищён паролем.',
    hoursAgo: 96,
    unread: true,
    attachments: ['Выписка_2026-07.pdf'],
    labels: ['finance', 'reliable'],
  },
  {
    from: ['Ольга Романова', 'o.romanova@example.com'],
    subject: 'День рождения Кати — скидываемся на подарок',
    snippet: 'Всем привет! Собираем по 1500 до пятницы, идеи подарка пишите в чат, пока лидирует керамическая мастерская.',
    hoursAgo: 120,
    flagged: true,
  },
  {
    from: ['habr', 'noreply@habr.com'],
    subject: 'Еженедельный дайджест: 15 лучших публикаций',
    snippet: 'React Server Components в проде, разбор IMAP-протокола, и почему CSS-переменные — это новая типизация.',
    hoursAgo: 168,
    labels: ['mailings'],
  },
  {
    from: ['Сергей Ковалёв', 's.kovalev@example.com'],
    subject: 'Встреча по проекту',
    snippet: 'Коллеги, предлагаю собраться на этой неделе и обсудить план на квартал. Кому какое время удобно?',
    hoursAgo: 176,
    thread: 'meeting',
  },
];

/**
 * Дополнительный массив писем за прошлые месяцы — чтобы список был длинным
 * и виртуализация имела смысл. Данные детерминированные (без Math.random).
 */
const bulkSenders: [string, string][] = [
  ['Ozon', 'info@ozon.ru'],
  ['Хабр Карьера', 'career@habr.com'],
  ['Кофейня «Зерно»', 'hello@zerno.example'],
  ['РЖД', 'ticket@rzd.ru'],
  ['Спортмастер', 'news@sportmaster.ru'],
  ['Иван Петров', 'i.petrov@example.com'],
];

const bulkSubjects: string[] = [
  'Ваш заказ передан в доставку',
  'Новые вакансии по вашему профилю',
  'Дарим бесплатный капучино в день рождения',
  'Электронный билет и посадочный купон',
  'Скидки выходного дня до 40%',
  'Протокол встречи и следующие шаги',
];

const bulkSeeds: Seed[] = Array.from({ length: 60 }, (_, i) => {
  const seed: Seed = {
    from: bulkSenders[i % bulkSenders.length]!,
    subject: `${bulkSubjects[i % bulkSubjects.length]} №${i + 1}`,
    snippet:
      'Автоматически сгенерированное письмо для проверки длинного списка: группировка по месяцам, прокрутка и виртуализация.',
    hoursAgo: 200 + i * 37, // расползается на несколько месяцев назад
    unread: i % 7 === 0,
    flagged: i % 13 === 0,
  };
  if (i % 9 === 0) seed.attachments = ['Документ.pdf'];
  if (i % 6 === 3) seed.labels = ['mailings'];
  return seed;
});

function makeMessage(seed: Seed, folderId: string, uid: number): MessageSummary {
  const date = new Date(Date.now() - seed.hoursAgo * 3600_000).toISOString();
  return {
    id: `${folderId}:${uid}`,
    folderId,
    uid,
    threadId: seed.thread ? `t-${seed.thread}` : `t-${folderId}-${uid}`,
    from: { name: seed.from[0], address: seed.from[1] },
    to: [{ name: mockAccount.displayName, address: mockAccount.email }],
    cc: [],
    subject: seed.subject,
    snippet: seed.snippet,
    date,
    flags: {
      seen: !seed.unread,
      flagged: seed.flagged ?? false,
      answered: false,
      forwarded: false,
      draft: folderId === 'drafts',
      deleted: false,
    },
    hasAttachments: (seed.attachments?.length ?? 0) > 0,
    attachmentNames: seed.attachments ?? [],
    labels: seed.labels ?? [],
    pinned: false,
    sizeBytes: 4096 + seed.snippet.length * 32,
  };
}

/** Все письма всех папок; список отсортирован по дате (новые первыми). */
export const mockMessages: MessageSummary[] = [
  ...inboxSeeds.map((seed, i) => makeMessage(seed, 'inbox', 1000 - i)),
  ...bulkSeeds.map((seed, i) => makeMessage(seed, 'inbox', 900 - i)),
  makeMessage(
    {
      from: ['ВКонтакте', 'notify@vk.com'],
      subject: 'У вас 3 новых уведомления',
      snippet: 'Друзья отметили вас на фотографии и пригласили в сообщество.',
      hoursAgo: 12,
      unread: true,
    },
    'social',
    500,
  ),
  makeMessage(
    {
      from: ['Ozon', 'info@ozon.ru'],
      subject: 'Скидки недели: до −60% на электронику',
      snippet: 'Наушники, зарядные станции и умные колонки — успейте до воскресенья.',
      hoursAgo: 20,
      unread: true,
    },
    'newsletters',
    600,
  ),
  makeMessage(
    {
      from: [mockAccount.displayName, mockAccount.email],
      subject: 'Документы по аренде',
      snippet: 'Добрый день! Высылаю подписанные сканы договора, оригиналы завезу в офис в среду.',
      hoursAgo: 40,
    },
    'sent',
    700,
  ),
  makeMessage(
    {
      from: [mockAccount.displayName, mockAccount.email],
      subject: '(без темы)',
      snippet: 'Коллеги, по итогам вчерашнего созвона…',
      hoursAgo: 60,
    },
    'drafts',
    800,
  ),
];

/** Разворачивает сводку в полное письмо (для GET /api/messages/:id). */
export function expandMessage(summary: MessageSummary): Message {
  // У рассылок в теле — внешняя картинка, чтобы проверить её блокировку
  const externalImage = summary.labels.includes('travel') || summary.labels.includes('mailings')
    ? '<p><img src="https://static.example.com/promo/banner.jpg" alt="Промо-баннер" width="560" height="180"></p>'
    : '';
  return {
    ...summary,
    messageId: `<${summary.uid}@mock.mail.true>`,
    inReplyTo: null,
    references: [],
    replyTo: [],
    bcc: [],
    bodyHtml: `<div><p>${summary.snippet}</p>${externalImage}<p>Это заглушечное тело письма — бэкенд ещё в разработке. Здесь появится продезинфицированный HTML реального письма.</p></div>`,
    bodyText: `${summary.snippet}\n\nЭто заглушечное тело письма.`,
    attachments: summary.attachmentNames.map((filename, i) => ({
      partId: String(i + 2),
      filename,
      mimeType: filename.endsWith('.pdf')
        ? 'application/pdf'
        : filename.endsWith('.xlsx')
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : filename.endsWith('.txt')
            ? 'text/plain'
            : 'image/jpeg',
      size: 120_000 + i * 34_567,
      contentId: null,
      inline: false,
    })),
    // Имена заголовков — в нижнем регистре, как их отдаёт сервер
    // (apps/api/src/mail/parse.ts, HEADER_WHITELIST). Заглушка писала их
    // с заглавных, и проверка «есть ли List-Unsubscribe» проходила только
    // на заглушках, а против настоящего API не срабатывала никогда.
    headers: {
      'return-path': summary.from.address,
      ...(summary.labels.includes('mailings') || summary.labels.includes('travel')
        ? {
            'list-unsubscribe': `<mailto:unsubscribe@${summary.from.address.split('@')[1]}>, <https://${summary.from.address.split('@')[1]}/unsubscribe>`,
            'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
          }
        : {}),
    },
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  };
}
