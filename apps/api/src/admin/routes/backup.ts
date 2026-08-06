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
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, '');
  const host = hostname.replace(/[^a-zA-Z0-9.-]/gu, '') || 'mailtrue';
  return `mailtrue-settings-${host}-${stamp}.json`;
}

/** Достаёт файл копии из multipart-запроса. */
async function readBackupFile(request: {
  isMultipart(): boolean;
  file(options?: unknown): Promise<{ toBuffer(): Promise<Buffer>; file: { truncated: boolean } } | undefined>;
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
      'ящиков в копию не входят: они зашифрованы ключом из infra/.env, которого в файле нет.',
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

      // Правила фильтрации живут в базе, а работают файлом Sieve в почтовом
      // хранилище. Без пересборки база и Dovecot разъезжаются: в панели
      // правила видны, а письма раскладываются по-старому.
      const sieveErrors: string[] = [];
      for (const email of outcome.resyncSieve) {
        try {
          await app.settingsService.syncSieve(email);
        } catch (err) {
          sieveErrors.push(`${email}: ${err instanceof Error ? err.message : String(err)}`);
        }
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
          // Остановленный перенос — последствие восстановления, и в записи
          // о нём оно обязано быть: иначе связь между двумя событиями
          // придётся угадывать по времени.
          migrationStopped: migrationHit.join(' '),
        },
      });

      return {
        ok: true,
        applied: outcome.applied,
        plan,
        sieve: {
          resynced: outcome.resyncSieve.length - sieveErrors.length,
          errors: sieveErrors,
        },
        /**
         * Оформление применяется последним и вне транзакции. Его отказ
         * больше не роняет ответ: всё остальное уже записано, и человек
         * должен увидеть ЧТО именно доехало, а не «внутреннюю ошибку».
         */
        brandingError: outcome.brandingError,
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
         * Пароли администраторов только что могли смениться — сессия
         * при этом остаётся действующей, и человек об этом должен узнать
         * от нас, а не при следующем входе.
         */
        note:
          sections.includes('admins') && plan.sections.some((s) => s.id === 'admins' && s.overwrite.length > 0)
            ? 'Учётные записи администраторов перезаписаны. Текущая сессия продолжает работать, ' +
              'но при следующем входе понадобится пароль из копии.'
            : null,
      };
    },
  );
}
