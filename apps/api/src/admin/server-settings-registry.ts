/**
 * Перечень настроек сервера: что вообще можно менять из панели, какого
 * значение типа, в каких пределах, что оно означает по-русски и когда
 * начинает действовать.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СПИСОК ЖИВЁТ В КОДЕ, А НЕ В БАЗЕ
 * ------------------------------------------------------------------
 * Это список РАЗРЕШЁННОГО. Строка в таблице server_settings с ключом,
 * которого здесь нет, не действует ни на что — её никто не читает. Значит
 * даже тот, кто получил доступ к базе, не может через настройки подменить
 * ни строку подключения, ни секрет сессии, ни адрес почтового хранилища:
 * этих ключей в списке нет, и появиться они в нём могут только правкой
 * кода, которая проходит проверку и обзор.
 *
 * ------------------------------------------------------------------
 * ЧЕТЫРЕ ГРУППЫ И ЧЕМ ОНИ ОТЛИЧАЮТСЯ
 * ------------------------------------------------------------------
 *   live     — значение читается ПРИ КАЖДОМ обращении. Сохранил в панели —
 *              действует со следующего запроса, перезапускать нечего.
 *   restart  — значение читается ОДИН РАЗ при старте сервера приложения
 *              (схемой окружения своего модуля). Сохранить его можно когда
 *              угодно, но до перезапуска процесса ничего не изменится.
 *              Так работает потому, что при старте значение отдаётся туда,
 *              откуда его уже не перечитать: в плагин Fastify, в интервал
 *              таймера, в пул соединений.
 *   recreate — значение читает ДРУГОЙ контейнер из своего окружения.
 *              Перезапуска процесса тут МАЛО, и это главная ловушка всей
 *              затеи: окружение задаётся при СОЗДАНИИ контейнера и живёт
 *              ровно столько же, сколько он. Перезапущенная служба
 *              поднимется с прежним окружением, человек увидит
 *              сохранённую настройку, которая не работает, и не поймёт
 *              почему. Нужно пересоздать контейнер — и предварительно
 *              положить значение в infra/.env, откуда его берёт compose.
 *   locked   — из панели не меняется вовсе. Причина у каждого своя и
 *              записана в поле `reason`: секрет, устройство стека,
 *              значение, зашитое в сертификаты и DNS.
 *
 * Группа `restart` работает благодаря тому, что при старте сервер
 * приложения подмешивает сохранённые значения в process.env ДО разбора
 * схем окружения (см. applyStoredEnv в server-settings.ts). Поэтому её
 * получают все модули сразу — и почта, и уведомления, и логотипы, — а не
 * только те, куда дописан отдельный вызов.
 *
 * Группа `recreate` появилась вместе с посредником перезапуска
 * (infra/service-agent/agent.pl). До него до окружения чужих контейнеров
 * было не дотянуться, и все эти ключи честно стояли как locked с
 * пояснением «значение читает другой контейнер». Теперь дотянуться можно —
 * но только через службу, у которой есть сокет Docker и которая умеет
 * ровно две вещи над закрытым списком служб.
 *
 * ------------------------------------------------------------------
 * ЧТО ИМЕННО ПРИМЕНЯЕТ НАСТРОЙКУ (`applies`)
 * ------------------------------------------------------------------
 * Общего «перезапустить всё» в продукте нет и не будет: остановка Postfix
 * и остановка nginx — совершенно разные события для людей. Поэтому у
 * каждой настройки записано поимённо, какие службы и каким действием её
 * включают. Панель показывает это рядом с полем: «перезапустить сервер
 * приложения», «пересоздать контейнер автонастройки» — и человек видит,
 * что именно он остановит на несколько секунд.
 *
 * Список бывает и из двух шагов. Скажем, PROVIDER_NAME читают и служба
 * автонастройки (из окружения — значит пересоздание), и сервер приложения
 * (из базы через applyStoredEnv — значит хватает перезапуска). Написать
 * тут один шаг вместо двух значило бы, что половина настройки молча не
 * применилась.
 *
 * ------------------------------------------------------------------
 * ОТКУДА ВЗЯТЫ ОПИСАНИЯ
 * ------------------------------------------------------------------
 * Из infra/.env.example — оттуда же, где они и были написаны. Сочинять их
 * заново означало бы завести второе описание одной настройки, и через
 * полгода они разошлись бы: в файле одно, в панели другое.
 */

/** Тип значения. Разбирается так же, как переменная окружения. */
export type SettingKind = 'int' | 'bool' | 'string' | 'enum';

/** Когда изменение начинает действовать (см. пояснение в шапке файла). */
export type SettingGroup = 'live' | 'restart' | 'recreate' | 'locked';

/**
 * Один шаг применения настройки: какую службу и как тронуть.
 *
 * `target` — имя из закрытого перечня в restart-targets.ts, и только
 * оттуда. Совпадение проверяется тестом: настройка, ссылающаяся на службу,
 * которую панель перезапускать не умеет, обещала бы кнопку, которой нет.
 */
export interface SettingApply {
  target: string;
  action: 'restart' | 'recreate';
}

/** Единица измерения — панели, чтобы подписать поле и показать «8 часов». */
export type SettingUnit =
  'bytes' | 'ms' | 'seconds' | 'minutes' | 'hours' | 'days' | 'rows' | 'count' | 'perMinute';

export interface SettingSpec {
  /** Имя переменной окружения — то же, что в infra/.env.example. */
  key: string;
  /** Раздел панели (см. SETTING_SECTIONS). */
  section: string;
  group: SettingGroup;
  kind: SettingKind;
  /**
   * Значение по умолчанию строкой. Обязано совпадать с умолчанием схемы
   * окружения того модуля, который эту настройку читает: расхождение
   * означало бы, что панель показывает не то, чем сервер живёт. Совпадение
   * проверяется тестом (server-settings.test.ts).
   */
  def: string;
  min?: number;
  max?: number;
  options?: readonly string[];
  unit?: SettingUnit;
  /** Описание по-русски. Перенесено из infra/.env.example. */
  description: string;
  /** Почему нельзя менять из веба. Только у группы locked. */
  reason?: string;
  /**
   * Секрет: значение не выводится наружу НИ В КАКОМ ВИДЕ — ни целиком,
   * ни звёздочками, ни длиной. Панель узнаёт о нём ровно одно: задан он
   * или нет.
   */
  secret?: boolean;
  /** Пустая строка — осмысленное значение (у него своё умолчание в коде). */
  allowEmpty?: boolean;
  /**
   * Что включает эту настройку. Пусто у группы live (включать нечего) и у
   * locked (менять нечего). У остальных — поимённо, в порядке выполнения.
   */
  applies?: readonly SettingApply[];
}

/** Короткая запись «хватает перезапуска сервера приложения». */
const APPLY_API: readonly SettingApply[] = [{ target: 'api', action: 'restart' }];

