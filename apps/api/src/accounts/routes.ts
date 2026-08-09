/**
 * Маршруты подключения ящиков.
 *
 * Три группы:
 *   /api/accounts                — свои ящики: список, связывание,
 *                                  переключение, общий счётчик непрочитанных;
 *   /api/accounts/external       — чужие ящики: мастер, подключения, сбор;
 *   /api/accounts/external/:id/… — прямое подключение: папки, письма, отправка.
 *
 * Владелец везде берётся из сессии. Указать чужой адрес владельца
 * нельзя — для него нет ни одного параметра.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newSessionId } from '../crypto.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors.js';
import { listFolders } from '../imap/service.js';
import { loadForwardedMessages } from '../mail/forwarded.js';
import { setSessionCookie } from '../routes/auth.js';
import { detectMailSettings, type LocalMailSettings } from './autodetect.js';
import { decodeLabel } from './collectorRoutes.js';
import { composeExternalRaw, externalRecipients } from './compose.js';
import { isUndefinedTable, isUniqueViolation } from './db.js';
import { listExternalFolders, listExternalMessages, sendAsExternal } from './direct.js';
import { AccountsUnavailableError, MIGRATION_HINT, type AccountsService } from './service.js';
import type { MailSession } from '../types.js';
import type { ExternalAccountInput, UnreadEntry } from './types.js';
import { errorInfo } from '../log.js';

/* ------------------------------------------------------------------ */
/* Схемы                                                                */
/* ------------------------------------------------------------------ */

const emailSchema = z.string().trim().toLowerCase().email().max(320);

const linkSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
  label: z.string().max(255).nullable().default(null),
});

const switchSchema = z.object({ email: emailSchema });

const detectSchema = z.object({ email: emailSchema });

const externalSchema = z.object({
  address: emailSchema,
  label: z.string().max(255).nullable().default(null),
  mode: z.enum(['collector', 'direct']).default('collector'),
  imapHost: z.string().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapSecure: z.boolean().default(true),
  imapUser: z.string().min(1).max(320).optional(),
  password: z.string().min(1).max(1024),
  allowInsecureTls: z.boolean().optional(),
  smtpHost: z.string().max(255).nullable().default(null),
  smtpPort: z.number().int().min(1).max(65535).nullable().default(null),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().max(320).nullable().default(null),
  targetFolder: z.string().min(1).max(255).default('INBOX'),
  collectScope: z.enum(['inbox', 'all']).default('inbox'),
  intervalMinutes: z.number().int().min(0).max(1440).default(15),
  enabled: z.boolean().default(true),
});

const externalPatchSchema = externalSchema.partial().omit({ address: true });

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  folderId: z.string().min(1).max(512),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  snippets: z.enum(['0', '1']).default('1'),
});

const addressSchema = z.object({
  name: z.string().max(200).nullable().default(null),
  address: z.string().trim().email().max(320),
});

