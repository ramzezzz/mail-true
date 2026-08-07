/**
 * Конфигурация админки. Отдельная от src/config.ts схема, чтобы админка
 * оставалась самостоятельным модулем: почтовый API работает и без неё.
 *
 * Переменные окружения (все со значениями по умолчанию, кроме базы):
 *
 *   ADMIN_DATABASE_URL / DATABASE_URL  подключение к Postgres почтового стека.
 *                                      Без него админские маршруты отвечают 503.
 *   ADMIN_SESSION_COOKIE_NAME          имя cookie админской сессии (mt_admin)
 *   ADMIN_SESSION_TTL_SECONDS          срок жизни админской сессии (8 часов)
 *   ADMIN_LOGIN_MAX_FAILURES           неудач подряд до блокировки (5)
 *   ADMIN_LOCKOUT_MINUTES              на сколько блокировать (15)
 *   DOVECOT_MASTER_USER                служебный пользователь Dovecot
 *   DOVECOT_MASTER_PASSWORD            его пароль
 *   DOVECOT_MASTER_SEPARATOR           разделитель auth_master_user_separator (*)
 *   ADMIN_MAILBOX_TTL_SECONDS          срок жизни сеанса входа в чужой ящик (1 час)
 *   MAIL_DOMAIN / MAIL_HOSTNAME        для подсказок DNS
 *   MAIL_PUBLIC_IPV4                   ожидаемый адрес сервера (проверка PTR/A)
 *   RSPAMD_HOST / RSPAMD_CONTROLLER_PORT / RSPAMD_PASSWORD
 *                                      антиспам и проверка подписи исходящих
 *   RESOLVER_IP                        свой резольвер (unbound) для сводки
 *   DNS_CHECK_RESOLVERS                у кого спрашивать DNS при проверке домена
 *   IMAPS_PORT / SUBMISSION_PORT / POP3S_PORT
 *                                      порты в SRV-записях автонастройки
 */
import { z } from 'zod';