/** Разделы панели: порядок здесь — порядок на экране. */
export const SETTING_SECTIONS: ReadonlyArray<{ id: string; title: string; note?: string }> = [
  { id: 'panel', title: 'Вход в панель и сессии' },
  { id: 'mailboxes', title: 'Ящики и уборка' },
  { id: 'flow', title: 'Почтовый поток и показатели' },
  { id: 'web', title: 'Почта: сессии, пределы и частота запросов' },
  { id: 'filters', title: 'Правила фильтрации' },
  { id: 'owner', title: 'Разделы владельца ящика' },
  { id: 'push', title: 'Уведомления при закрытой вкладке' },
  { id: 'logos', title: 'Логотипы отправителей' },
  { id: 'ai', title: 'Помощник на основе ИИ' },
  { id: 'external', title: 'Чужие ящики и сбор почты' },
  { id: 'migration', title: 'Перенос почты с чужого сервера' },
  { id: 'dns', title: 'Домен и проверка DNS' },
  {
    id: 'services',
    title: 'Соседние службы: антивирус, резольвер, приём пароля',
    note:
      'Эти настройки читает не сервер приложения, а другая служба — из своего окружения. ' +
      'Окружение задаётся при СОЗДАНИИ контейнера, поэтому перезапустить процесс мало: ' +
      'он поднимется с прежними значениями. Панель пересоздаёт контейнер сама, кнопкой ' +
      'рядом с настройкой. Пересоздаётся ровно одна названная служба, а не весь стек.',
  },
  {
    id: 'autoconfig',
    title: 'Автонастройка почтовых программ',
    note:
      'То, что получают мастера настройки Thunderbird, Outlook и Apple Mail. Значения ' +
      'читает отдельная служба из своего окружения, поэтому применяются они ' +
      'пересозданием её контейнера — на приём и доставку почты это не влияет никак.',
  },
  {
    id: 'infra',
    title: 'Устройство стека',
    note:
      'Показано для справки. Из панели не меняется: это адреса, порты и секреты, ' +
      'смена которых означает пересоздание контейнеров и перевыпуск сертификатов.',
  },
];

/* ==================================================================== */
/* Группа live: читается при каждом обращении                            */
/* ==================================================================== */

const LIVE: readonly SettingSpec[] = [
  {
    key: 'ADMIN_SESSION_TTL_SECONDS',
    section: 'panel',
    group: 'live',
    kind: 'int',
    def: '28800',
    min: 60,
    max: 2_592_000,
    unit: 'seconds',
    description: 'Срок жизни сессии админки, секунды (по умолчанию 8 часов).',
  },
  {
    key: 'ADMIN_LOGIN_MAX_FAILURES',
    section: 'panel',
    group: 'live',
    kind: 'int',
    def: '5',
    min: 1,
    max: 100,
    unit: 'count',
    description:
      'Неудачных попыток входа подряд С ОДНОГО АДРЕСА до его блокировки. Блокируется адрес, ' +
      'а не учётная запись: иначе тот, кто знает логин, держал бы администратора запертым.',
  },
  {
    key: 'ADMIN_ACCOUNT_LOCK_FAILURES',
    section: 'panel',
    group: 'live',
    kind: 'int',
    def: '30',
    min: 5,
    max: 1000,
    unit: 'count',
    description:
      'Неудачных попыток по учётной записи со ВСЕХ адресов до её временной блокировки. ' +
      'Ловит подбор с множества адресов; порог заметно выше поадресного, потому что здесь ' +
      'складываются промахи всех, включая опечатки самого администратора. Адреса, с которых ' +
      'недавно входили успешно, под эту блокировку не попадают.',
  },
  {
    key: 'ADMIN_KNOWN_IP_DAYS',
    section: 'panel',
    group: 'live',
    kind: 'int',
    def: '30',
    min: 1,
    max: 365,
    unit: 'days',
    description:
      'Сколько суток адрес считается своим после удачного входа. С таких адресов вход ' +
      'принимается, даже когда учётная запись заперта подбором с чужих.',
  },
  {
    key: 'ADMIN_LOCKOUT_MINUTES',
    section: 'panel',
    group: 'live',
    kind: 'int',
    def: '15',
    min: 1,
    max: 1440,
    unit: 'minutes',
    description: 'На сколько минут блокируется вход после того, как попытки исчерпаны.',
  },
  {
    key: 'ADMIN_MAILBOX_TTL_SECONDS',
    section: 'panel',
    group: 'live',
    kind: 'int',
    def: '3600',
    min: 60,
    max: 86_400,
    unit: 'seconds',
    description: 'Срок сеанса входа администратора в чужой ящик, секунды.',
  },
  {
    key: 'ADMIN_DEFAULT_QUOTA_BYTES',
    section: 'mailboxes',
    group: 'live',
    kind: 'int',
    def: '1073741824',
    min: 0,
    unit: 'bytes',
    description: 'Квота нового ящика по умолчанию, байт (1 ГиБ). 0 — без ограничения.',
  },
  {
    key: 'ADMIN_MAILBOX_PURGE_DELAY_MINUTES',
    section: 'mailboxes',
    group: 'live',
    kind: 'int',
    def: '0',
    min: 0,
    max: 43_200,
    unit: 'minutes',
    description:
      'Карантин каталога удалённого ящика до физического удаления, минуты. 0 — удалять сразу. ' +
      'Ненулевое значение даёт время передумать: письма из Maildir не восстанавливаются ' +
      'ничем, кроме резервной копии.',
  },
  {
    key: 'MAIL_FLOW_RETENTION_DAYS',
    section: 'flow',
    group: 'live',
    kind: 'int',
    def: '14',
    min: 0,
    max: 3650,
    unit: 'days',
    description:
      'Сколько дней хранить разобранную историю доставки (mail_flow_events). Источник — ' +
      'журнал Postfix, другого источника нет: сам Postfix историю обработанных писем ' +
      'нигде не держит.',
  },
  {
    key: 'MAIL_FLOW_MAX_ROWS',
    section: 'flow',
    group: 'live',
    kind: 'int',
    def: '500000',
    min: 0,
    max: 100_000_000,
    unit: 'rows',
    description:
      'Верхний предел числа записей истории доставки: защита от того, что ночная рассылка ' +
      'заполнит диск. Старые вытесняются, даже если срок ещё не вышел.',
  },
  {
    key: 'MAIL_METRICS_RETENTION_DAYS',
    section: 'flow',
    group: 'live',
    kind: 'int',
    def: '7',
    min: 0,
    max: 3650,
    unit: 'days',
    description: 'Сколько суток хранить снимки показателей сервера для графиков дашборда.',
  },
  {
    key: 'MAIL_METRICS_MAX_ROWS',
    section: 'flow',
    group: 'live',
    kind: 'int',
    def: '50000',
    min: 0,
    max: 10_000_000,
    unit: 'rows',
    description: 'Потолок числа снимков показателей — второй предел, как у истории доставки.',
  },
  {
    key: 'MAIL_PUBLIC_IPV4',
    section: 'dns',
    group: 'live',
    kind: 'string',
    def: '',
    allowEmpty: true,
    description:
      'Публичный адрес сервера (IPv4). По нему панель проверяет обратную запись PTR — ту, ' +
      'без которой крупные почтовые службы отбивают письма ещё на подключении. Заполнять ' +
      'нужно, только если сервер за NAT и внешняя служба ошиблась. Пусто — проверка PTR ' +
      'опирается на A-запись почтового хоста.',
  },
  {
    key: 'DNS_CHECK_RESOLVERS',
    section: 'dns',
    group: 'live',
    kind: 'string',
    def: '',
    allowEmpty: true,
    description:
      'У кого спрашивать DNS при проверке публикации записей, через запятую. НЕ у своего ' +
      'unbound: тот резольвер наш, и проверка показала бы то, что мы сами себе прописали, ' +
      'а вопрос стоит «видит ли наши записи остальной интернет». Пусто — публичные ' +
      'резольверы по умолчанию.',
  },
];

