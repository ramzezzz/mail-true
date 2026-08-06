/**
 * Что умеет этот браузер и что именно не работает.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТО ОТДЕЛЬНЫМ ФАЙЛОМ
 * ------------------------------------------------------------------
 * «Уведомления не приходят» — самая безнадёжная жалоба, какую можно
 * получить: причин восемь, а видно ноль. Разрешение не спрашивали;
 * спросили и отказали; отказали полгода назад и забыли; браузер работает
 * не по защищённому соединению; вкладка в режиме инкогнито; на сервере
 * выключен push; подписка отозвана. Каждая из них требует РАЗНЫХ действий
 * от человека, и ни одну нельзя показать словом «ошибка».
 *
 * Поэтому состояние разбирается здесь, отдельно от разметки и без единого
 * обращения к сети, — и проверяется тестом по каждому случаю.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ РАЗРЕШЕНИЕ НЕ СПРАШИВАЕТСЯ ПРИ ЗАГРУЗКЕ СТРАНИЦЫ
 * ------------------------------------------------------------------
 * Спрашивать сразу нельзя, и дело не в вежливости. Chrome с версии 80
 * подменяет такой запрос неприметной иконкой в адресной строке, а Firefox
 * с версии 72 гасит его совсем, если не было жеста пользователя. То есть
 * окно, показанное «на всякий случай», человек чаще всего вообще не
 * увидит — а если увидит, на первой секунде знакомства нажмёт
 * «Блокировать». Вернуть это потом почти невозможно: сайт спросить больше
 * не может, только человек руками в настройках браузера.
 *
 * Отсюда правило: спрашиваем ТОЛЬКО после явного действия — включения
 * переключателя в настройках или нажатия на понятное предложение. Само
 * правило живёт в subscribe.ts, здесь — язык, на котором о нём говорят.
 */

/** Как обстоят дела с показом уведомлений. */
export type NotificationSupport =
  /** Браузер не умеет уведомления вовсе. */
  | 'unsupported'
  /** Умеет, но страница отдана не по защищённому соединению. */
  | 'insecure'
  /** Разрешение ещё не спрашивали. */
  | 'default'
  | 'granted'
  | 'denied';

export interface BrowserCapabilities {
  support: NotificationSupport;
  /** Есть ли Service Worker и Push API — без них уведомления только при открытой вкладке. */
  pushSupported: boolean;
  /** Умеет ли браузер кнопки в уведомлении (Safari до 16.4 не умеет). */
  actionsSupported: boolean;
}

/** Окружение браузера. Отдельным типом — чтобы проверять без браузера. */
export interface BrowserEnvironment {
  hasNotification: boolean;
  permission: NotificationPermission | null;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasActions: boolean;
  isSecureContext: boolean;
  userAgent: string;
}

/** Снимает окружение с настоящего браузера. */
export function readEnvironment(): BrowserEnvironment {
  const hasNotification = typeof Notification !== 'undefined';
  return {
    hasNotification,
    permission: hasNotification ? Notification.permission : null,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasActions: hasNotification && 'actions' in Notification.prototype,
    // Push API и Service Worker работают только в защищённом контексте.
    // localhost браузеры считают защищённым — на нём и идёт разработка.
    isSecureContext: typeof window === 'undefined' ? false : window.isSecureContext,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  };
}

export function capabilitiesOf(env: BrowserEnvironment): BrowserCapabilities {
  let support: NotificationSupport;
  if (!env.hasNotification) support = 'unsupported';
  else if (!env.isSecureContext) support = 'insecure';
  else if (env.permission === 'granted') support = 'granted';
  else if (env.permission === 'denied') support = 'denied';
  else support = 'default';

  return {
    support,
    pushSupported:
      env.hasServiceWorker && env.hasPushManager && env.isSecureContext && env.hasNotification,
    actionsSupported: env.hasActions,
  };
}

/* ------------------------------------------------------------------ */
/* Что сказать человеку                                                 */
/* ------------------------------------------------------------------ */

export type NoticeTone = 'info' | 'warning' | 'blocked';

export interface CapabilityNotice {
  tone: NoticeTone;
  title: string;
  /** Что именно не работает. Без слова «ошибка». */
  text: string;
  /** Что сделать руками. Пусто — делать нечего. */
  steps: string[];
}

/** Семейство браузера — от него зависит путь в настройки разрешений. */
export type BrowserFamily = 'chrome' | 'firefox' | 'safari' | 'edge' | 'other';

