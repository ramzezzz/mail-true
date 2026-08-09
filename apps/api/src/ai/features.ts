/**
 * Возможности помощника с точки зрения пользователя.
 *
 * Пакет @mail-true/ai оперирует техническими возможностями
 * ('summarize.message', 'reply.continue', …) — это единицы учёта в журнале
 * и в ключе кэша. Пользователю такое дробление не нужно: он включает
 * «резюме» или «помощь с ответом» целиком.
 *
 * Здесь задано соответствие между тем и другим, а заодно — описания,
 * которые показываются на экране согласия. Описания намеренно
 * конкретны: «тема, отправитель, получатели и текст письма», а не
 * «данные, необходимые для работы сервиса».
 */
import type { AiFeature } from '@mail-true/ai';

/** Возможность в терминах интерфейса. */
export const AI_FEATURES = [
  'summary',
  'classify',
  'reply',
  'extract',
  'translate',
  'search',
  'logos',
] as const;

export type AiUserFeature = (typeof AI_FEATURES)[number];

export interface AiFeatureInfo {
  key: AiUserFeature;
  title: string;
  /** Что делает — одной строкой. */
  description: string;
  /** Что именно уходит наружу при использовании. Без тумана. */
  sends: string;
  /** Технические возможности пакета, которые эта кнопка задействует. */
  technical: readonly AiFeature[];
  /** Включена ли по умолчанию у нового пользователя. */
  defaultOn: boolean;
}

export const AI_FEATURE_INFO: Readonly<Record<AiUserFeature, AiFeatureInfo>> = {
  summary: {
    key: 'summary',
    title: 'Краткое резюме',
    description: 'Три-четыре строки вместо длинного письма или всей переписки.',
    sends: 'Тема, отправитель, получатели, дата и текст письма (или всех писем цепочки).',
    technical: ['summarize.message', 'summarize.thread'],
    defaultOn: true,
  },
  classify: {
    key: 'classify',
    title: 'Раскладка по смыслу',
    description: 'Метка письма: счёт, доставка, встреча, договор, личное.',
    sends: 'Тема, отправитель, получатели, дата и первые 2000 символов текста письма.',
    technical: ['classify'],
    defaultOn: false,
  },
  reply: {
    key: 'reply',
    title: 'Помощь с ответом',
    description:
      'Варианты ответа с разным тоном, продолжение начатой фразы, правка написанного. ' +
      'Ответ попадает в поле ввода как черновик — отправка только вашими руками.',
    sends:
      'Тема, отправитель, получатели, дата и текст письма, на которое вы отвечаете, ' +
      'а также ваш черновик, если он уже начат.',
    technical: ['reply.variants', 'reply.continue', 'rewrite'],
    defaultOn: true,
  },
  extract: {
    key: 'extract',
    title: 'Извлечение полезного',
    description: 'Даты и встречи, суммы и реквизиты, задачи и сроки, номера отслеживания.',
    sends: 'Тема, отправитель, получатели, дата и текст письма.',
    technical: ['extract'],
    defaultOn: true,
  },
  translate: {
    key: 'translate',
    title: 'Перевод',
    description: 'Перевод письма с сохранением абзацев и списков.',
    sends: 'Только текст письма. Тема, отправитель и получатели не отправляются.',
    technical: ['translate'],
    defaultOn: true,
  },
  logos: {
    key: 'logos',
    title: 'Подсказка логотипов отправителей',
    description:
      'Когда логотип не удалось взять ни из записи BIMI домена, ни со значка его сайта, ' +
      'адрес файла можно спросить у модели. Ответ принимается, только если он ведёт ' +
      'внутрь того же домена: что бы модель ни назвала, картинка приедет с сервера ' +
      'самого отправителя, а не с чужого.',
    sends: 'Только доменное имя отправителя — например, «example.com». Письмо не отправляется.',
    technical: ['logo.hint'],
    /*
     * Выключено по умолчанию. Возможность спрашивает наружу про КАЖДЫЙ
     * незнакомый домен, с которым человек переписывается, — то есть при
     * внешнем сервисе постепенно раскрывает ему круг корреспондентов.
     * Такое включают осознанно.
     */
    defaultOn: false,
  },
  search: {
    key: 'search',
    title: 'Поиск обычными словами',
    description:
      '«письма от бухгалтерии про оплату в марте» превращается в параметры поиска. ' +
      'Во что именно превратился запрос, показывается — чтобы можно было поправить.',
    sends: 'Только строка поиска, которую вы набрали. Письма не отправляются.',
    technical: ['search.query'],
    defaultOn: false,
  },
};

/** Что не отправляется НИКОГДА, ни при одной возможности. */
export const NEVER_SENT: readonly string[] = [
  'Вложения — ни содержимое, ни фрагменты. Только имена файлов остаются у нас.',
  'Пароль от ящика и любые учётные данные.',
  'Содержимое других писем — только того, по которому нажата кнопка.',
  'Служебные заголовки (Received, DKIM-Signature, X-*).',
  'Подписи отправителя и цитаты предыдущей переписки — они вырезаются до отправки.',
];

/** Набор возможностей у нового пользователя. */
export function defaultFeatures(): AiUserFeature[] {
  return AI_FEATURES.filter((key) => AI_FEATURE_INFO[key].defaultOn);
}

export function isAiUserFeature(value: unknown): value is AiUserFeature {
  return typeof value === 'string' && (AI_FEATURES as readonly string[]).includes(value);
}

/** Отбрасывает неизвестные имена: список из базы или из запроса — не доверенный. */
export function parseFeatureList(value: unknown): AiUserFeature[] | null {
  if (!Array.isArray(value)) return null;
  const found = value.filter(isAiUserFeature);
  return [...new Set(found)];
}

/** Какой пользовательской возможности принадлежит техническая. */
export function featureOwner(technical: AiFeature): AiUserFeature {
  for (const key of AI_FEATURES) {
    if (AI_FEATURE_INFO[key].technical.includes(technical)) return key;
  }
  // Недостижимо: список технических возможностей закрыт и покрыт целиком.
  return 'summary';
}