/* ==================================================================== */
/* Группа restart: читается один раз при старте сервера приложения       */
/* ==================================================================== */

/*
 * Поле `applies` каждой из них — «перезапустить сервер приложения», и
 * проставляется оно ниже разом, а не переписывается полсотни раз руками.
 * Ручная простановка означала бы, что рано или поздно у одной настройки
 * её забудут, панель не покажет рядом с ней кнопку, и человек снова
 * пойдёт в консоль — ровно за тем, ради чего всё это делалось.
 */
const RESTART_SPECS: readonly SettingSpec[] = [
  {
    key: 'ADMIN_SESSION_COOKIE_NAME',
    section: 'panel',
    group: 'restart',
    kind: 'string',
    def: 'mt_admin',
    description:
      'Имя cookie админской сессии. Смена разлогинивает всех, кто вошёл: выданные cookie ' +
      'называются по-старому и перестают опознаваться.',
  },
  {
    key: 'ADMIN_JANITOR_INTERVAL_SECONDS',
    section: 'mailboxes',
    group: 'restart',
    kind: 'int',
    def: '60',
    min: 0,
    max: 86_400,
    unit: 'seconds',
    description:
      'Как часто просыпается уборщик (карантин удалённых ящиков, брошенные сеансы входа ' +
      'в чужой ящик, просроченные задания импорта), секунды. 0 — не запускать.',
  },
  {
    key: 'MAIL_FLOW_INTERVAL_SECONDS',
    section: 'flow',
    group: 'restart',
    kind: 'int',
    def: '5',
    min: 0,
    max: 3600,
    unit: 'seconds',
    description:
      'Как часто сборщик заглядывает в журнал Postfix, секунды. 0 — не собирать вовсе ' +
      '(раздел «Почтовый поток» останется пустым).',
  },
  {
    key: 'MAIL_METRICS_INTERVAL_SECONDS',
    section: 'flow',
    group: 'restart',
    kind: 'int',
    def: '60',
    min: 0,
    max: 3600,
    unit: 'seconds',
    description:
      'Как часто снимать показатели сервера, секунды. 0 — не снимать вовсе. Внешнего ' +
      'сборщика в стеке нет: снимки складывает сам сервер приложения.',
  },

  /* --- почта: сессии, пределы, частота --------------------------------- */
  {
    key: 'SESSION_TTL_SECONDS',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '604800',
    min: 60,
    unit: 'seconds',
    description: 'Срок жизни сессии почты, секунды (по умолчанию 7 суток).',
  },
  {
    key: 'SESSION_COOKIE_NAME',
    section: 'web',
    group: 'restart',
    kind: 'string',
    def: 'mt_session',
    description: 'Имя cookie почтовой сессии. Смена разлогинивает всех, кто вошёл в почту.',
  },
  {
    key: 'RATE_LIMIT_MAX',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '300',
    min: 1,
    unit: 'count',
    description: 'Ограничение частоты запросов: сколько запросов с одного адреса за окно.',
  },
  {
    key: 'RATE_LIMIT_WINDOW_MS',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '60000',
    min: 1000,
    unit: 'ms',
    description: 'Длина окна ограничения частоты запросов, мс.',
  },
  {
    key: 'UPLOAD_MAX_BYTES',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '26214400',
    min: 1024,
    unit: 'bytes',
    description:
      'Предел размера загружаемого вложения, байт (25 МиБ). Действующий предел выводится ' +
      'из предела письма с поправкой на рост при кодировании: файл, который заведомо не ' +
      'пролезет в письмо, принимать незачем.',
  },
  {
    key: 'MESSAGE_MAX_BYTES',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '26214400',
    min: 1024,
    unit: 'bytes',
    description:
      'Предел размера письма, байт. ОБЯЗАН совпадать с message_size_limit в ' +
      'infra/postfix/conf/main.cf.template — иначе письмо, принятое веб-интерфейсом, ' +
      'отобьёт наш же Postfix, и человек увидит отбойник на письмо, которое интерфейс ' +
      'только что принял.',
  },
  {
    key: 'COMPOSE_BODY_MAX_BYTES',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '12582912',
    min: 65_536,
    unit: 'bytes',
    description:
      'Предел тела JSON при написании письма, байт (12 МиБ). Связан с потолком кучи Node: ' +
      'разбор запроса держит в памяти несколько его копий сразу, поэтому запас берётся ' +
      'кратный, а не впритык.',
  },
  {
    key: 'IMAP_POOL_IDLE_MS',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '300000',
    min: 1000,
    unit: 'ms',
    description: 'Сколько простаивает IMAP-соединение в пуле до закрытия, мс.',
  },
  {
    key: 'HEALTH_CACHE_MS',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '20000',
    min: 0,
    max: 60_000,
    unit: 'ms',
    description:
      'Срок годности готового ответа пробы состояния /healthz. Пробу дёргает и контейнер, ' +
      'и обратный прокси, и панель; с коротким сроком каждое обращение заново стучится ' +
      'в Dovecot и Postfix, а те записывают каждый стук — журналы почты забиваются ' +
      'отчётами системы о самой себе.',
  },
  {
    key: 'HEALTH_PROBE_TIMEOUT_MS',
    section: 'web',
    group: 'restart',
    kind: 'int',
    def: '3000',
    min: 100,
    max: 30_000,
    unit: 'ms',
    description:
      'Предел ожидания ОДНОЙ проверки внутри пробы состояния: зависшая служба обязана дать ' +
      'отрицательный ответ, а не подвесить пробу.',
  },
  {
    key: 'COOKIE_SECURE',
    section: 'web',
    group: 'restart',
    kind: 'bool',
    def: 'false',
    description:
      'Отдавать ли cookie только по HTTPS. На боевом сервере — да (install/compose.prod.yml ' +
      'выставляет это сам), на dev-стенде нет. Включение на сервере без HTTPS означает, что ' +
      'войти не сможет никто: браузер просто не вернёт cookie.',
  },
  {
    key: 'TLS_REJECT_UNAUTHORIZED',
    section: 'web',
    group: 'restart',
    kind: 'bool',
    def: 'false',
    description:
      'Проверять сертификаты Dovecot/Postfix изнутри docker-сети. Выключено, когда ' +
      'сертификат выписан на внешнее имя, а не на имя контейнера.',
  },
  {
    key: 'TRUSTED_PROXIES',
    section: 'web',
    group: 'restart',
    kind: 'string',
    def: '127.0.0.1,::1,172.28.0.0/16',
    description:
      'Кому верить в заголовке X-Forwarded-For. Заголовок подставляет сам клиент, поэтому ' +
      'доверие «всем» означало бы обход ограничения частоты сменой заголовка и любой ' +
      'выдуманный адрес в журнале аудита. По умолчанию — петля и подсеть стека, где стоит nginx.',
  },
  {
    key: 'CORS_ORIGIN',
    section: 'web',
    group: 'restart',
    kind: 'string',
    def: 'http://localhost:5173,http://127.0.0.1:5173',
    description:
      'Разрешённые Origin для межсайтовых запросов. Нужны только режиму разработки ' +
      '(vite на 5173/5174): через nginx почта и API живут на одном имени хоста.',
  },
  {
    key: 'LOG_LEVEL',
    section: 'web',
    group: 'restart',
    kind: 'enum',
    def: 'info',
    options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    description:
      'Уровень журнала сервера приложения. В infra/.env эта же настройка называется ' +
      'API_LOG_LEVEL — так её перекладывает docker-compose.yml.',
  },

  /* --- правила фильтрации ---------------------------------------------- */
  {
    key: 'FILTER_APPLY_MAX_MESSAGES',
    section: 'filters',
    group: 'restart',
    kind: 'int',
    def: '5000',
    min: 1,
    max: 100_000,
    unit: 'count',
    description: 'Предел просмотра писем при «применить правило к уже полученным».',
  },
  {
    key: 'SIEVE_TRANSPORT',
    section: 'filters',
    group: 'restart',
    kind: 'enum',
    def: 'docker',
    options: ['local', 'docker', 'off'],
    description:
      'Как сервер приложения кладёт личный файл правил в почтовое хранилище: local — ' +
      'каталог хранилища примонтирован в контейнер (так в стеке); docker — хранилище ' +
      'внутри контейнера Dovecot (запуск API вне контейнера); off — не класть никуда ' +
      '(правила останутся только в базе).',
  },

  /* --- разделы владельца ящика ----------------------------------------- */
  {
    key: 'MAILBOX_ACCESS_LOG_DAYS',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '90',
    min: 1,
    max: 3650,
    unit: 'days',
    description:
      '«Вход и действия»: сколько дней хранить свои записи о входах через браузер. Входы ' +
      'по IMAP/POP3 и отправка читаются из журналов почтовых служб и живут ровно столько, ' +
      'сколько живут журналы.',
  },
  {
    key: 'DISPOSABLE_ALIAS_LIMIT',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '50',
    min: 1,
    max: 1000,
    unit: 'count',
    description:
      '«Одноразовые адреса»: сколько таких адресов может завести один ящик. Предел считает ' +
      'и ВЫКЛЮЧЕННЫЕ адреса: выключенный адрес обязан оставаться занятым, иначе имя заберёт ' +
      'другой человек и получит почту, которую магазин ещё шлёт на старый адрес.',
  },
  {
    key: 'MAILBOX_EXPORT_ENABLED',
    section: 'owner',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description:
      '«Выгрузка ящика»: собрать всю почту в ZIP-архив. Выключатель для закрытого контура: ' +
      'готовый архив — это копия всей переписки в открытом виде на диске сервера.',
  },
  {
    key: 'MAILBOX_EXPORT_TTL_HOURS',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '48',
    min: 1,
    max: 720,
    unit: 'hours',
    description:
      'Сколько часов живёт готовый архив, потом удаляется вместе с правом его скачать. ' +
      'Двое суток — «заказал вечером, скачал на следующий день».',
  },
  {
    key: 'MAILBOX_EXPORT_CONCURRENCY',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '1',
    min: 1,
    max: 8,
    unit: 'count',
    description:
      'Сколько выгрузок идёт одновременно на весь сервер. Одна: выгрузка грузит и Dovecot, ' +
      'и диск, и процессор, а две рядом не ускоряют ни одну.',
  },
  {
    key: 'MAILBOX_EXPORT_MAX_BYTES',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '21474836480',
    min: 1_048_576,
    unit: 'bytes',
    description:
      'Потолок размера архива в байтах (20 ГБ). Дойдя до него, задание останавливается ' +
      'с понятной причиной, а не заполняет диск.',
  },
  {
    key: 'MAILBOX_EXPORT_TICK_MS',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '5000',
    min: 1000,
    max: 600_000,
    unit: 'ms',
    description: 'Как часто работник выгрузки заглядывает в очередь заданий, мс.',
  },
  {
    key: 'TRASH_RECOVERY_MAX_DAYS',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '30',
    min: 0,
    max: 365,
    unit: 'days',
    description:
      '«Восстановление писем»: потолок срока хранения очищенной корзины. Сам срок в этих ' +
      'пределах выбирает владелец ящика — это его место.',
  },
  {
    key: 'TRASH_RECOVERY_TICK_MS',
    section: 'owner',
    group: 'restart',
    kind: 'int',
    def: '60000',
    min: 1000,
    max: 3_600_000,
    unit: 'ms',
    description: 'Как часто работник проверяет, чему из очищенного пора удаляться по-настоящему.',
  },

  /* --- уведомления при закрытой вкладке -------------------------------- */
  {
    key: 'PUSH_ENABLED',
    section: 'push',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description: 'Выключатель на весь сервер: выключено — подписки не выдаются вовсе.',
  },
  {
    key: 'PUSH_CONTACT',
    section: 'push',
    group: 'restart',
    kind: 'string',
    def: '',
    allowEmpty: true,
    description:
      'Контакт администратора для службы доставки уведомлений (RFC 8292): mailto: или ' +
      'https:. Пусто — postmaster@<почтовый домен>.',
  },
  {
    key: 'PUSH_TIMEOUT_MS',
    section: 'push',
    group: 'restart',
    kind: 'int',
    def: '10000',
    min: 500,
    max: 60_000,
    unit: 'ms',
    description: 'Предел ожидания ответа службы доставки уведомлений, мс.',
  },
  {
    key: 'PUSH_TTL_SECONDS',
    section: 'push',
    group: 'restart',
    kind: 'int',
    def: '86400',
    min: 0,
    max: 2_592_000,
    unit: 'seconds',
    description: 'Сколько служба доставки хранит недоставленное уведомление, секунды.',
  },
  {
    key: 'PUSH_PENDING_MAX',
    section: 'push',
    group: 'restart',
    kind: 'int',
    def: '50',
    min: 1,
    max: 500,
    unit: 'count',
    description: 'Сколько непоказанных уведомлений держать в очереди на один ящик.',
  },
  {
    key: 'PUSH_PENDING_TTL_MS',
    section: 'push',
    group: 'restart',
    kind: 'int',
    def: '21600000',
    min: 60_000,
    max: 604_800_000,
    unit: 'ms',
    description: 'Сколько непоказанное уведомление живёт в очереди ящика, мс.',
  },

  /* --- логотипы отправителей ------------------------------------------- */
  {
    key: 'SENDER_LOGOS_ENABLED',
    section: 'logos',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description:
      'Единственная часть продукта, которая по своей работе ходит в интернет С СЕРВЕРА ' +
      '(браузер к чужим сайтам не обращается — иначе владелец сайта узнавал бы, что его ' +
      'письмо сейчас читают). На закрытом контуре эти запросы недопустимы, поэтому ' +
      'выключатель обязан быть доступен.',
  },
  {
    key: 'SENDER_LOGO_DNS_TIMEOUT_MS',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '2500',
    min: 200,
    max: 15_000,
    unit: 'ms',
    description: 'Предел ожидания одного DNS-запроса (BIMI-запись), мс.',
  },
  {
    key: 'SENDER_LOGO_HTTP_TIMEOUT_MS',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '4000',
    min: 500,
    max: 30_000,
    unit: 'ms',
    description: 'Предел ожидания одного обращения по HTTPS за картинкой, мс.',
  },
  {
    key: 'SENDER_LOGO_WAIT_MS',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '3500',
    min: 0,
    max: 20_000,
    unit: 'ms',
    description:
      'Сколько запрос интерфейса ждёт ещё не найденные логотипы, прежде чем ответить ' +
      '«ещё ищем», мс. Открытие папки не должно ждать чужой сети.',
  },
  {
    key: 'SENDER_LOGO_CONCURRENCY',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '4',
    min: 1,
    max: 32,
    unit: 'count',
    description: 'Сколько поисков логотипа идёт наружу одновременно.',
  },
  {
    key: 'SENDER_LOGO_LOOKUPS_PER_MINUTE',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '60',
    min: 1,
    max: 10_000,
    unit: 'perMinute',
    description:
      'Сколько НОВЫХ доменов сервер соглашается искать за минуту (свой исходящий поток).',
  },
  {
    key: 'SENDER_LOGO_TTL_HOURS',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '720',
    min: 1,
    unit: 'hours',
    description: 'Срок годности кэша найденного логотипа, часы (по умолчанию 30 суток).',
  },
  {
    key: 'SENDER_LOGO_MISS_TTL_HOURS',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '168',
    min: 1,
    unit: 'hours',
    description:
      'Срок годности ответа «логотипа нет», часы (7 суток). Нужен отдельно: без него каждое ' +
      'открытие папки дёргало бы DNS по доменам, у которых логотипа нет и не будет.',
  },
  {
    key: 'SENDER_LOGO_ERROR_TTL_HOURS',
    section: 'logos',
    group: 'restart',
    kind: 'int',
    def: '6',
    min: 1,
    unit: 'hours',
    description: 'Пауза после ошибки связи, часы: столько домен не переспрашивается.',
  },

  /* --- помощник ИИ ------------------------------------------------------ */
  {
    key: 'AI_ENABLED',
    section: 'ai',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description:
      'Общий выключатель помощника на весь сервер. Какой сервис и с каким ключом — ' +
      'настройка в разделе «Помощник ИИ», а не здесь.',
  },
  {
    key: 'AI_SETTINGS_CACHE_MS',
    section: 'ai',
    group: 'restart',
    kind: 'int',
    def: '15000',
    min: 0,
    max: 600_000,
    unit: 'ms',
    description: 'Сколько держать настройки домена в памяти, не перечитывая базу, мс.',
  },
  {
    key: 'AI_REDIS_PREFIX',
    section: 'ai',
    group: 'restart',
    kind: 'string',
    def: 'mt:ai:',
    description:
      'Префикс ключей ИИ в Redis (кэш результатов и учёт расходов). Смена обнуляет учёт ' +
      'расходов текущего периода: он ведётся по ключам со старым префиксом.',
  },

  /* --- чужие ящики и сбор почты ---------------------------------------- */
  {
    key: 'EXTERNAL_ACCOUNTS_ENABLED',
    section: 'external',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description: 'Выключатель раздела «чужие ящики» на весь сервер.',
  },
  {
    key: 'COLLECTOR_SCHEDULER',
    section: 'external',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description: 'Планировщик сбора: выключено — не забирать почту по расписанию.',
  },
  {
    key: 'COLLECTOR_TICK_MS',
    section: 'external',
    group: 'restart',
    kind: 'int',
    def: '60000',
    min: 5000,
    max: 3_600_000,
    unit: 'ms',
    description: 'Как часто планировщик проверяет, кому пора забирать почту, мс.',
  },
  {
    key: 'COLLECTOR_CONCURRENCY',
    section: 'external',
    group: 'restart',
    kind: 'int',
    def: '2',
    min: 1,
    max: 16,
    unit: 'count',
    description:
      'Сколько сборов идёт одновременно. Немного — с той стороны чужой сервер, ' +
      'обслуживающий живых людей.',
  },
  {
    key: 'COLLECTOR_BATCH_SIZE',
    section: 'external',
    group: 'restart',
    kind: 'int',
    def: '50',
    min: 1,
    max: 1000,
    unit: 'count',
    description: 'Сколько писем максимум забирать за один запуск сбора.',
  },
  {
    key: 'COLLECTOR_TIMEOUT_MS',
    section: 'external',
    group: 'restart',
    kind: 'int',
    def: '600000',
    min: 10_000,
    max: 3_600_000,
    unit: 'ms',
    description: 'Предел на один сбор, мс (по умолчанию 10 минут).',
  },
  {
    key: 'COLLECTOR_STALE_MINUTES',
    section: 'external',
    group: 'restart',
    kind: 'int',
    def: '30',
    min: 1,
    max: 1440,
    unit: 'minutes',
    description:
      'Срок, после которого пометка «идёт сбор» считается брошенной, минуты. Нужен из-за ' +
      'перезапуска: пометка о начале остаётся в базе, и без срока давности ящик залипал бы ' +
      'в состоянии «собирается» навсегда.',
  },
  {
    key: 'AUTODETECT_NETWORK',
    section: 'external',
    group: 'restart',
    kind: 'bool',
    def: 'true',
    description:
      'Автоопределение настроек чужого сервера по адресу ящика: ходить ли при этом в сеть ' +
      '(HTTP/DNS). На закрытом контуре — выключить.',
  },
  {
    key: 'AUTODETECT_TIMEOUT_MS',
    section: 'external',
    group: 'restart',
    kind: 'int',
    def: '4000',
    min: 200,
    max: 30_000,
    unit: 'ms',
    description: 'Предел ожидания одной попытки автоопределения, мс.',
  },

  /* --- перенос почты ---------------------------------------------------- */
  {
    key: 'MIGRATION_CONCURRENCY',
    section: 'migration',
    group: 'restart',
    kind: 'int',
    def: '2',
    min: 1,
    max: 16,
    unit: 'count',
    description:
      'Сколько ящиков переносить одновременно. Два, а не «сколько потянет»: с той стороны ' +
      'чужой почтовый сервер, который в это же время обслуживает живых людей.',
  },
  {
    key: 'MIGRATION_MAX_HOURS',
    section: 'migration',
    group: 'restart',
    kind: 'int',
    def: '48',
    min: 1,
    max: 720,
    unit: 'hours',
    description:
      'Через сколько часов брошенное задание сдаётся. Срок про ПАРОЛИ: они лежат ' +
      'зашифрованными ровно пока идёт задание, и брошенное задание должно когда-то ' +
      'сдаться, а не хранить их бессрочно.',
  },
];