export function browserFamily(userAgent: string): BrowserFamily {
  if (/\bEdg\//u.test(userAgent)) return 'edge';
  if (/\bFirefox\//u.test(userAgent)) return 'firefox';
  // Проверка Chrome должна идти ДО Safari: Chrome представляется и тем и
  // другим, и с обратным порядком все инструкции были бы от Safari.
  if (/\bChrome\/|\bYaBrowser\/|\bOPR\//u.test(userAgent)) return 'chrome';
  if (/\bSafari\//u.test(userAgent)) return 'safari';
  return 'other';
}

/**
 * Как вернуть разрешение, которое однажды отклонили.
 *
 * Сайт спросить второй раз не может — это запрет самого браузера, а не
 * наша недоработка. Единственный путь лежит через настройки браузера, и
 * молчать о нём нельзя: без этих трёх строк человек остаётся с
 * неработающей настройкой и без единой подсказки.
 */
export function recoverySteps(family: BrowserFamily): string[] {
  switch (family) {
    case 'chrome':
      return [
        'Нажмите на значок настроек слева от адреса страницы (замок или ползунки).',
        'Найдите «Уведомления» и выберите «Разрешить».',
        'Обновите страницу и включите уведомления здесь снова.',
      ];
    case 'edge':
      return [
        'Нажмите на значок замка слева от адреса страницы.',
        'В строке «Уведомления» выберите «Разрешить».',
        'Обновите страницу и включите уведомления здесь снова.',
      ];
    case 'firefox':
      return [
        'Нажмите на значок слева от адреса страницы.',
        'Уберите пометку «Заблокировано» у пункта «Отправка уведомлений».',
        'Обновите страницу и включите уведомления здесь снова.',
      ];
    case 'safari':
      return [
        'Откройте Safari → Настройки → Веб-сайты → Уведомления.',
        'Найдите этот сайт и выберите «Разрешить».',
        'Обновите страницу и включите уведомления здесь снова.',
      ];
    default:
      return [
        'Откройте настройки сайта в браузере (обычно — значок слева от адреса страницы).',
        'Разрешите этому сайту показывать уведомления.',
        'Обновите страницу и включите уведомления здесь снова.',
      ];
  }
}

export interface NoticeInput {
  capabilities: BrowserCapabilities;
  userAgent: string;
  /** Хочет ли человек уведомления при закрытой вкладке. */
  wantsPush: boolean;
  /** Работает ли push на сервере. */
  pushAvailable: boolean;
  /** Почему не работает на сервере. */
  pushUnavailableReason: string | null;
}

/**
 * Единственное сообщение, которое нужно показать прямо сейчас.
 *
 * Именно одно: список из четырёх предупреждений читается как «всё
 * сломано» и не помогает ни в чём. Порядок — от самого непреодолимого
 * к самому мелкому.
 */
export function capabilityNotice(input: NoticeInput): CapabilityNotice | null {
  const { capabilities: caps } = input;

  if (caps.support === 'unsupported') {
    return {
      tone: 'blocked',
      title: 'Этот браузер не умеет показывать уведомления',
      text:
        'Письма продолжают приходить, а счётчик непрочитанных в заголовке вкладки работает ' +
        'как обычно. Всплывающих окон операционной системы в этом браузере не будет.',
      steps: [],
    };
  }

  if (caps.support === 'insecure') {
    return {
      tone: 'blocked',
      title: 'Уведомления работают только по защищённому соединению',
      text:
        'Страница открыта по http. Браузеры разрешают уведомления только на сайтах с https ' +
        '(и на localhost — там разработка). Это ограничение браузера, а не настройка почты.',
      steps: ['Откройте почту по адресу, начинающемуся с https://'],
    };
  }

  if (caps.support === 'denied') {
    return {
      tone: 'blocked',
      title: 'Браузер заблокировал уведомления от этого сайта',
      text:
        'Спросить разрешение ещё раз почта не может — так устроены браузеры: после отказа ' +
        'запрос больше не показывается. Вернуть разрешение можно только вручную.',
      steps: recoverySteps(browserFamily(input.userAgent)),
    };
  }

  if (input.wantsPush && !caps.pushSupported) {
    return {
      tone: 'warning',
      title: 'При закрытой вкладке уведомлений не будет',
      text:
        'Этот браузер не поддерживает фоновую доставку (Service Worker и Push API). ' +
        'Пока почта открыта хотя бы в одной вкладке, уведомления работают как обычно.',
      steps: [],
    };
  }

  if (input.wantsPush && !input.pushAvailable) {
    return {
      tone: 'warning',
      title: 'При закрытой вкладке уведомлений не будет',
      text:
        input.pushUnavailableReason ??
        'Сервер не настроен на доставку уведомлений при закрытой вкладке.',
      steps: ['Обратитесь к администратору почтового сервера.'],
    };
  }

  if (caps.support === 'default') {
    return {
      tone: 'info',
      title: 'Разрешение у браузера ещё не спрошено',
      text:
        'Оно спрашивается ровно тогда, когда вы включаете уведомления, — не раньше. ' +
        'Браузер покажет своё окно с вопросом один раз.',
      steps: [],
    };
  }

  if (!caps.actionsSupported) {
    return {
      tone: 'info',
      title: 'Кнопок в уведомлении не будет',
      text:
        'Этот браузер не умеет показывать кнопки внутри уведомления. Само уведомление ' +
        'работает: по нажатию откроется нужное письмо.',
      steps: [],
    };
  }

  return null;
}
