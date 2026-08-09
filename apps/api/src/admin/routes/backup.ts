/**
 * Резервная копия НАСТРОЕК: выгрузка, разбор принесённого файла и
 * восстановление.
 *
 * Копия писем здесь не делается и не читается — это install/backup.sh и
 * install/restore.sh, они снимают тома и дамп базы снаружи. Здесь то, что
 * администратор набивал руками: домены, ящики, алиасы, администраторы,
 * правила пользователей, помощник ИИ, оформление входа. Состав, версия
 * формата и решение по секретам расписаны в admin/backup-format.ts.
 *
 * Восстановление сделано в ДВА шага и иначе быть не может:
 *
 *   1) POST /backup/preview — файл разбирается, но НИЧЕГО не меняется;
 *      в ответ уходит план: что появится, что перезапишется, чего
 *      операция не коснётся вовсе, и чем это грозит;
 *   2) POST /backup/restore — то же самое с явным подтверждением.
 *
 * Одношаговое восстановление означало бы «нажал и узнал»: копия трогает
 * пароли ящиков и учётные записи администраторов, в том числе того, кто
 * её восстанавливает.
 */
import type { FastifyInstance } from 'fastify';
import { BadRequestError } from '../../errors.js';
import { audit, currentAdmin, requireAdmin } from '../guard.js';
import {
  BACKUP_SECTIONS,
  buildRestorePlan,
  countSections,
  isBackupSection,
  parseSettingsBackup,
  SECTION_TITLES,
  SETTINGS_BACKUP_VERSION,
  type BackupSection,
  type SettingsBackupFile,
} from '../backup-format.js';
import { applyRestore, exportSettings, readCurrentSnapshot } from '../backup-store.js';
import { dropMailboxAccess } from '../mailbox-access.js';

/** Предел на файл копии. Настройки — это килобайты; логотип добавляет ещё 512 КБ. */
const BACKUP_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Разбор формы с файлом копии.
 *
 * `throwFileSizeLimit: false` — чтобы предел сработал ОБРЕЗАНИЕМ, а не
 * готовым исключением плагина: его текст «Файл слишком большой» не
 * объясняет, что принесли не тот файл, а требование — внятный отказ.
 * Приведение типа нужно потому, что объявление `request.parts()` в
 * @fastify/multipart принимает только настройки busboy, тогда как сам
 * плагин читает этот ключ из того же объекта (см. onFile в его index.js).
 */
const PART_OPTIONS = {
  limits: { fileSize: BACKUP_MAX_BYTES, files: 1 },
  throwFileSizeLimit: false,
} as unknown as { limits: { fileSize: number; files: number } };

/** Имя файла выгрузки: по нему в папке «Загрузки» видно, что это и когда снято. */
function backupFileName(hostname: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, '');
  const host = hostname.replace(/[^a-zA-Z0-9.-]/gu, '') || 'mailtrue';
  return `mailtrue-settings-${host}-${stamp}.json`;
}

/** Достаёт файл копии из multipart-запроса. */
async function readBackupFile(request: {
  isMultipart(): boolean;
  file(
    options?: unknown,
  ): Promise<{ toBuffer(): Promise<Buffer>; file: { truncated: boolean } } | undefined>;
}): Promise<SettingsBackupFile> {
  if (!request.isMultipart()) {
    throw new BadRequestError(
      'Файл копии не пришёл: он отправляется формой multipart/form-data, поле «file».',
    );
  }
  const part = await request.file(PART_OPTIONS);
  if (!part) throw new BadRequestError('В запросе нет файла копии.');
  const bytes = await part.toBuffer();
  if (part.file.truncated) {
    throw new BadRequestError(
      `Файл больше ${BACKUP_MAX_BYTES / (1024 * 1024)} МБ — это не копия настроек. ` +
        'Копия писем (install/backup.sh) восстанавливается скриптом install/restore.sh.',
    );
  }
  if (bytes.length === 0) throw new BadRequestError('Файл копии пустой.');
  return parseSettingsBackup(bytes.toString('utf8'));
}