const RESTART: readonly SettingSpec[] = RESTART_SPECS.map((spec) => ({
  ...spec,
  applies: spec.applies ?? APPLY_API,
}));

/* ==================================================================== */
/* Группа recreate: значение читает ДРУГОЙ контейнер                     */
/* ==================================================================== */
/*
 * Все ключи ниже до появления посредника стояли в группе locked с
 * пояснением «значение читает другой контейнер, до его окружения панель
 * не дотягивается». Это было честно и было тупиком: включить антивирус
 * или поменять имя продукта в мастерах настройки Thunderbird можно было
 * только по SSH.
 *
 * Теперь дотянуться можно — но именно ПЕРЕСОЗДАНИЕМ, и это не формальность.
 * Значение попадёт в новый контейнер только через infra/.env, потому что
 * оттуда его берёт compose при создании. Поэтому у каждого ключа здесь
 * есть двойник в списке разрешённых к записи ключей посредника
 * (%ENV_KEYS в infra/service-agent/agent.pl), свой для каждой службы:
 * записать POSTGRES_PASSWORD «через autoconfig» посредник не даст, такого
 * ключа в его списке нет.
 */

/** Пересоздать службу автонастройки. */
const APPLY_AUTOCONFIG: readonly SettingApply[] = [{ target: 'autoconfig', action: 'recreate' }];