const sendSchema = z.object({
  to: z.array(addressSchema).max(100).default([]),
  cc: z.array(addressSchema).max(100).default([]),
  bcc: z.array(addressSchema).max(100).default([]),
  subject: z.string().max(1000).default(''),
  bodyHtml: z
    .string()
    .max(10 * 1024 * 1024)
    .default(''),
  attachmentIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  fromName: z.string().max(200).nullable().default(null),
  inReplyTo: z.string().max(1000).optional(),
  references: z.array(z.string().max(1000)).max(100).optional(),
  // «Переслать как вложение» и просьба уведомить о прочтении работают и
  // здесь. Раньше этих полей в схеме не было: окно показывало плашки
  // вложенных писем и зажжённую кнопку, а до сервера они не доезжали —
  // письмо уходило без них, и человеку говорили «отправлено».
  attachMessageIds: z.array(z.string().min(1).max(200)).max(10).optional(),
  requestReadReceipt: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* Маршруты                                                             */
/* ------------------------------------------------------------------ */

export async function accountsUserRoutes(
  app: FastifyInstance,
  service: AccountsService,
): Promise<void> {
  const { config, pool, sessions, secretBox, uploads, logger } = app.deps;

  const sessionOf = (request: { mailSession: MailSession | null }): MailSession => {
    if (!request.mailSession) throw new UnauthorizedError();
    return request.mailSession;
  };

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isUndefinedTable(err)) throw new AccountsUnavailableError(MIGRATION_HINT);
      if (isUniqueViolation(err)) throw new BadRequestError('Такой ящик уже подключён');
      throw err;
    }
  };

  /** Настройки нашего сервера — для автоопределения по адресу. */
  const localSettings = (): LocalMailSettings => ({
    domains: service.config.MAIL_DOMAIN.split(',').map((d) => d.trim().toLowerCase()),
    hostname: service.config.MAIL_HOSTNAME,
    imapPort: service.config.IMAPS_PORT,
    imapSecure: true,
    smtpPort: service.config.SUBMISSION_PORT,
    smtpSecure: false,
    label: service.config.PROVIDER_NAME,
  });

  /* -------------------------------------------------------------- */
  /* Свои ящики                                                       */
  /* -------------------------------------------------------------- */

  // Всё, что нужно шапке: текущий ящик, связанные свои и чужие подключения.
  app.get('/', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const db = service.requireDb();
    return guard(async () => ({
      current: session.email,
      linked: await db.listLinked(session.email),
      // Метка чистится от служебной приписки: подключения, заведённые
      // из раздела «Почта с других ящиков», держат в ней свои признаки
      // (см. accounts/collectorRoutes.ts). Показывать человеку «mt:leave»
      // вместо названия ящика нельзя — это наша внутренняя запись.
      external: (await db.listExternal(session.email)).map((account) => ({
        ...account,
        label: decodeLabel(account.label).label,
      })),
      /*
       * Куда можно ВЕРНУТЬСЯ, не вводя пароль.
       *
       * Право на возврат живёт в сессии того, кто переключился (см.
       * SessionData.returnTo), и работало оно всегда — вот только клиенту
       * о нём никто не говорил. Список ящиков строится по связям ТЕКУЩЕГО
       * ящика, а связь односторонняя: из ящика B исходный A не виден,
       * ввести адрес руками негде. Одно переключение обнуляло
       * переключатель целиком.
       *
       * Хуже того, единственной оставшейся кнопкой было «Добавить ящик» —
       * и человек вводил из B пароль от A, заводя ту самую обратную
       * связь, которую мы намеренно убрали.
       */
      returnTo: session.returnTo ? { email: session.returnTo.email } : null,
      secrets: { available: service.secretsAvailable, reason: service.secretsReason },
      collector: {
        scheduler: service.config.COLLECTOR_SCHEDULER && service.config.masterConfigured,
        masterConfigured: service.config.masterConfigured,
      },
    }));
  });

  /**
   * Связать свой второй ящик.
   *
   * Пароль спрашивается ровно один раз — здесь, и проверяется настоящим
   * IMAP-логином: пользователь доказывает, что ящик его. Дальше пароль
   * лежит зашифрованным, и переключение проходит без ввода пароля.
   * Связь заводится в обе стороны, иначе вернуться обратно было бы
   * нельзя без повторного ввода.
   */
  app.post('/link', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { email, password, label } = linkSchema.parse(request.body);
    if (email === session.email.toLowerCase()) {
      throw new BadRequestError('Это и есть текущий ящик');
    }
    const db = service.requireDb();
    const box = service.requireSecretBox();

    // Проверяем владение реальным логином к нашему Dovecot.
    await pool.verify(email, password);

    return guard(async () => {
      /*
       * Связь заводится ТОЛЬКО В ОДНУ СТОРОНУ.
       *
       * Здесь стояла ещё и обратная — «чтобы переключиться назад тоже без
       * пароля», — и она отдавала владельцу чужого ящика ключ от нашего.
       * Проверка выше доказывает ровно одно: вызывающий знает пароль B.
       * Из этого никак не следует право B ходить в A, а именно оно и
       * записывалось: строка owner=B, linked=A с зашифрованным паролем A.
       *
       * Цена была высокой и незаметной. Администратор, который сам выдал
       * сотруднику пароль и связал его ящик со своим, чтобы посмотреть
       * жалобу, тем самым дарил сотруднику вход в СВОЮ почту: тот видел
       * ящик администратора в списке связанных и входил одним нажатием,
       * ничего не зная и ничего не подтверждая.
       *
       * Вернуться назад по-прежнему можно и без пароля — правом на это
       * распоряжается сессия, а не общая таблица (см. returnTo в /switch).
       */
      const linked = await db.linkAccount(session.email, email, label, box.encrypt(password));
      return { linked };
    });
  });

  app.delete('/link/:email', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { email } = z.object({ email: emailSchema }).parse(request.params);
    const db = service.requireDb();
    return guard(async () => {
      const linked = await db.unlinkAccount(session.email, email);
      await db.unlinkAccount(email, session.email);
      return { linked };
    });
  });

  /**
   * Переключение на связанный ящик без повторного ввода пароля.
   *
   * Заводится НОВАЯ сессия, а старая удаляется: одна сессия — один ящик.
   * Так cookie всегда однозначно отвечает на вопрос «чью почту показываем»,
   * и случайная отправка из чужого ящика становится невозможной.
   */
  app.post('/switch', { preHandler: app.requireSession }, async (request, reply) => {
    const session = sessionOf(request);
    const { email } = switchSchema.parse(request.body);
    if (email === session.email.toLowerCase()) return { ok: true, email: session.email };

    const db = service.requireDb();
    const box = service.requireSecretBox();
    /*
     * Два законных пути попасть в ящик без пароля:
     *
     *   1. связь, заведённая ЭТИМ ящиком (он доказывал пароль цели);
     *   2. возврат туда, откуда сюда же и переключились в этом сеансе.
     *
     * Второй и заменил прежнюю обратную связь в таблице: право вернуться
     * принадлежит человеку за этим сеансом, а не учётной записи вообще.
     *
     * Ключи у этих двух путей РАЗНЫЕ, и путать их нельзя: связи лежат под
     * ключом внешних учётных записей (service.requireSecretBox), а всё,
     * что живёт в сессии, — под ключом сессий (secretBox). Первая же
     * живая проверка это и показала: возврат отвечал 500, потому что
     * пароль из сессии расшифровывали чужим ключом.
     */
    const back = session.returnTo;
    let password: string;
    if (back && back.email === email) {
      password = secretBox.decrypt(back.passwordEnc);
    } else {
      const enc = await guard(() => db.findLinkedSecret(session.email, email));
      if (!enc) {
        throw new BadRequestError(
          'Этот ящик не связан с текущим. Сначала добавьте его с вводом пароля.',
        );
      }
      password = box.decrypt(enc);
    }
    // Пароль мог измениться на стороне ящика — проверяем перед выдачей сессии.
    await pool.verify(email, password);

    const sessionId = newSessionId();
    await sessions.set(
      sessionId,
      {
        email,
        passwordEnc: secretBox.encrypt(password),
        createdAt: Date.now(),
        // Чем вернуться обратно. Только в этом сеансе и только тому, кто
        // переключился: чужая учётная запись прав не получает.
        returnTo: { email: session.email, passwordEnc: secretBox.encrypt(session.password) },
      },
      config.SESSION_TTL_SECONDS,
    );
    await sessions.delete(session.id);
    setSessionCookie(app, reply, sessionId);
    return { ok: true, email };
  });

  /**
   * Общий счётчик непрочитанных: текущий ящик, связанные свои и чужие
   * подключения в режиме прямого доступа.
   *
   * Собранные сборщиком письма лежат в нашем же ящике и уже посчитаны —
   * второй раз их считать было бы враньём.
   */
  app.get('/unread', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const db = service.requireDb();
    const entries: UnreadEntry[] = [];

    const countOwn = async (email: string, password: string, kind: 'own' | 'linked') => {
      try {
        const unread = await pool.withClient(email, password, async (client) => {
          const status = await client.status('INBOX', { unseen: true });
          return status.unseen ?? 0;
        });
        entries.push({ email, kind, unread, error: null });
      } catch (err) {
        entries.push({
          email,
          kind,
          unread: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    await countOwn(session.email, session.password, 'own');

    const linked = await guard(() => db.listLinked(session.email));
    if (service.secretsAvailable) {
      const box = service.requireSecretBox();
      for (const item of linked) {
        const enc = await db.findLinkedSecret(session.email, item.email);
        if (!enc) continue;
        try {
          await countOwn(item.email, box.decrypt(enc), 'linked');
        } catch (err) {
          entries.push({
            email: item.email,
            kind: 'linked',
            unread: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const external = await guard(() => db.listExternal(session.email));
    for (const account of external) {
      if (account.mode !== 'direct' || !account.enabled) continue;
      const secret = await db.findExternal(session.email, account.id);
      if (!secret) continue;
      try {
        const unread = await service.externalPool.withClient(
          session.email,
          account,
          service.passwordOf(secret),
          async (client) => {
            const status = await client.status('INBOX', { unseen: true });
            return status.unseen ?? 0;
          },
        );
        entries.push({ email: account.address, kind: 'external', unread, error: null });
      } catch (err) {
        entries.push({
          email: account.address,
          kind: 'external',
          unread: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      total: entries.reduce((sum, e) => sum + e.unread, 0),
      accounts: entries,
    };
  });

  /* -------------------------------------------------------------- */
  /* Мастер подключения чужого ящика                                  */
  /* -------------------------------------------------------------- */

  // Автоопределение настроек по адресу: первый шаг мастера.
  app.post('/external/detect', { preHandler: app.requireSession }, async (request) => {
    sessionOf(request);
    const { email } = detectSchema.parse(request.body);
    const detected = await detectMailSettings(email, {
      local: localSettings(),
      probeNetwork: service.config.AUTODETECT_NETWORK,
      timeoutMs: service.config.AUTODETECT_TIMEOUT_MS,
    });
    return { detected };
  });

  app.get('/external', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const db = service.requireDb();
    return guard(async () => ({ external: await db.listExternal(session.email) }));
  });

  app.post('/external', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const body = externalSchema.parse(request.body);
    const db = service.requireDb();
    const box = service.requireSecretBox();

    const input: ExternalAccountInput = {
      address: body.address,
      label: body.label,
      mode: body.mode,
      imapHost: body.imapHost,
      imapPort: body.imapPort,
      imapSecure: body.imapSecure,
      imapUser: body.imapUser ?? body.address,
      password: body.password,
      allowInsecureTls: body.allowInsecureTls ?? service.defaultAllowInsecureTls,
      smtpHost: body.smtpHost,
      smtpPort: body.smtpPort,
      smtpSecure: body.smtpSecure,
      smtpUser: body.smtpUser ?? (body.smtpHost ? (body.imapUser ?? body.address) : null),
      targetFolder: body.targetFolder,
      collectScope: body.collectScope,
      intervalMinutes: body.intervalMinutes,
      enabled: body.enabled,
    };

    // Проверяем подключение ДО сохранения: мастер обязан сказать
    // «работает» или «не работает», а не «сохранено, посмотрим завтра».
    await service.verifySettings(input, body.password);

    const account = await guard(() =>
      db.createExternal(session.email, input, box.encrypt(body.password)),
    );
    return { account };
  });

  app.put('/external/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const patch = externalPatchSchema.parse(request.body);
    const db = service.requireDb();

    const passwordEnc =
      patch.password !== undefined ? service.requireSecretBox().encrypt(patch.password) : undefined;
    const account = await guard(() => db.updateExternal(session.email, id, patch, passwordEnc));
    if (!account) throw new NotFoundError('Подключение не найдено');
    // Настройки изменились — старое соединение больше не подходит.
    await service.externalPool.close(session.email, id);
    return { account };
  });

  app.delete('/external/:id', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const db = service.requireDb();
    const removed = await guard(() => db.deleteExternal(session.email, id));
    if (!removed) throw new NotFoundError('Подключение не найдено');
    await service.externalPool.close(session.email, id);
    return { ok: true };
  });

  /* -------------------------------------------------------------- */
  /* Сборщик                                                          */
  /* -------------------------------------------------------------- */

  app.get('/external/:id/state', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const found = await guard(() => service.requireDb().findExternal(session.email, id));
    if (!found) throw new NotFoundError('Подключение не найдено');
    return { account: found.account, state: found.account.state };
  });

  // Забрать почту прямо сейчас. Пароль владельца берётся из сессии —
  // это позволяет собирать вручную даже там, где служебный доступ
  // Dovecot не настроен.
  app.post('/external/:id/collect', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const found = await guard(() => service.requireDb().findExternal(session.email, id));
    if (!found) throw new NotFoundError('Подключение не найдено');
    if (found.account.mode !== 'collector') {
      throw new BadRequestError('Это подключение работает в режиме прямого доступа, сбор не нужен');
    }
    const result = await service.collect(
      session.email,
      found.account,
      found.passwordEnc,
      session.password,
    );
    if (!result) return { ok: false, running: true };
    const after = await service.requireDb().findExternal(session.email, id);
    return {
      ok: result.status === 'ok',
      result: {
        status: result.status,
        copied: result.copied,
        skipped: result.skipped,
        failed: result.failed,
        durationMs: result.durationMs,
        error: result.error,
      },
      state: after?.account.state ?? null,
    };
  });

  /* -------------------------------------------------------------- */
  /* Прямое подключение                                               */
  /* -------------------------------------------------------------- */

  app.get('/external/:id/folders', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const found = await guard(() => service.requireDb().findExternal(session.email, id));
    if (!found) throw new NotFoundError('Подключение не найдено');
    const folders = await service.externalPool.withClient(
      session.email,
      found.account,
      service.passwordOf(found),
      (client) => listExternalFolders(client, id),
    );
    return { accountId: id, address: found.account.address, folders };
  });

  app.get('/external/:id/messages', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const query = listQuery.parse(request.query);
    const found = await guard(() => service.requireDb().findExternal(session.email, id));
    if (!found) throw new NotFoundError('Подключение не найдено');
    const page = await service.externalPool.withClient(
      session.email,
      found.account,
      service.passwordOf(found),
      (client) =>
        listExternalMessages(client, id, {
          folderId: query.folderId,
          offset: query.offset,
          limit: query.limit,
          withSnippets: query.snippets === '1',
        }),
    );
    return page;
  });

  /* -------------------------------------------------------------- */
  /* Отправка «от имени» внешнего адреса                              */
  /* -------------------------------------------------------------- */

  app.post('/external/:id/send', { preHandler: app.requireSession }, async (request) => {
    const session = sessionOf(request);
    const { id } = idParam.parse(request.params);
    const draft = sendSchema.parse(request.body);
    const found = await guard(() => service.requireDb().findExternal(session.email, id));
    if (!found) throw new NotFoundError('Подключение не найдено');
    const recipients = externalRecipients(draft);
    if (recipients.length === 0) throw new BadRequestError('Не указан ни один получатель');

    /*
     * Исходники пересылаемых писем читаются из СВОЕГО ящика: пересылают
     * то, что человек получил у нас, даже когда письмо уходит с чужого
     * адреса. Та же функция, что и на своём пути отправки, — иначе два
     * способа однажды разъедутся, и разъедутся молча.
     */
    const forwarded =
      draft.attachMessageIds && draft.attachMessageIds.length > 0
        ? await app.deps.pool.withClient(session.email, session.password, (client) =>
            loadForwardedMessages(client, draft.attachMessageIds ?? []),
          )
        : [];

    const raw = await composeExternalRaw(
      draft,
      { name: draft.fromName, address: found.account.address },
      uploads,
      session.email,
      forwarded,
    );
    await sendAsExternal({
      account: found.account,
      password: service.passwordOf(found),
      raw,
      recipients,
      rejectUnauthorized: config.TLS_REJECT_UNAUTHORIZED,
      logger,
    });

    // Копия в «Отправленные» чужого ящика: письмо должно быть видно и там,
    // откуда его отправили, иначе история переписки распадётся.
    await service.externalPool
      .withClient(session.email, found.account, service.passwordOf(found), async (client) => {
        const folders = await listFolders(client);
        const sent = folders.find((f) => f.role === 'sent');
        if (sent) await client.append(sent.path, raw, ['\\Seen']);
      })
      .catch((err: unknown) => {
        logger.warn(errorInfo(err), 'Не удалось положить копию в «Отправленные» чужого ящика');
      });

    await Promise.all(draft.attachmentIds.map((aid) => uploads.delete(aid)));
    return { ok: true, from: found.account.address };
  });
}
