/**
 * Контракт раздела уведомлений — тот же, что на сервере
 * (apps/api/src/push/types.ts). Дублируется, а не берётся из общего
 * пакета, по той же причине, по которой дублируются остальные DTO
 * интерфейса: `packages/shared` собирается в оба приложения, и тащить
 * туда типы одного раздела значило бы увеличивать общий пакет ради
 * одной страницы настроек.
 */

export const NOTIFICATION_LEVELS = ['minimal', 'sender-subject', 'preview', 'ai-summary'] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export interface QuietHours {
  enabled: boolean;
  fromMinutes: number;
  toMinutes: number;
}

export interface NotificationPrefs {
  enabled: boolean;
  level: NotificationLevel;
  push: boolean;
  pushPayload: boolean;
  skipFiltered: boolean;
  quietHours: QuietHours;
  timeZone: string | null;
  updatedAt: string | null;
}

export interface PushDevice {
  id: number;
  browser: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  lastError: string | null;
}

export interface PushState {
  pushAvailable: boolean;
  pushUnavailableReason: string | null;
  vapidPublicKey: string | null;
  /**
   * Отпечаток открытого ящика: работник сверяет по нему содержимое,
   * приехавшее внутри push, и не показывает чужое на общем компьютере.
   */
  accountKey: string;
  prefs: NotificationPrefs;
  devices: PushDevice[];
  ai: { available: boolean; reason: string | null };
}

/** Заплатка настроек: передаются только изменяемые поля. */
export interface NotificationPrefsPatch {
  level?: NotificationLevel;
  push?: boolean;
  pushPayload?: boolean;
  skipFiltered?: boolean;
  quietEnabled?: boolean;
  quietFrom?: number;
  quietTo?: number;
  timeZone?: string | null;
}

/** Готовое описание всплывающего окна — его собирает сервер. */
export interface NotificationView {
  title: string;
  body: string;
  tag: string;
  icon: string;
  badge: string;
  actions: { action: string; title: string }[];
  url: string;
  ids: string[];
  degraded: string | null;
}

/* ------------------------------------------------------------------ */
/* Тексты уровней подробности                                           */
/* ------------------------------------------------------------------ */

export interface LevelInfo {
  key: NotificationLevel;
  title: string;
  /** Что будет видно в окне — на примере, а не описанием. */
  example: { title: string; body: string };
  /** Чем за это платят. Пусто — ничем. */
  caveat: string | null;
}

/**
 * Пример важнее описания: «отправитель, тема и первые фразы» звучит
 * одинаково безобидно для всех, а увиденное окно сразу отвечает на
 * настоящий вопрос — «что из этого прочтёт человек, случайно
 * взглянувший на мой экран».
 */
export const LEVEL_INFO: Record<NotificationLevel, LevelInfo> = {
  minimal: {
    key: 'minimal',
    title: 'Только факт: пришло письмо',
    example: { title: 'Новое письмо', body: 'Откройте почту, чтобы прочитать' },
    caveat: null,
  },
  'sender-subject': {
    key: 'sender-subject',
    title: 'Отправитель и тема',
    example: { title: 'Пётр Смирнов', body: 'Договор поставки' },
    caveat: null,
  },
  preview: {
    key: 'preview',
    title: 'Отправитель, тема и первые фразы',
    example: {
      title: 'Пётр Смирнов',
      body: 'Договор поставки\nДобрый день! Направляю подписанный договор на согласование…',
    },
    caveat:
      'Начало письма прочтёт всякий, кто посмотрит на экран, — в том числе когда почта закрыта.',
  },
  'ai-summary': {
    key: 'ai-summary',
    title: 'Отправитель, тема и сводка от ИИ',
    example: {
      title: 'Пётр Смирнов',
      body: 'Договор поставки\nПрислал подписанный договор, ждёт согласования до пятницы.',
    },
    caveat:
      'Сводка считается для каждого письма и расходует средства помощника. ' +
      'Когда предел исчерпан, в уведомлении остаются первые фразы письма.',
  },
};