const RECREATE: readonly SettingSpec[] = [
  /* --- антивирус --- */
  {
    key: 'CLAMAV_ENABLED',
    section: 'services',
    group: 'recreate',
    kind: 'bool',
    def: 'false',
    applies: [{ target: 'rspamd', action: 'recreate' }],
    description:
      'Проверять вложения антивирусом ClamAV. Выключен по умолчанию: clamd с полными ' +
      'базами занимает ~1.2 ГБ памяти — больше половины VPS на 2 ГБ. ' +
      'ВАЖНО: сам контейнер антивируса живёт под отдельным профилем, и одного ' +
      'включения здесь мало — его нужно поднять командой ' +
      '«docker compose -f infra/docker-compose.yml --profile clamav up -d clamav». ' +
      'Пока он не поднят, rspamd пишет в журнал, что антивирус недоступен, и пропускает ' +
      'письма без проверки (fail-open): почта не останавливается никогда.',
  },

  /* --- свой резольвер --- */
  {
    key: 'UNBOUND_LOG_QUERIES',
    section: 'services',
    group: 'recreate',
    kind: 'bool',
    def: 'false',
    applies: [{ target: 'unbound', action: 'recreate' }],
    description:
      'Записывать каждый DNS-запрос своего резольвера. Нужно, когда разбираются, ' +
      'уходит ли запрос к спискам репутации. На боевом сервере держать выключенным: ' +
      'журнал растёт очень быстро.',
  },
  {
    key: 'UNBOUND_DNSSEC',
    section: 'services',
    group: 'recreate',
    kind: 'bool',
    def: 'true',
    applies: [{ target: 'unbound', action: 'recreate' }],
    description:
      'Проверять подписи DNSSEC у ответов. Выключать стоит только в закрытом контуре ' +
      'со своим DNS, который подписей не ставит: без проверки ответ DNS можно подделать, ' +
      'а на ответах DNS держатся SPF, DKIM и DMARC.',
  },

  /* --- Dovecot --- */
  {
    key: 'DOVECOT_DISABLE_PLAINTEXT_AUTH',
    section: 'services',
    group: 'recreate',
    kind: 'bool',
    def: 'true',
    applies: [{ target: 'dovecot', action: 'recreate' }],
    description:
      'Не принимать пароль по нешифрованному соединению. Правильное боевое значение — ' +
      'включено. Выключение означает, что пароль почтового ящика может уйти по сети ' +
      'открытым текстом; допустимо только в закрытом контуре и только временно.',
  },

  /* --- автонастройка почтовых программ --- */
  {
    key: 'PROVIDER_NAME',
    section: 'autoconfig',
    group: 'recreate',
    kind: 'string',
    def: 'Mail.True',
    /*
     * Два шага, и оба нужны. Имя показывает мастер настройки Thunderbird
     * (его отдаёт autoconfig из своего окружения) и панель в подсказках
     * «настроить почтовую программу» (его читает сервер приложения, и ему
     * хватает перезапуска: значение он берёт из базы, а не из .env).
     */
    applies: [
      { target: 'autoconfig', action: 'recreate' },
      { target: 'api', action: 'restart' },
    ],
    description:
      'Имя продукта в мастерах настройки Thunderbird, Outlook и Apple Mail — то, что ' +
      'человек видит, подключая почту. Меняется при продаже установки под своей маркой.',
  },
  {
    key: 'PROVIDER_SHORT_NAME',
    section: 'autoconfig',
    group: 'recreate',
    kind: 'string',
    def: 'Mail.True',
    applies: APPLY_AUTOCONFIG,
    description: 'Короткое имя продукта там же, где не помещается полное.',
  },
  {
    key: 'AUTOCONFIG_LOG_LEVEL',
    section: 'autoconfig',
    group: 'recreate',
    kind: 'enum',
    def: 'info',
    options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    applies: APPLY_AUTOCONFIG,
    description:
      'Уровень журнала службы автонастройки. debug нужен, когда разбираются, почему ' +
      'почтовая программа не находит настройки сама.',
  },
  {
    key: 'DMARC_RUA',
    section: 'autoconfig',
    group: 'recreate',
    kind: 'string',
    def: '',
    allowEmpty: true,
    applies: APPLY_AUTOCONFIG,
    description:
      'Адрес для отчётов DMARC в рекомендуемых DNS-записях (запись _dmarc, поле rua). ' +
      'Пусто — postmaster@<почтовый домен>. Меняет только ПОДСКАЗКУ: саму DNS-запись ' +
      'правит тот, кто держит зону домена.',
  },
  {
    key: 'DNS_TTL',
    section: 'autoconfig',
    group: 'recreate',
    kind: 'int',
    def: '3600',
    min: 60,
    max: 604_800,
    unit: 'seconds',
    applies: APPLY_AUTOCONFIG,
    description:
      'TTL в рекомендуемых DNS-записях, секунды. Меньшее значение стоит поставить перед ' +
      'переездом сервера, чтобы записи разошлись быстрее.',
  },

  /* --- анонсируемые порты ---------------------------------------------
   * Это НЕ порты публикации: менять их нужно, только если почта
   * действительно вынесена на нестандартные порты. Три из шести читает
   * ещё и сервер приложения (compose перекладывает их в IMAPS_PORT,
   * SUBMISSION_PORT и POP3S_PORT) — он подсказывает те же порты в
   * SRV-записях раздела «Домены». Ему нужен не перезапуск, а тоже
   * пересоздание: имя ключа в его окружении ДРУГОЕ, и из базы он его не
   * получит.
   */
  ...(
    [
      ['AUTOCONFIG_IMAPS_PORT', '993', 'IMAPS (шифрование сразу).', true],
      ['AUTOCONFIG_IMAP_STARTTLS_PORT', '143', 'IMAP со STARTTLS.', false],
      ['AUTOCONFIG_POP3S_PORT', '995', 'POP3S (шифрование сразу).', true],
      ['AUTOCONFIG_POP3_STARTTLS_PORT', '110', 'POP3 со STARTTLS.', false],
      ['AUTOCONFIG_SUBMISSION_PORT', '587', 'Отправка со STARTTLS (submission).', true],
      ['AUTOCONFIG_SUBMISSIONS_PORT', '465', 'Отправка с шифрованием сразу (submissions).', false],
    ] as const
  ).map(([key, def, what, alsoApi]): SettingSpec => ({
    key,
    section: 'autoconfig',
    group: 'recreate',
    kind: 'int',
    def,
    min: 1,
    max: 65_535,
    applies: alsoApi
      ? [
          { target: 'autoconfig', action: 'recreate' },
          { target: 'api', action: 'recreate' },
        ]
      : APPLY_AUTOCONFIG,
    description:
      `АНОНСИРУЕМЫЙ порт, который называют почтовым программам: ${what} Это не порт ` +
      'публикации — тот задаётся при создании стека. Менять нужно, только если почта ' +
      'действительно вынесена на нестандартные порты, иначе почтовые программы получат ' +
      'настройку, по которой не подключатся.',
  })),
];