/** Разбирает список разделов из поля формы. Пусто — все. */
function parseSections(raw: unknown): BackupSection[] {
  if (raw === undefined || raw === null || raw === '') return [...BACKUP_SECTIONS];
  // Поле формы бывает и массивом (повторённое имя), и объектом при
  // подделке запроса. String() на них дал бы разделы вида «[object Object]»,
  // то есть молча пустую копию вместо отказа.
  if (Array.isArray(raw)) return parseSections(raw.join(','));
  if (typeof raw !== 'string') return [...BACKUP_SECTIONS];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (list.length === 0) return [...BACKUP_SECTIONS];
  const unknown = list.filter((s) => !isBackupSection(s));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Неизвестные разделы: ${unknown.join(', ')}. Допустимы: ${BACKUP_SECTIONS.join(', ')}.`,
    );
  }
  return list.filter(isBackupSection);
}

export async function adminBackupRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;

  /** Что вообще умеет раздел — интерфейс рисует список по этому ответу. */
  app.get('/backup/sections', { preHandler: requireAdmin(app, 'backup.export') }, async () => ({
    formatVersion: SETTINGS_BACKUP_VERSION,
    sections: BACKUP_SECTIONS.map((id) => ({ id, title: SECTION_TITLES[id] })),
    /**
     * То, что человек обязан знать ДО того, как скачает файл: внутри хэши
     * паролей. Показывается рядом с кнопкой, а не в документации.
     */
    secretsNote:
      'В копию входят хэши паролей ящиков и администраторов — без них восстановление ' +
      'превратилось бы в массовый сброс паролей. Хэш не разворачивается обратно в пароль, ' +
      'но файл всё равно храните как секрет. Ключи доступа к сервисам ИИ и пароли чужих ' +
      'ящиков в копию не входят: они зашифрованы ключом из infra/.env, которого в файле нет. ' +
      /*
       * Про ключ подписи сказано отдельно и прямо. Раздел называется
       * «Домены и ключи подписи», и из названия следует, что подпись
       * переедет вместе с копией. Она не переедет: приватный ключ лежит в
       * томе rspamd, куда серверу приложения ходу нет, — в копии только
       * публичная часть. Не сказать об этом значит отдать человеку файл,
       * которым он рассчитывает поднять почту на новой машине с теми же
       * записями DNS, — а исходящая почта пойдёт неподписанной.
       */
      'ПРИВАТНОГО КЛЮЧА DKIM в копии нет: он хранится в томе rspamd, отдельно от базы. ' +
      'При переезде на другую машину скопируйте том rspamd-data или выпустите ключ заново ' +
      'и опубликуйте новую запись в DNS — иначе письма будут уходить без подписи.',
  }));

  /** Выгрузка. Отдаётся файлом, а не телом для показа: копию сохраняют. */
  app.post(
    '/backup/export',
    {
      preHandler: requireAdmin(app, 'backup.export'),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const file = await exportSettings(ctx.db, ctx.branding, {
        hostname: ctx.config.MAIL_HOSTNAME,
        domain: ctx.config.MAIL_DOMAIN,
      });
      const counts = countSections(file);
      await audit(ctx, request, {
        action: 'backup.export',
        targetType: 'backup',
        targetLabel: `копия настроек (формат ${file.version})`,
        after: counts as unknown as Record<string, unknown>,
      });

      const name = backupFileName(ctx.config.MAIL_HOSTNAME, new Date(file.createdAt));
      void reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        // Копию не должен кэшировать ни браузер, ни прокси: внутри хэши паролей.
        .header('Cache-Control', 'no-store');
      return reply.send(JSON.stringify(file, null, 2));
    },
  );

  /**
   * Разбор копии без единого изменения. Право то же, что у восстановления:
   * план показывает логины администраторов и адреса ящиков.
   *
   * ------------------------------------------------------------------
   * ПОЧЕМУ ЗАПИСЬ В ЖУРНАЛ ЕСТЬ У ОПЕРАЦИИ, КОТОРАЯ НИЧЕГО НЕ МЕНЯЕТ
   * ------------------------------------------------------------------
   * Журнал аудита отвечает не только на вопрос «кто что сломал», но и на
   * вопрос «кто что видел». Ответ этого маршрута — полный список адресов
   * всех ящиков сервера и логинов всех администраторов: адресная книга
   * организации целиком, ровно то, за чем приходят к почтовому серверу
   * снаружи. Вход в чужой ящик след оставляет (admin_mailbox_access,
   * и причина там обязательна), а выгрузка всех адресов не оставляла
   * никакого — при том что читать её проще и быстрее.
   *
   * Пишутся ЧИСЛА и происхождение файла, а не сам план: класть в журнал
   * тот же список адресов значило бы размножить выгрузку, а не проследить
   * её. Имени файла тоже нет — оно приходит от клиента и ни на что не
   * опирается.
   */
  app.post(
    '/backup/preview',
    {
      preHandler: requireAdmin(app, 'backup.restore'),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request) => {
      const file = await readBackupFile(request as never);
      const admin = currentAdmin(request);
      const current = await readCurrentSnapshot(ctx.db, ctx.branding);
      const plan = buildRestorePlan(file, current, {
        currentAdminLogin: admin.login,
        hostname: ctx.config.MAIL_HOSTNAME,
      });
      const counts = countSections(file);
      await audit(ctx, request, {
        action: 'backup.preview',
        targetType: 'backup',
        targetLabel: `разбор копии от ${file.createdAt} (${file.source.hostname || 'неизвестный сервер'})`,
        after: {
          ...(counts as unknown as Record<string, unknown>),
          // Сколько адресов ящиков и логинов администраторов ушло в ответ:
          // именно это и есть то, что человек увидел.
          mailboxes_listed: current.mailboxes.length,
          admins_listed: current.admins.length,
        },
      });
      return { plan, counts };
    },
  );

  /**
   * Восстановление. Требует подтверждения явным полем: план человек
   * получил на предыдущем шаге, и «применить» должно быть отдельным
   * осознанным действием, а не побочным эффектом загрузки файла.
   *
   * ------------------------------------------------------------------
   * ВОССТАНОВЛЕНИЕ ПОСРЕДИ ИДУЩЕГО ПЕРЕНОСА ПОЧТЫ
   * ------------------------------------------------------------------
   * Копия несёт признак «ящик включён». Применённая посреди ночного
   * переноса, она гасит ящик, в который в этот момент кладут письма, —
   * и перенос в него останавливается.
   *
   * Восстановление при этом НЕ ЗАПРЕЩАЕТСЯ, и выбор здесь сделан
   * сознательно. Запрет означал бы, что раздел «Настройки из копии»
   * недоступен, пока идёт задание переноса, — а задание идёт сутками,
   * может висеть забытым и вообще не имеет отношения к тому, ради чего
   * копию восстанавливают (вернуть снесённое правило фильтрации, поднять
   * оформление после неудачной правки). Запрещать чинить сервер, потому
   * что где-то едет чужая почта, — это лечение симптома: настоящий
   * дефект был не в том, что ящик выключился, а в том, что перенос
   * называл причиной остановки «неправильный пароль».
   *
   * Поэтому починена именно причина: перенос теперь спрашивает состояние
   * ящика у нашей же базы и говорит «ящик отключён» словами (см.
   * admin/migrate-jobs.ts, destMailboxProblem и admin/migrate-runner.ts).
   * А здесь остаётся предупреждение: человек узнаёт, что сейчас произошло
   * с идущим переносом, сразу — от нас, а не через час по замершим числам.
   */
  app.post(
    '/backup/restore',
    {
      preHandler: requireAdmin(app, 'backup.restore'),
      config: { rateLimit: { max: 5, timeWindow: 60_000 } },
    },
    async (request) => {
      if (!request.isMultipart()) {
        throw new BadRequestError(
          'Файл копии не пришёл: он отправляется формой multipart/form-data, поле «file».',
        );
      }

      // Разбираем весь запрос сразу: кроме файла нужны поля «разделы» и
      // «подтверждение», а они могут прийти в любом порядке.
      let bytes: Buffer | null = null;
      let truncated = false;
      const fields = new Map<string, string>();
      for await (const part of request.parts(PART_OPTIONS)) {
        if (part.type === 'file') {
          bytes = await part.toBuffer();
          truncated = part.file.truncated;
        } else {
          fields.set(part.fieldname, String(part.value));
        }
      }
      if (truncated) {
        throw new BadRequestError(
          `Файл больше ${BACKUP_MAX_BYTES / (1024 * 1024)} МБ — это не копия настроек.`,
        );
      }
      if (!bytes || bytes.length === 0) throw new BadRequestError('В запросе нет файла копии.');

      if (fields.get('confirm') !== 'yes') {
        throw new BadRequestError(
          'Восстановление не подтверждено. Сначала посмотрите план на шаге «Что изменится», ' +
            'потом повторите запрос с подтверждением.',
        );
      }

      const file = parseSettingsBackup(bytes.toString('utf8'));
      const sections = parseSections(fields.get('sections'));
      const admin = currentAdmin(request);

      // План считаем ЗАНОВО и кладём в журнал аудита: иначе от операции,
      // которая меняет пароли администраторов, не осталось бы следа
      // о том, что именно она перезаписала.
      const current = await readCurrentSnapshot(ctx.db, ctx.branding);
      const plan = buildRestorePlan(file, current, {
        currentAdminLogin: admin.login,
        hostname: ctx.config.MAIL_HOSTNAME,
        sections,
      });

      /*
       * Ящики, которые копия отключит, а перенос прямо сейчас наполняет.
       * Считается ДО применения: после него признак «включён» в базе уже
       * из копии, и пересечение нашлось бы пустым.
       */
      const migrationHit = sections.includes('mailboxes')
        ? await (async (): Promise<string[]> => {
            const busy = new Set(await ctx.db.listActiveMigrationDestinations());
            if (busy.size === 0) return [];
            return file.data.mailboxes
              .filter((m) => !m.active && busy.has(m.email.toLowerCase()))
              .map((m) => m.email);
          })()
        : [];

      const outcome = await applyRestore(ctx.db, ctx.branding, file, sections);

      /*
       * Правила фильтрации живут в базе, а работают файлом Sieve в почтовом
       * хранилище. Без пересборки база и Dovecot разъезжаются: в панели
       * правила видны, а письма раскладываются по-старому.
       *
       * ------------------------------------------------------------------
       * ПОЧЕМУ ЗДЕСЬ СМОТРЯТ НА ОТВЕТ, А НЕ ТОЛЬКО ЛОВЯТ ИСКЛЮЧЕНИЕ
       * ------------------------------------------------------------------
       * `syncSieve` НАМЕРЕННО НЕ БРОСАЕТ. Она возвращает состояние с
       * причиной — «чтобы „правило есть, а не работает“ было видно сразу»
       * (settings/service.ts). Обычные отказы у неё именно такие:
       * выключен транспорт (SIEVE_TRANSPORT=off), недоступен контейнер
       * Dovecot, не записался файл.
       *
       * Здесь стоял голый `try/catch`, и ловить ему было нечего: список
       * ошибок всегда оставался пустым. Восстановление отвечало `ok: true`
       * и «правила пересобраны у N ящиков» ровно в том случае, ради
       * которого этот код и написан: в базе новые правила, а почта
       * раскладывается по старому файлу. Ровно та же ошибка уже была
       * найдена в личных настройках и покрыта settings/sieve-warning.test.ts
       * — здесь она жила отдельной копией.
       *
       * Признак беды — `written`, а не `ok`: «не скомпилировано» на стенде
       * означает лишь отсутствие sievec рядом с сервером приложения, файл
       * при этом записан и Dovecot соберёт его сам при первой доставке.
       */
      const sieveErrors: string[] = [];
      /**
       * Сколько ящиков не успели пересобрать в теле запроса — они уедут
       * в фон.
       *
       * ------------------------------------------------------------------
       * ЗАЧЕМ ПРЕДЕЛ ПО ВРЕМЕНИ
       * ------------------------------------------------------------------
       * Пересборка идёт по ящику за раз, и каждый — это пара запросов к
       * базе плюс запись файла. На нескольких сотнях ящиков запрос
       * упирается в предел ожидания прокси, и браузер показывает ошибку
       * у восстановления, которое УЖЕ ПРИМЕНЕНО: в базе всё записано,
       * коммит прошёл строчкой выше. Человек видит красное и повторяет
       * необратимое действие.
       *
       * Ровно этот расчёт в этом же продукте однажды заставил переделать
       * импорт ящиков в фоновое задание.
       *
       * Поэтому: сколько успеваем — делаем сразу и показываем ошибки
       * поимённо (это ценно, их надо видеть), остальное доделываем в
       * фоне и честно говорим, сколько ящиков ждёт. Пока фон не дошёл,
       * письма у них раскладываются по старым правилам — и это сказано
       * прямо, а не оставлено на догадку.
       */
      const SIEVE_INLINE_MS = 20_000;
      const sieveStarted = Date.now();
      const pending: string[] = [];

      const resyncOne = async (email: string): Promise<string | null> => {
        try {
          const state = await app.settingsService.syncSieve(email);
          return state.written ? null : `${email}: ${state.error || 'причина неизвестна'}`;
        } catch (err) {
          return `${email}: ${err instanceof Error ? err.message : String(err)}`;
        }
      };

      for (const email of outcome.resyncSieve) {
        if (Date.now() - sieveStarted > SIEVE_INLINE_MS) {
          pending.push(email);
          continue;
        }
        const problem = await resyncOne(email);
        if (problem !== null) sieveErrors.push(problem);
      }

      if (pending.length > 0) {
        // Фоном и без ожидания: ответ человеку важнее, а отказы уйдут в
        // журнал сервера — там их и ищут, когда письма разложились не так.
        void (async () => {
          for (const email of pending) {
            const problem = await resyncOne(email);
            if (problem !== null) {
              app.log.error(
                { email, problem },
                'правила Sieve не пересобраны после восстановления',
              );
            }
          }
        })();
      }

      /*
       * ЗАКРЫВАЕМ ДОСТУП ТЕМ, КОГО КОПИЯ ТОЛЬКО ЧТО ПЕРЕПИСАЛА.
       *
       * Восстановление — единственный путь смены пароля и признака
       * «включён», который шёл мимо этого замка. Все остальные (смена
       * пароля, блокировка, удаление ящика в разделе «Ящики») закрывают
       * доступ сами, потому что ни пароль, ни `active` не выгоняют никого:
       * Dovecot отсеивает их только при проверке пароля, а у вошедшего
       * проверять нечего — сессия продлевается каждым запросом, соединение
       * в пуле переиспользуется, наблюдатель живёт до суток (разбор — в
       * admin/mailbox-access.ts).
       *
       * Копию восстанавливают как раз тогда, когда наводят порядок:
       * «отключить ящик уволенного» через восстановление настроек ящик
       * отключало, а читать и отправлять почту не мешало ничем.
       *
       * Отказ здесь ничего не отменяет: база уже записана, и человек
       * обязан получить ответ с журналом аудита, а не «внутреннюю ошибку».
       */
      for (const email of outcome.mailboxesToDrop) {
        await dropMailboxAccess(app, email, 'восстановление копии настроек');
      }
      /*
       * И сессии администраторов, чей пароль переписан, — включая свою.
       *
       * План восстановления обещает человеку «вход по нынешнему паролю
       * перестанет работать», и до этой правки обещание было ложным:
       * админская сессия о пароле не знает ничего. Тот, кто вошёл до
       * восстановления, оставался внутри с прежними правами — а копия
       * приезжает и с чужого сервера.
       */
      let adminSessionsClosed = 0;
      for (const adminId of outcome.adminsToRevoke) {
        adminSessionsClosed += await ctx.sessions.revokeByAdminId(adminId).catch(() => 0);
      }

      await audit(ctx, request, {
        action: 'backup.restore',
        targetType: 'backup',
        targetLabel: `копия от ${file.createdAt} (${file.source.hostname || 'неизвестный сервер'})`,
        before: {
          sections: sections.join(','),
          overwrites: plan.sections.map((s) => `${s.id}:${s.overwrite.length}`).join(' '),
        },
        after: {
          sections: sections.join(','),
          applied: outcome.applied as unknown as Record<string, unknown>,
          sieveErrors: sieveErrors.length,
          // Отказ оформления попадает в журнал вместе с остальным: иначе
          // из записи не понять, полным ли было восстановление.
          brandingError: outcome.brandingError ?? '',
          // Не заведённые алиасы поверх живых ящиков: их отсутствие после
          // восстановления иначе выглядело бы как потеря данных.
          aliasesSkipped: outcome.skippedAliases.join(' '),
          // Остановленный перенос — последствие восстановления, и в записи
          // о нём оно обязано быть: иначе связь между двумя событиями
          // придётся угадывать по времени.
          migrationStopped: migrationHit.join(' '),
          // Кого выгнали. Это не статистика: восстановление копии — второй
          // после смены пароля способ закрыть доступ, и в журнале должно
          // быть видно, что доступ действительно закрыли.
          mailboxAccessDropped: outcome.mailboxesToDrop.length,
          adminSessionsClosed,
        },
      });

      return {
        /*
         * `ok` — это ответ на вопрос «восстановление доехало целиком?»,
         * а не «маршрут не упал». Раньше здесь стояла константа true, и
         * она оставалась true при непереписанных файлах правил: в базе
         * новые правила, в ящиках старые, а в ответе — успех.
         */
        ok: sieveErrors.length === 0 && outcome.brandingError === null,
        applied: outcome.applied,
        plan,
        sieve: {
          resynced: outcome.resyncSieve.length - sieveErrors.length,
          errors: sieveErrors,
          /**
           * Ящики, чьи правила дособираются в фоне: в теле запроса их
           * не успели. Пока это идёт, письма у них раскладываются по
           * старым правилам.
           */
          pending: pending.length,
        },
        /**
         * Оформление применяется последним и вне транзакции. Его отказ
         * больше не роняет ответ: всё остальное уже записано, и человек
         * должен увидеть ЧТО именно доехало, а не «внутреннюю ошибку».
         */
        brandingError: outcome.brandingError,
        /**
         * Алиасы, которые копия НЕ завела: их исходный адрес занят живым
         * ящиком, и такой алиас увёл бы всю его входящую почту. null —
         * таких не было. Молчать нельзя: после восстановления человек
         * увидит, что часть перенаправлений не вернулась, и решит, что
         * копия неполная.
         */
        aliasWarning:
          outcome.skippedAliases.length > 0
            ? `Не восстановлено перенаправлений: ${String(outcome.skippedAliases.length)}. ` +
              `Их исходный адрес — это существующий ящик (${outcome.skippedAliases.slice(0, 10).join(', ')}` +
              (outcome.skippedAliases.length > 10
                ? ` и ещё ${String(outcome.skippedAliases.length - 10)}`
                : '') +
              '), а перенаправления Postfix разбирает раньше ящиков: такой алиас увёл бы ' +
              'всю входящую почту ящика в сторону. Если пересылка нужна, сделайте её ' +
              'правилом в самом ящике.'
            : null,
        /**
         * Что копия сделала с идущим переносом почты. null — переноса нет
         * или он не задет. См. пояснение в шапке маршрута: восстановление
         * не запрещается, но молчать о последствии нельзя.
         */
        migrationWarning:
          migrationHit.length > 0
            ? `Сейчас идёт перенос почты, и копия отключила ${String(migrationHit.length)} ` +
              `ящик(ов) из тех, куда он едет: ${migrationHit.slice(0, 10).join(', ')}` +
              (migrationHit.length > 10 ? ` и ещё ${String(migrationHit.length - 10)}` : '') +
              '. В отключённый ящик Dovecot не пускает даже служебным доступом, ' +
              'и перенос в них остановится с этой же причиной. Включите ящики и ' +
              'повторите задание — уже перенесённые письма повторно не поедут.'
            : null,
        /**
         * Пароли администраторов только что могли смениться — вместе с
         * ними закрыты и открытые сессии панели, в том числе ЭТА.
         *
         * Раньше здесь стояло «текущая сессия продолжает работать»: так
         * оно и было, и в этом состояла дыра. Пароль владельца сменили, а
         * тот, кто вошёл по старому (в том числе по уведённой cookie),
         * остался внутри — с настройками сервера, перезапуском служб и
         * выгрузкой копии с хэшами всех паролей.
         */
        note:
          sections.includes('admins') &&
          plan.sections.some((s) => s.id === 'admins' && s.overwrite.length > 0)
            ? 'Учётные записи администраторов перезаписаны, открытые сессии панели закрыты — ' +
              'включая вашу. Войдите заново паролем из копии.'
            : null,
      };
    },
  );
}