const intVar = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const adminEnvSchema = z.object({
  ADMIN_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  ADMIN_SESSION_COOKIE_NAME: z.string().default('mt_admin'),
  ADMIN_SESSION_TTL_SECONDS: intVar(8 * 3600, 60),
  ADMIN_LOGIN_MAX_FAILURES: intVar(5, 1),
  ADMIN_LOCKOUT_MINUTES: intVar(15, 1),

  DOVECOT_MASTER_USER: z.string().default(''),
  DOVECOT_MASTER_PASSWORD: z.string().default(''),
  DOVECOT_MASTER_SEPARATOR: z.string().min(1).max(1).default('*'),
  ADMIN_MAILBOX_TTL_SECONDS: intVar(3600, 60),

  MAIL_DOMAIN: z.string().default('mail.local'),
  MAIL_HOSTNAME: z.string().default('mail.local'),
  MAIL_PUBLIC_IPV4: z.string().default(''),

  /**
   * Антиспам и свой резольвер — для сводки состояния. Ни то, ни другое
   * не мешает почте ходить при отказе, поэтому в пробу контейнера они не
   * входят; зато отказ каждого не виден больше нигде (см. admin/services.ts).
   * Пароль контроллера нужен только для проверки подписи исходящих:
   * без него проверяется лишь «жив ли rspamd».
   */
  RSPAMD_HOST: z.string().default('rspamd'),
  RSPAMD_CONTROLLER_PORT: intVar(11334, 1, 65535),
  RSPAMD_PASSWORD: z.string().default(''),
  RESOLVER_IP: z.string().default(''),

  /**
   * У кого спрашивать DNS при проверке домена (через запятую).
   *
   * НЕ у своего unbound и не у системного резольвера контейнера: вопрос
   * стоит «видит ли наши записи остальной интернет», а свой резольвер
   * покажет то, что мы сами себе прописали. Пусто — публичные резольверы
   * по умолчанию (см. PUBLIC_RESOLVERS в admin/dns.ts).
   */
  DNS_CHECK_RESOLVERS: z.string().default(''),

  /** Порты почтовых служб — в SRV-записи автонастройки. */
  IMAPS_PORT: intVar(993, 1, 65535),
  SUBMISSION_PORT: intVar(587, 1, 65535),
  POP3S_PORT: intVar(995, 1, 65535),

  /** Квота нового ящика по умолчанию, байт (1 ГиБ). */
  ADMIN_DEFAULT_QUOTA_BYTES: intVar(1024 * 1024 * 1024, 0),

  /**
   * Корень почтового хранилища — тот же, что у Dovecot
   * (mail_location = maildir:/var/mail/vhosts/%d/%n). Отсюда уборщик
   * забирает каталог удалённого ящика.
   */
  ADMIN_MAIL_ROOT: z.string().default('/var/mail/vhosts'),

  /**
   * Сколько каталог удалённого ящика лежит в карантине до физического
   * удаления. 0 — убрать при ближайшем проходе уборщика. Отсрочка нужна
   * только чтобы успеть передумать: доступа к почте она не возвращает,
   * каталог уже уведён из-под нового ящика с тем же адресом.
   */
  ADMIN_MAILBOX_PURGE_DELAY_MINUTES: intVar(0, 0, 43_200),

  /** Как часто просыпается уборщик. 0 — не запускать вовсе. */
  ADMIN_JANITOR_INTERVAL_SECONDS: intVar(60, 0, 86_400),

  /**
   * Каталог своего оформления входа (логотип OEM и подписи).
   *
   * Обязан лежать в ТОМЕ, а не внутри образа: требование звучит как
   * «логотип переживает перезапуск контейнеров», а каталог образа
   * исчезает при каждом обновлении продукта. Том — `api-branding`
   * в infra/docker-compose.yml, он же попадает в install/backup.sh.
   * Значение по умолчанию — для запуска из исходников без Docker.
   */
  BRANDING_DIR: z.string().default('./data/branding'),

  /**
   * Каталог TLS-сертификата сервера — тот же, что видят nginx, Postfix и
   * Dovecot (infra/data/certs). Отсюда раздел «Сертификат» читает, какой
   * сертификат стоит, и сюда же кладёт принесённый.
   *
   * Это устройство стека, а не настройка: путь обязан совпадать с точкой
   * монтирования в docker-compose.yml. Значение по умолчанию — для
   * запуска из исходников без Docker.
   */
  TLS_CERT_DIR: z.string().default('./infra/data/certs'),

  /**
   * Чем шифруется результат импорта (сгенерированные пароли).
   * Своего секрета у админки нет — берём админский, иначе почтовый.
   * Пустой означает «паролей не храним»: лучше отдать только счётчики,
   * чем положить пароль в базу открытым.
   */
  ADMIN_SESSION_SECRET: z.string().default(''),
  SESSION_SECRET: z.string().default(''),

  /* ----------------------------------------------------------------
   * Раздел «Почтовый поток»: очередь и журналы.
   *
   * Ни очередь, ни журналы служб не доступны серверу приложения сами по
   * себе. Сокет Docker — не вариант: он даёт права root на всей машине,
   * и платить эту цену за показ очереди нельзя. Поэтому:
   *
   *   очередь  — посредник ВНУТРИ контейнера postfix, рядом с очередью
   *              (infra/postfix/queue-agent.pl), общий секрет;
   *   журналы  — общий том, куда postfix, dovecot и сам сервер приложения
   *              пишут файлы (том maillogs в docker-compose.yml).
   *
   * Пустой MAIL_QUEUE_AGENT_URL или пустой QUEUE_AGENT_TOKEN означают
   * «очередь недоступна», и админка честно скажет это словами вместо
   * того, чтобы показать пустую таблицу.
   * ---------------------------------------------------------------- */
  MAIL_QUEUE_AGENT_URL: z.string().default(''),
  QUEUE_AGENT_TOKEN: z.string().default(''),

  /* ----------------------------------------------------------------
   * Посредник ПЕРЕЗАПУСКА служб (infra/service-agent/agent.pl).
   *
   * Второй посредник и вторая причина та же: перезапустить чужую службу
   * нельзя без доступа к Docker, а сокет Docker — это права root на всей
   * машине. Сервер приложения его не получает, поэтому просит ту
   * единственную службу, которой он выдан и которая умеет ровно две вещи
   * над закрытым списком служб.
   *
   * Пустой URL или пустой секрет означают «чужие службы из панели не
   * перезапускаются»: панель скажет это словами и напечатает команду для
   * консоли. Перезапуск САМОГО сервера приложения работает и без
   * посредника — ему хватает restart: unless-stopped у контейнера.
   * ---------------------------------------------------------------- */
  SERVICE_AGENT_URL: z.string().default(''),
  SERVICE_AGENT_TOKEN: z.string().default(''),

  /** Каталог общего тома с журналами. Пусто — раздел журналов недоступен. */
  MAIL_LOG_DIR: z.string().default('/var/log/mail'),

  /** Как часто сборщик заглядывает в журнал Postfix, секунды. 0 — не собирать. */
  MAIL_FLOW_INTERVAL_SECONDS: intVar(5, 0, 3600),
  /** Сколько суток хранить разобранную историю доставки. */
  MAIL_FLOW_RETENTION_DAYS: intVar(14, 0, 3650),
  /** Потолок числа строк истории: защита диска от ночной рассылки. */
  MAIL_FLOW_MAX_ROWS: intVar(500_000, 0, 100_000_000),

  /* ----------------------------------------------------------------
   * Дашборд: снимки показателей сервера.
   *
   * Историю загрузки не ведёт никто, кроме нас: /proc и cgroup отдают
   * мгновенное состояние, а долю занятого времени процессора вообще
   * нельзя получить одним обращением — она существует только как разность
   * двух замеров (см. metrics-host.ts). Поэтому сервер приложения снимает
   * показания сам, по расписанию.
   *
   * Шаг в минуту при хранении семь суток — это 10 080 строк. Меньше, чем
   * в одной секунде почтового журнала на нагруженном сервере; прореживание
   * длинных окон делается при ЧТЕНИИ (см. metrics-store.ts).
   * ---------------------------------------------------------------- */
  /** Как часто снимать показатели, секунды. 0 — не снимать вовсе. */
  MAIL_METRICS_INTERVAL_SECONDS: intVar(60, 0, 3600),
  /** Сколько суток хранить снимки. */
  MAIL_METRICS_RETENTION_DAYS: intVar(7, 0, 3650),
  /** Потолок числа снимков — второй предел, как у истории доставки. */
  MAIL_METRICS_MAX_ROWS: intVar(50_000, 0, 10_000_000),
  /**
   * Каталог поисковых индексов Dovecot. Отдельный том (mailindex
   * в docker-compose.yml): индексы перестраиваемы, письма — нет, и на
   * дашборде их объёмы должны стоять раздельно, иначе непонятно, что
   * именно чистить при нехватке места.
   */
  ADMIN_MAIL_INDEX_ROOT: z.string().default('/var/mail/index'),

  /**
   * Сколько ящиков переносить одновременно.
   *
   * Два, а не «сколько потянет»: с той стороны чужой почтовый сервер,
   * который в это же время обслуживает живых людей. Десяток параллельных
   * потоков FETCH способен положить небольшой Kerio, и переезд закончится
   * разговором с его администратором, а не переносом.
   */
  MIGRATION_CONCURRENCY: intVar(2, 1, 16),
  /**
   * Через сколько часов брошенное задание сдаётся, а его пароли стираются.
   *
   * Срок нужен не для порядка в таблице, а из-за ПАРОЛЕЙ: они лежат
   * зашифрованными ровно пока идёт задание. Если раздел выключили, базу
   * перенесли, работник больше не поднимается — свёрток остался бы лежать
   * бессрочно. Двое суток покрывают перенос сотен ящиков и не превращают
   * «на время задания» в «навсегда».
   */
  MIGRATION_MAX_HOURS: intVar(48, 1, 24 * 30),

  /**
   * Куда класть резервную копию настроек перед сменой домена.
   *
   * На ПОСТОЯННОМ томе (api-uploads), а не во временном каталоге: копия
   * снимается ровно на случай «что-то пошло не так», а «не так» чаще
   * всего означает перезапуск контейнера. Копия, исчезающая вместе с
   * контейнером, защищает только от тех бед, при которых она и не нужна.
   */
  DOMAIN_CHANGE_BACKUP_DIR: z.string().default('/srv/data/domain-change'),
});

export type AdminEnv = z.infer<typeof adminEnvSchema>;

export interface AdminConfig extends AdminEnv {
  /** Итоговая строка подключения (ADMIN_DATABASE_URL важнее DATABASE_URL). */
  databaseUrl: string | null;
  /** Настроен ли служебный доступ Dovecot (иначе вход в ящик недоступен). */
  masterConfigured: boolean;
  /** Секрет для шифрования результата импорта; пустой — не шифруем и не храним. */
  importSecret: string;
}

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const parsed = adminEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация админки: ${details}`);
  }
  const data = parsed.data;
  const databaseUrl = data.ADMIN_DATABASE_URL || data.DATABASE_URL || null;
  return {
    ...data,
    databaseUrl,
    masterConfigured: data.DOVECOT_MASTER_USER !== '' && data.DOVECOT_MASTER_PASSWORD !== '',
    importSecret: data.ADMIN_SESSION_SECRET || data.SESSION_SECRET,
  };
}