/* ==================================================================== */
/* Группа locked: из панели не меняется                                  */
/* ==================================================================== */

/** Причины, повторяющиеся у многих ключей: пишем один раз. */
const REASON_COMPOSE =
  'Читается самим docker compose при создании контейнеров. Смена значения означает ' +
  'пересоздание стека, а не перезапуск, — правится в infra/.env на машине сервера.';
/*
 * Причины «значение читает другой контейнер» здесь больше нет — и это
 * не потеря, а весь смысл затеи. Раньше ею были помечены полтора
 * десятка ключей, и означала она тупик: до окружения чужого контейнера
 * панель не дотягивалась, поэтому включить антивирус или поменять имя
 * продукта в мастерах настройки можно было только по SSH. Теперь такие
 * ключи стоят в группе recreate и применяются пересозданием нужной
 * службы через посредника.
 */
const REASON_SECRET =
  'Секрет. В базу, доступ к которой этим же секретом и защищён, он не кладётся, ' +
  'и наружу не отдаётся ни в каком виде.';
const REASON_LAYOUT =
  'Устройство стека, а не настройка: точка монтирования тома или имя сервиса внутри ' +
  'docker-сети. Обязано совпадать с конфигурацией соответствующего контейнера.';

function locked(
  key: string,
  section: string,
  kind: SettingKind,
  def: string,
  description: string,
  reason: string,
  secret = false,
): SettingSpec {
  return {
    key,
    section,
    group: 'locked',
    kind,
    def,
    description,
    reason,
    secret,
    allowEmpty: true,
  };
}

const LOCKED: readonly SettingSpec[] = [
  /* --- домен и адреса --- */
  locked(
    'MAIL_DOMAIN',
    'infra',
    'string',
    'mail.local',
    'Основной почтовый домен.',
    'Домен зашит в сертификаты, в конфигурацию Postfix и Dovecot и в DKIM-подпись. ' +
      'Смена означает перевыпуск сертификатов и пересоздание контейнеров, а не правку поля.',
  ),
  locked(
    'MAIL_HOSTNAME',
    'infra',
    'string',
    'mail.local',
    'Hostname почтового сервера — им он представляется в SMTP и на него выписан сертификат.',
    'То же, что и с доменом: имя стоит в сертификате и в конфигурации почтовых служб.',
  ),
  locked(
    'COMPOSE_PROJECT_NAME',
    'infra',
    'string',
    'mailtrue',
    'Имя проекта Docker Compose: задаёт имена контейнеров, томов и сети.',
    REASON_COMPOSE,
  ),
  locked(
    'DOCKER_SUBNET',
    'infra',
    'string',
    '172.28.0.0/16',
    'Подсеть docker-сети стека.',
    REASON_COMPOSE,
  ),
  // Умолчание пустое, а не 172.28.0.53: пустым его видит сервер приложения,
  // если docker-compose.yml не подставил своё. Само 172.28.0.53 — умолчание
  // COMPOSE, и писать его сюда значило бы показывать в панели значение,
  // которого у процесса может не быть.
  locked(
    'RESOLVER_IP',
    'infra',
    'string',
    '',
    'Фиксированный адрес своего резольвера (unbound) в подсети стека. ' +
      'Умолчание стека — 172.28.0.53.',
    REASON_COMPOSE,
  ),
  locked(
    'DOVECOT_IP',
    'infra',
    'string',
    '172.28.0.54',
    'Фиксированный адрес Dovecot: Postfix отдаёт почту по адресу, а не по имени.',
    REASON_COMPOSE,
  ),
  {
    key: 'BIND_ADDRESS',
    section: 'infra',
    group: 'recreate',
    kind: 'string',
    def: '0.0.0.0',
    description:
      'На каком адресе публиковать почтовые порты. 0.0.0.0 — на всех адресах машины; ' +
      'конкретный адрес нужен, когда адресов несколько и почта должна жить только на одном. ' +
      'Порты перепубликуются, поэтому контейнеры пересоздаются — приём и отправка встают ' +
      'на несколько секунд.',
    applies: [
      { target: 'postfix', action: 'recreate' },
      { target: 'dovecot', action: 'recreate' },
      { target: 'nginx', action: 'recreate' },
    ],
  },

  /* --- порты публикации --- */
  ...(
    [
      /*
       * ВНИМАНИЕ, ловушка имени: у SMTP_PORT два разных смысла.
       * В infra/.env это порт ПУБЛИКАЦИИ приёма почты (25), а в окружении
       * контейнера api — порт, КУДА сервер приложения отдаёт письма
       * Postfix (587, submission). Здесь описан второй: перечень говорит
       * о том, что читает сервер приложения, и его умолчание — 587.
       */
      [
        'SMTP_PORT',
        '587',
        'Порт, на который сервер приложения отдаёт письма Postfix (submission). ' +
          'В infra/.env тем же именем назван порт публикации приёма почты — 25.',
      ],
      ['SUBMISSION_PORT', '587', 'Порт публикации submission (отправка с STARTTLS).'],
      ['SUBMISSIONS_PORT', '465', 'Порт публикации submissions («TLS сразу»).'],
      ['IMAP_PORT', '143', 'Порт публикации IMAP.'],
      ['IMAPS_PORT', '993', 'Порт публикации IMAPS.'],
      ['POP3_PORT', '110', 'Порт публикации POP3.'],
      ['POP3S_PORT', '995', 'Порт публикации POP3S.'],
      ['NGINX_HTTP_PORT', '8080', 'Порт публикации nginx (HTTP).'],
      ['NGINX_HTTPS_PORT', '8443', 'Порт публикации nginx (HTTPS).'],
      ['API_PORT', '3000', 'Прямой порт сервера приложения на localhost — только для отладки.'],
      ['AUTOCONFIG_PORT', '8025', 'Прямой порт сервиса автонастройки — только для отладки.'],
      ['QUEUE_AGENT_PORT', '11345', 'Порт посредника к очереди Postfix внутри сети стека.'],
      ['POSTGRES_PORT', '5432', 'Порт публикации Postgres на хост.'],
      ['REDIS_PORT', '6380', 'Порт публикации Redis на хост.'],
      ['RSPAMD_WEB_PORT', '11334', 'Порт публикации веб-интерфейса rspamd на хост.'],
    ] as const
  ).map(([key, def, description]) => locked(key, 'infra', 'int', def, description, REASON_COMPOSE)),

  /*
   * Анонсируемые порты автонастройки, имя продукта, уровень её журнала,
   * адрес отчётов DMARC и TTL подсказок переехали отсюда в группу
   * recreate: до появления посредника до окружения службы автонастройки
   * было не дотянуться, теперь можно — пересозданием её контейнера.
   */

  /* --- чужие контейнеры --- */
  locked(
    'DKIM_SELECTOR',
    'infra',
    'string',
    'mail',
    'DKIM-селектор (DNS-запись <селектор>._domainkey.<домен>).',
    'Селектор стоит в опубликованной DNS-записи и в подписи каждого исходящего письма. ' +
      'Смена без перевыпуска ключа и правки DNS означает, что подпись перестают проверять.',
  ),
  /*
   * Антивирус, свой резольвер и приём пароля без шифрования тоже уехали
   * в группу recreate — по той же причине и тем же способом.
   */
  locked(
    'DOVECOT_MASTER_USER',
    'infra',
    'string',
    '',
    'Служебный (master) пользователь Dovecot — вход администратора в чужой ящик из панели ' +
      'без знания пароля владельца. Пустое значение выключает возможность полностью.',
    'Имя обязано совпадать с записью в базе паролей Dovecot: смена только в панели ' +
      'молча сломала бы вход администратора в чужой ящик.',
  ),
  locked(
    'DOVECOT_MASTER_SEPARATOR',
    'infra',
    'string',
    '*',
    'Разделитель служебного пользователя в логине «ящик*мастер».',
    'Обязан совпадать с auth_master_user_separator в конфигурации Dovecot, а там записана ' +
      'звёздочка без подстановки. Настройка здесь развела бы две стороны одного логина.',
  ),

  /* --- каталоги и точки монтирования --- */
  locked(
    'UPLOAD_DIR',
    'infra',
    'string',
    './data/uploads',
    'Временное хранилище загруженных вложений.',
    REASON_LAYOUT,
  ),
  locked(
    'BRANDING_DIR',
    'infra',
    'string',
    './data/branding',
    'Каталог своего оформления входа (логотип OEM и подписи).',
    REASON_LAYOUT,
  ),
  locked(
    'MAIL_LOG_DIR',
    'infra',
    'string',
    '/var/log/mail',
    'Каталог общего тома с журналами почтовых служб.',
    REASON_LAYOUT,
  ),
  locked(
    'ADMIN_MAIL_ROOT',
    'infra',
    'string',
    '/var/mail/vhosts',
    'Корень почтового хранилища — тот же, что у Dovecot.',
    REASON_LAYOUT,
  ),
  locked(
    'ADMIN_MAIL_INDEX_ROOT',
    'infra',
    'string',
    '/var/mail/index',
    'Каталог поисковых индексов Dovecot (отдельный том).',
    REASON_LAYOUT,
  ),
  locked(
    'MAILBOX_EXPORT_DIR',
    'infra',
    'string',
    '/srv/data/exports',
    'Куда класть готовые архивы выгрузки ящика.',
    REASON_LAYOUT,
  ),
  locked(
    'SIEVE_ROOT',
    'infra',
    'string',
    '/var/mail/vhosts',
    'Корень почтового хранилища для файла правил фильтрации.',
    REASON_LAYOUT,
  ),
  locked(
    'API_LOG_FILE',
    'infra',
    'string',
    '/var/log/mail/api.log',
    'Файл журнала сервера приложения в общем томе (его читает раздел «Журналы»).',
    REASON_LAYOUT,
  ),
  {
    key: 'API_NODE_OPTIONS',
    section: 'infra',
    group: 'recreate',
    kind: 'string',
    def: '--max-old-space-size=512',
    description:
      'Потолок кучи V8 у сервера приложения. По умолчанию 512 МБ — расчёт на VPS с 2 ГБ. ' +
      'На машине с большим объёмом памяти его поднимают, когда сервер приложения упирается ' +
      'в потолок на больших ящиках. Значение читается процессом Node при запуске, до того ' +
      'как появится код, способный сходить в базу, — поэтому контейнер пересоздаётся.',
    applies: [{ target: 'api', action: 'recreate' }],
  },
  locked(
    'POSTGRES_DB',
    'infra',
    'string',
    'mailserver',
    'Имя базы почтового стека.',
    REASON_COMPOSE,
  ),
  locked(
    'POSTGRES_USER',
    'infra',
    'string',
    'mailserver',
    'Пользователь базы почтового стека.',
    REASON_COMPOSE,
  ),

  /* --- секреты: значение не выводится никогда --- */
  locked('POSTGRES_PASSWORD', 'infra', 'string', '', 'Пароль базы.', REASON_SECRET, true),
  locked('REDIS_PASSWORD', 'infra', 'string', '', 'Пароль Redis.', REASON_SECRET, true),
  locked(
    'RSPAMD_PASSWORD',
    'infra',
    'string',
    '',
    'Пароль контроллера rspamd.',
    REASON_SECRET,
    true,
  ),
  locked(
    'SESSION_SECRET',
    'infra',
    'string',
    '',
    'Подпись cookie почты и шифрование пароля в сессии.',
    REASON_SECRET,
    true,
  ),
  locked(
    'ADMIN_SESSION_SECRET',
    'infra',
    'string',
    '',
    'То же для сессии панели.',
    REASON_SECRET,
    true,
  ),
  locked(
    'AI_ENCRYPTION_KEY',
    'infra',
    'string',
    '',
    'Шифрование ключей доступа к сервисам ИИ.',
    REASON_SECRET,
    true,
  ),
  locked(
    'EXTERNAL_ACCOUNTS_KEY',
    'infra',
    'string',
    '',
    'Шифрование паролей чужих ящиков (сбор почты).',
    REASON_SECRET,
    true,
  ),
  locked(
    'DOVECOT_MASTER_PASSWORD',
    'infra',
    'string',
    '',
    'Пароль служебного пользователя Dovecot.',
    REASON_SECRET,
    true,
  ),
  locked(
    'QUEUE_AGENT_TOKEN',
    'infra',
    'string',
    '',
    'Общий секрет между сервером приложения и посредником к очереди Postfix. Пустое ' +
      'значение выключает раздел «Очередь» целиком.',
    REASON_SECRET,
    true,
  ),
  locked(
    'PUSH_VAPID_PUBLIC_KEY',
    'infra',
    'string',
    '',
    'Открытый ключ VAPID. Сервер генерирует пару сам при первом запуске и хранит в базе.',
    'Смена ключей обесценивает ВСЕ выданные браузерам подписки, и людям придётся ' +
      'разрешать уведомления заново. Задавать их нужно ровно в одном случае — при ' +
      'переносе установки на другой сервер.',
  ),
  locked(
    'PUSH_VAPID_PRIVATE_KEY',
    'infra',
    'string',
    '',
    'Закрытый ключ VAPID.',
    REASON_SECRET,
    true,
  ),
];

/** Полный перечень настроек. */
export const SETTING_SPECS: readonly SettingSpec[] = [...LIVE, ...RESTART, ...RECREATE, ...LOCKED];

const BY_KEY = new Map<string, SettingSpec>(SETTING_SPECS.map((s) => [s.key, s]));

/** Описание настройки или undefined, если ключ неизвестен. */
export function findSetting(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

/** Ключи, которые вообще разрешено хранить в базе (live + restart). */
export const EDITABLE_KEYS: readonly string[] = SETTING_SPECS.filter(
  (s) => s.group !== 'locked',
).map((s) => s.key);

const EDITABLE = new Set(EDITABLE_KEYS);

/** Можно ли эту настройку менять из панели. */
export function isEditable(key: string): boolean {
  return EDITABLE.has(key);
}

/**
 * Настройки, которые применяет указанное действие над указанной службой.
 *
 * Нужно ровно в одном месте — при пересоздании контейнера: перед ним
 * значения обязаны попасть в infra/.env, иначе новый контейнер получит
 * прежнее окружение. Вопрос «какие именно значения» имеет ровно один
 * правильный ответ, и он записан здесь, рядом с самими настройками, а не
 * вторым списком где-нибудь в маршруте: второй список разошёлся бы с
 * первым при добавлении любой новой настройки.
 */
export function settingsAppliedBy(
  target: string,
  action: SettingApply['action'],
): readonly SettingSpec[] {
  return SETTING_SPECS.filter((spec) =>
    (spec.applies ?? []).some((a) => a.target === target && a.action === action),
  );
}

/** Все службы, которые вообще упоминаются в перечне как применяющие. */
export function appliedTargets(): readonly string[] {
  const seen = new Set<string>();
  for (const spec of SETTING_SPECS) {
    for (const apply of spec.applies ?? []) seen.add(apply.target);
  }
  return [...seen].sort();
}
