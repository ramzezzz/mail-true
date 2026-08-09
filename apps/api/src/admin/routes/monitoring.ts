/**
 * Раздел «Наблюдение»: что сломано прямо сейчас и что вот-вот сломается.
 *
 * Разделов ответа три, а не один, и по той же причине, что у дашборда: они
 * стоят разного времени. Службы и очередь — это соединения с таймаутом;
 * сертификаты — четыре TLS-рукопожатия; последние отказы — запрос к базе
 * по индексу. Слепив их вместе, мы заставили бы ждать самого медленного
 * весь экран, который открывают как раз при аварии.
 *
 * Право на всё — overview.read, кроме последних отказов: в них видны
 * адреса переписки, и право там то же, что у журналов почты (audit.read).
 *
 * Про то, чего этот раздел не проверяет и почему, — в selfcheck.ts
 * (SHELL_ONLY_CHECKS). Список отдаётся вместе с ответом и показывается на
 * экране: зелёный экран без него читался бы как «проверено всё».
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMAP_FAREWELL, probeTcpPort, SMTP_FAREWELL } from '../../health.js';
import {
  readCertificateSource,
  readRenewalReport,
  renewalHealthCheck,
  RENEW_COMMAND,
} from '../cert-renewal.js';
import { FlowStore } from '../flow-store.js';
import { loadAccountsConfig } from '../../accounts/config.js';
import { ApiError } from '../../errors.js';
import { audit, requireAdmin } from '../guard.js';
import { runRoundtrip } from '../mail-roundtrip.js';
import { readCertificates, TLS_WARN_DAYS, type TlsTarget } from '../metrics-tls.js';
import { RspamdClient } from '../rspamd.js';
import { checkAntispam, checkResolver } from '../services.js';
import {
  gradeBackup,
  gradeMigrations,
  readLastBackup,
  readMigrationFiles,
} from '../deploy-checks.js';
import {
  gradeCertificate,
  gradeDisk,
  gradeQueue,
  summarize,
  SHELL_ONLY_CHECKS,
  type CheckState,
  type HealthCheck,
} from '../selfcheck.js';

/**
 * Сколько суток проверка DNS считается свежей.
 *
 * Неделя — тот срок, за который запись у регистратора успевают поменять,
 * а панель об этом не узнаёт: сама она DNS не спрашивает.
 */
const DNS_FRESH_DAYS = 7;

/** Сколько ждём ответа порта. Три секунды: это проверка, а не диагностика сети. */
const PORT_TIMEOUT_MS = 3000;

export async function adminMonitoringRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.adminCtx;
  const { config: apiConfig } = app.deps;
  const flow = new FlowStore(ctx.db);
  const rspamd =
    ctx.rspamd ??
    new RspamdClient({
      host: ctx.config.RSPAMD_HOST,
      port: ctx.config.RSPAMD_CONTROLLER_PORT,
      password: ctx.config.RSPAMD_PASSWORD,
    });

  /* ---------------------------------------------------------------- */
  /* Службы, очередь, место                                             */
  /* ---------------------------------------------------------------- */

  app.get('/monitoring/health', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    const checks: HealthCheck[] = [];

    /**
     * Проба порта.
     *
     * Порт, а не «контейнер запущен»: запущенный Dovecot, который не
     * принимает соединения, для пользователя ничем не отличается от
     * остановленного, а сокета Docker у сервера приложения всё равно нет.
     *
     * Возвращает проверку, а не дописывает её в список: пробы идут
     * параллельно, и порядок их завершения зависит от того, какая служба
     * сегодня медленнее. Список, который переставляется сам собой между
     * обновлениями экрана, читать невозможно.
     */
    const port = async (
      id: string,
      title: string,
      host: string,
      tcpPort: number,
      consequence: string,
      farewell?: string,
    ): Promise<HealthCheck> => {
      const ok = await probeTcpPort(host, tcpPort, PORT_TIMEOUT_MS, farewell);
      return {
        id,
        group: 'Службы',
        title,
        state: ok ? 'ok' : 'fail',
        detail: ok
          ? `Порт ${host}:${String(tcpPort)} принимает соединения`
          : `Порт ${host}:${String(tcpPort)} не отвечает — ${consequence}`,
        ...(ok ? {} : { hint: 'Смотрите журнал этой службы в разделе «Журналы почты»' }),
      };
    };

    const [ports, antispam, resolver, health, queue] = await Promise.all([
      Promise.all([
        port(
          'imap',
          'Чтение почты (IMAP)',
          apiConfig.IMAP_HOST,
          apiConfig.IMAP_PORT,
          'пользователи не могут читать почту',
          IMAP_FAREWELL,
        ),
        port(
          'submission',
          'Отправка почты (submission)',
          apiConfig.SMTP_HOST,
          apiConfig.SMTP_PORT,
          'из почтовых программ и веб-интерфейса ничего не отправится',
          SMTP_FAREWELL,
        ),
        port(
          'smtp-in',
          'Приём почты (SMTP, порт 25)',
          apiConfig.SMTP_HOST,
          25,
          'сервер не принимает почту извне',
          SMTP_FAREWELL,
        ),
        /*
         * LMTP — то, чем Postfix отдаёт письмо Dovecot на укладку в ящик.
         * Отдельная проверка не педантизм: при живых 25 и 993 сломанный
         * LMTP означает, что почта ПРИНИМАЕТСЯ и копится в очереди, но в
         * ящики не попадает. Снаружи это выглядит как «письма не приходят»
         * при полностью зелёных остальных проверках.
         */
        port(
          'lmtp',
          'Укладка в ящики (LMTP)',
          apiConfig.IMAP_HOST,
          24,
          'принятая почта не попадает в ящики и копится в очереди',
        ),
        port(
          'antispam-milter',
          'Приёмник антиспама (milter)',
          ctx.config.RSPAMD_HOST,
          11332,
          'Postfix не может отдать письмо на проверку',
        ),
      ]),
      checkAntispam({
        host: ctx.config.RSPAMD_HOST,
        port: ctx.config.RSPAMD_CONTROLLER_PORT,
        password: ctx.config.RSPAMD_PASSWORD,
        domain: ctx.config.MAIL_DOMAIN,
      }),
      checkResolver({ address: ctx.config.RESOLVER_IP }),
      app.health.report(),
      ctx.queueAgent.configured
        ? ctx.queueAgent.snapshot().catch(() => null)
        : Promise.resolve(null),
    ]);

    checks.push(...ports);

    // Postgres и Redis — из общей пробы состояния: у неё уже открыты
    // соединения и есть кэш, второго подключения ради экрана не заводим.
    for (const id of ['postgres', 'redis'] as const) {
      const part = health.parts.find((p) => p.id === id);
      checks.push({
        id,
        group: 'Службы',
        title: part?.title ?? id,
        state: part ? (part.state === 'ok' ? 'ok' : 'fail') : 'unknown',
        detail: part?.detail ?? 'Состояние неизвестно: часть не зарегистрирована в пробе',
      });
    }

    checks.push({
      id: 'antispam',
      group: 'Службы',
      title: 'Антиспам (rspamd)',
      state: antispam.antispam.state,
      detail: antispam.antispam.detail,
    });
    checks.push({
      id: 'dkim',
      group: 'Службы',
      title: 'Подпись исходящих (DKIM)',
      state: antispam.dkim.state,
      detail: antispam.dkim.detail,
      ...(antispam.dkim.state === 'fail'
        ? { hint: 'Ключ лежит в контейнере rspamd: /var/lib/rspamd/dkim/<домен>.<селектор>.key' }
        : {}),
    });
    checks.push({
      id: 'resolver',
      group: 'Службы',
      title: 'Свой резольвер (unbound)',
      state: resolver.state,
      detail: resolver.detail,
    });
    checks.push({
      id: 'master',
      group: 'Службы',
      title: 'Служебный доступ Dovecot',
      state: ctx.mailbox.configured ? 'ok' : 'warn',
      detail: ctx.mailbox.configured
        ? 'Настроен: вход администратора в чужой ящик и перенос почты работают'
        : 'Не настроен: вход администратора в чужой ящик недоступен',
      ...(ctx.mailbox.configured
        ? {}
        : { hint: 'Задайте DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD в infra/.env' }),
    });

    /* --- Очередь ---------------------------------------------------- */
    if (!ctx.queueAgent.configured) {
      checks.push({
        id: 'queue',
        group: 'Очередь',
        title: 'Очередь Postfix',
        state: 'unknown',
        detail:
          'Посредник к очереди не настроен: сколько писем ждёт отправки — неизвестно. ' +
          'Это не значит, что очередь пуста',
        hint: 'Задайте MAIL_QUEUE_AGENT_URL и QUEUE_AGENT_TOKEN в infra/.env',
      });
    } else if (!queue) {
      checks.push({
        id: 'queue',
        group: 'Очередь',
        title: 'Очередь Postfix',
        state: 'fail',
        detail: 'Посредник в контейнере postfix не ответил — состояние очереди неизвестно',
      });
    } else {
      const oldest = queue.messages.reduce<number | null>((max, message) => {
        const age = Math.floor((Date.now() - message.arrivalTime.getTime()) / 1000);
        return max === null || age > max ? age : max;
      }, null);
      const deferred = queue.messages.filter((m) => m.queueName === 'deferred').length;
      const state = gradeQueue(queue.messages.length, oldest);
      checks.push({
        id: 'queue',
        group: 'Очередь',
        title: 'Очередь Postfix',
        state,
        detail:
          `Писем в очереди: ${String(queue.messages.length)}` +
          (deferred > 0 ? `, из них отложено: ${String(deferred)}` : '') +
          (oldest === null
            ? ''
            : `. Самое старое ждёт ${String(Math.floor(oldest / 3600))} ч ${String(
                Math.floor((oldest % 3600) / 60),
              )} мин`) +
          (queue.truncated ? '. Очередь длиннее предела разбора — числа неполны' : ''),
        ...(state === 'ok'
          ? {}
          : { hint: 'Разбор — в разделе «Почтовый поток»: там видно, кому именно не уходит' }),
      });
    }

    /* --- Место на диске --------------------------------------------- */
    const snapshot = ctx.metrics?.latest ?? null;
    if (!snapshot) {
      checks.push({
        id: 'disk',
        group: 'Место',
        title: 'Свободное место',
        state: 'unknown',
        detail:
          'Сборщик показателей не запущен: занятость дисков не измеряется ' +
          '(MAIL_METRICS_INTERVAL_SECONDS = 0)',
      });
    } else {
      for (const volume of snapshot.volumes) {
        const usedPercent =
          volume.totalBytes > 0 ? (volume.usedBytes / volume.totalBytes) * 100 : 0;
        const state = gradeDisk(usedPercent);
        checks.push({
          id: `disk:${volume.path}`,
          group: 'Место',
          title: `Том ${volume.path}`,
          state,
          detail:
            `Занято ${String(Math.round(usedPercent * 10) / 10)} %, свободно ` +
            `${String(Math.round((volume.freeBytes / 1024 ** 3) * 10) / 10)} ГиБ`,
          ...(state === 'ok'
            ? {}
            : {
                hint:
                  'На заполненном томе Postfix перестаёт принимать почту, а Dovecot — ' +
                  'записывать письма в ящики. Что именно занимает место, видно на дашборде',
              }),
        });
      }
      if (snapshot.singleDevice) {
        checks.push({
          id: 'disk:single',
          group: 'Место',
          title: 'Тома на одном устройстве',
          state: 'warn',
          detail:
            'Письма, индексы и журналы лежат на одном разделе: разросшийся журнал остановит ' +
            'приём почты',
        });
      }
    }

    /*
     * КОНТЕЙНЕРЫ: запущены ли и сколько едят.
     *
     * Проверка по портам отвечает на вопрос «служба отвечает?» — и это
     * главный вопрос. Но она молчит о двух вещах, за которыми лезут в
     * консоль при разборе: контейнер в петле перезапусков (порт при этом
     * может успевать отвечать) и память всего стека на VPS с двумя
     * гигабайтами.
     *
     * Спрашиваем посредника — у него есть сокет Docker. Нет посредника —
     * не выдумываем: раздел просто не покажет эту группу, как и раньше.
     */
    if (ctx.serviceAgent?.configured === true) {
      try {
        const stack = await ctx.serviceAgent.stack();
        for (const item of stack) {
          const running = item.state === 'running';
          const healthy = item.health === 'healthy' || item.health === 'none';
          const restarts = Number(item.restarts ?? '0');

          let state: 'ok' | 'warn' | 'fail' = 'ok';
          if (!running) state = 'fail';
          else if (!healthy) state = 'warn';
          // Больше десятка перезапусков — это петля, даже если прямо
          // сейчас контейнер поднят: он поднимется и упадёт снова.
          else if (restarts >= 10) state = 'warn';

          const parts: string[] = [`состояние: ${item.state}`];
          if (item.health !== 'none') parts.push(`проба: ${item.health}`);
          if (item.memory !== undefined && item.memory !== '') {
            parts.push(`память: ${item.memory}`);
          }
          if (restarts > 0) parts.push(`перезапусков: ${String(restarts)}`);

          checks.push({
            id: `container-${item.service}`,
            group: 'Контейнеры',
            title: `Контейнер ${item.service}`,
            state,
            detail: parts.join(', '),
            ...(state === 'ok'
              ? {}
              : {
                  hint:
                    restarts >= 10
                      ? 'Похоже на петлю перезапусков: смотрите журнал этой службы в разделе «Журналы почты».'
                      : 'Поднять: docker compose -f infra/docker-compose.yml -f install/compose.prod.yml up -d ' +
                        item.service,
                }),
          });
        }
      } catch {
        // Посредник не ответил — это уже видно в разделе перезапуска
        // служб, второй раз кричать об этом здесь незачем.
      }

      /*
       * ПОРТЫ НАРУЖУ и ПРАВА infra/.env — ещё два пункта из списка «чего
       * этот раздел не проверяет», и оба закрываются тем же посредником.
       *
       * Порт, привязанный к 127.0.0.1, изнутри контейнера неотличим от
       * открытого наружу: видна только внутренняя сеть Docker. А разница
       * решающая — 25-й порт на localhost означает, что чужие серверы не
       * доставят ни одного письма, и узнают об этом по молчанию.
       *
       * Права файла настроек — вопрос того же рода: в нём пароль базы и
       * ключи шифрования, а прочитать его сервер приложения не может и не
       * должен. Посредник отдаёт режим доступа и числа, но не значения.
       */
      try {
        const audit = await ctx.serviceAgent.audit();

        // Порты, без которых почта не работает как почта. 25-й — приём от
        // чужих серверов, 465/993 — отправка и чтение почтовыми
        // программами. Остальные (веб, панель) намеренно не проверяем:
        // за прокси на localhost они стоят законно.
        const MAIL_PORTS = [
          { port: 25, what: 'приём почты от чужих серверов' },
          { port: 465, what: 'отправка из почтовых программ' },
          { port: 993, what: 'чтение почты почтовыми программами' },
        ];
        for (const { port, what } of MAIL_PORTS) {
          const rows = audit.ports.filter((p) => p.host === port && p.proto === 'tcp');
          if (rows.length === 0) continue;
          const outside = rows.some((row) => row.public);
          const binds = [...new Set(rows.map((row) => row.bind))].join(', ');
          checks.push({
            id: `port-${String(port)}`,
            group: 'Порты наружу',
            title: `Порт ${String(port)} — ${what}`,
            state: outside ? 'ok' : 'fail',
            detail: outside
              ? `слушает на всех адресах машины (${binds})`
              : `слушает только на ${binds}: снаружи порт закрыт`,
            ...(outside
              ? {}
              : {
                  hint:
                    'Порт привязан к адресу самой машины. Проверьте BIND_ADDRESS в настройках ' +
                    'сервера: пустое значение означает «на всех адресах». Отдельно проверьте, ' +
                    'что порт не закрыт пакетным фильтром хоста и провайдером.',
                }),
          });
        }

        // Права файла настроек.
        if (audit.env.readable) {
          const open = audit.env.groupReadable === true || audit.env.worldReadable === true;
          /*
           * Непришедшее поле — это «не проверяли», а не «нарушений ноль».
           *
           * Раньше здесь стояло `?? 0`, и разница выходила ровно
           * противоположной смыслу: посредник постарше или сбойный разбор
           * не присылали поля вовсе — а панель показывала зелёную строку
           * «файл настроек в порядке». То есть проверка, которая ничего
           * не проверила, отчитывалась как успешная. Это худший вид
           * молчания: человек видит ОК там, где не смотрели.
           */
          const stale = audit.env.sameAsExample;
          const crlf = audit.env.crlfLines;
          const unchecked: string[] = [];
          if (stale === undefined) unchecked.push('совпадение значений с примером');
          if (crlf === undefined) unchecked.push('концы строк');

          const notes: string[] = [`права ${audit.env.mode ?? '?'}`];
          if (audit.env.keys !== undefined) notes.push(`ключей: ${String(audit.env.keys)}`);
          if (stale !== undefined && stale > 0) notes.push(`значений из примера: ${String(stale)}`);
          if (crlf !== undefined && crlf > 0) {
            notes.push(`строк с возвратом каретки: ${String(crlf)}`);
          }
          if (unchecked.length > 0) notes.push(`не проверено: ${unchecked.join(', ')}`);

          let state: 'ok' | 'warn' | 'fail' = 'ok';
          let hint: string | undefined;
          if (open) {
            // Пароль базы и ключи шифрования, доступные на чтение кому-то
            // ещё, — это выданные ключи от всего сервера.
            state = 'fail';
            hint = 'Закрыть: chmod 600 infra/.env';
          } else if (stale !== undefined && stale > 0) {
            state = 'warn';
            hint =
              'Часть значений совпадает с примером из репозитория — вероятно, это ' +
              'пароли-заглушки, которые знает любой, кто видел исходники. Смените их ' +
              'и пересоздайте затронутые службы. Какие именно — намеренно не показываем: ' +
              'ответ панели не должен быть подсказкой для подбора.';
          } else if (crlf !== undefined && crlf > 0) {
            // Возврат каретки уезжает в значение переменной целиком.
            state = 'warn';
            hint =
              'Файл сохранён с виндовыми концами строк. Значения получат лишний символ в ' +
              'конце — пароль с ним не подойдёт. Исправить, не заменяя сам файл: ' +
              'tr -d "\\r" < infra/.env > /tmp/env.fix && cat /tmp/env.fix > infra/.env && ' +
              'rm -f /tmp/env.fix';
            // Именно так, а не через «sed -i»: тот не правит файл, а
            // заменяет его новым, и посредник остаётся с прежним —
            // настройки из панели после такой «починки» перестают
            // доходить до служб (см. write_env в agent.pl).
          } else if (unchecked.length > 0) {
            /*
             * Проверить не смогли — говорим об этом вслух.
             *
             * Зелёная строка означала бы «проверено и нарушений нет», а
             * это неправда: посредник не прислал полей. Молчаливое ОК
             * здесь опаснее любого предупреждения — именно на такую
             * строку человек и смотрит, чтобы больше не смотреть.
             */
            state = 'warn';
            hint =
              'Посредник не прислал часть данных о файле настроек. Проверьте, что служба ' +
              'service-agent поднята и обновлена: docker compose up -d --build service-agent';
          }

          checks.push({
            id: 'env-file',
            group: 'Порты наружу',
            title: 'Файл настроек infra/.env',
            state,
            detail: notes.join(', '),
            ...(hint === undefined ? {} : { hint }),
          });
        }
      } catch {
        // Посредник не ответил — молчим по той же причине, что и выше.
      }
    }

    /*
     * База стран — только если проверку страны включили.
     *
     * Выключенная проверка не показывается вовсе: строка «база не
     * загружена» рядом с настройкой, которую никто не включал, читается
     * как поломка. А вот включённая политика без базы — настоящая беда:
     * администратор уверен, что вход ограничен страной, а на деле не
     * ограничен ничем.
     */
    const geoip = app.deps.geoip;
    if (geoip?.enabled === true) {
      const state = geoip.state;
      const ageDays =
        state.fileDate === null
          ? null
          : Math.floor((Date.now() - state.fileDate.getTime()) / 86_400_000);
      // Выпуск базы ежемесячный. Два месяца — уже заметный разрыв:
      // диапазоны переходят между странами постоянно.
      const stale = ageDays !== null && ageDays > 60;

      checks.push({
        id: 'geoip-db',
        group: 'Порты наружу',
        title: 'База стран для проверки входа',
        state: !state.loaded ? 'fail' : stale ? 'warn' : 'ok',
        detail: state.loaded
          ? `диапазонов: ${String(state.rows)}` +
            (ageDays === null ? '' : `, файлу ${String(ageDays)} дн.`) +
            (state.skipped > 0 ? `, пропущено строк: ${String(state.skipped)}` : '')
          : (state.error ?? 'файл базы не прочитан'),
        ...(state.loaded && !stale
          ? {}
          : {
              hint: state.loaded
                ? 'База выпускается ежемесячно. Обновить: bash install/fetch-geoip.sh'
                : 'Проверка страны включена, но базы нет — значит вход не ограничен ничем, ' +
                  'хотя настройка говорит обратное. Скачать: bash install/fetch-geoip.sh',
            }),
      });
    }

    /*
     * Обновление: докатана ли база и когда снимали копию.
     *
     * Оба каталога смонтированы только на чтение — это файлы продукта и
     * одна строка с датой. Раньше оба вопроса стояли в списке «чего этот
     * раздел не проверяет», хотя ответить на них ничего не мешало.
     */
    const files = await readMigrationFiles(ctx.config.MIGRATIONS_DIR);
    /*
     * gradeMigrations зовётся ВСЕГДА, в том числе когда файлов не видно.
     *
     * Здесь стояло `if (files.length > 0)`, и при несмонтированном
     * каталоге строка про миграции просто исчезала из списка. Человек
     * видел раздел без единого упоминания схемы и читал это единственным
     * доступным способом: «раз не жалуется — значит докатано». Означало
     * же оно обратное: readMigrationFiles глотает любую ошибку чтения, и
     * о состоянии схемы не известно НИЧЕГО — в том числе о непримененной
     * миграции, из-за которой разделы панели начинают отвечать 503.
     *
     * Ответ на этот случай в самой проверке был написан с самого начала
     * («Каталог миграций не виден серверу приложения», состояние
     * unknown) — до него просто не доходило управление. Пропавшая
     * проверка хуже красной: красную видно.
     */
    let applied = new Set<string>();
    try {
      const rows = await ctx.db.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations',
      );
      applied = new Set(rows.map((row) => row.filename));
    } catch {
      // Журнала миграций нет (сам он появляется миграцией 0000) —
      // значит не применено ничего, и проверка так и скажет.
    }
    checks.push(gradeMigrations({ files, applied }));

    checks.push(gradeBackup({ at: await readLastBackup(ctx.config.INSTALL_STATE_DIR) }));

    return {
      takenAt: new Date().toISOString(),
      summary: summarize(checks),
      checks,
      shellOnly: SHELL_ONLY_CHECKS,
      shellOnlyNote:
        'Полную проверку, включая внешние адреса, права файлов и сквозную отправку письма, ' +
        'делает install/selfcheck.sh на самом сервере',
    };
  });

  /* ---------------------------------------------------------------- */
  /* Сквозная проверка доставки                                         */
  /* ---------------------------------------------------------------- */

  /*
   * Последний пункт из списка «чего этот раздел не проверяет» — и
   * единственный, который нельзя было закрыть просто добавив проверку в
   * общую сводку. Она отправляет НАСТОЯЩЕЕ письмо, а раздел открывают
   * вкладками и держат часами: фоновая отправка превратила бы почтовый
   * сервер в свалку собственного мусора.
   *
   * Поэтому отдельная кнопка и осознанное нажатие. Ограничение частоты —
   * три запуска в минуту: проверка идёт до сорока пяти секунд, и чаще её
   * нажимать незачем даже нарочно.
   *
   * Право спрашивается не «посмотреть», а «перезапускать службы»: это
   * действие, меняющее состояние сервера, пусть и обратимо.
   */
  app.post<{ Body: unknown }>(
    '/monitoring/mail-roundtrip',
    {
      preHandler: requireAdmin(app, 'services.restart'),
      config: { rateLimit: { max: 3, timeWindow: 60_000 } },
    },
    async (request) => {
      const { mailbox } = z
        .object({ mailbox: z.string().trim().min(3).max(320).email() })
        .parse(request.body);

      const accounts = loadAccountsConfig();
      if (accounts.DOVECOT_MASTER_USER === '' || accounts.DOVECOT_MASTER_PASSWORD === '') {
        // Пароль владельца ящика для этого не спрашивается и не хранится,
        // поэтому без служебного пользователя проверять нечем.
        throw new ApiError(
          503,
          'MASTER_NOT_CONFIGURED',
          'Сквозная проверка требует служебного пользователя Dovecot: задайте ' +
            'DOVECOT_MASTER_USER и DOVECOT_MASTER_PASSWORD в infra/.env и пересоздайте службы.',
        );
      }

      const result = await runRoundtrip(mailbox, {
        smtp: {
          host: apiConfig.SMTP_HOST,
          port: apiConfig.SMTP_PORT,
          rejectUnauthorized: apiConfig.TLS_REJECT_UNAUTHORIZED,
        },
        imap: {
          host: apiConfig.IMAP_HOST,
          port: apiConfig.IMAP_PORT,
          secure: apiConfig.IMAP_SECURE,
          rejectUnauthorized: apiConfig.TLS_REJECT_UNAUTHORIZED,
        },
        master: {
          user: accounts.DOVECOT_MASTER_USER,
          password: accounts.DOVECOT_MASTER_PASSWORD,
          separator: accounts.DOVECOT_MASTER_SEPARATOR,
        },
      });

      await audit(ctx, request, {
        action: 'monitoring.roundtrip',
        targetType: 'mailbox',
        targetLabel: mailbox,
        after: { ok: result.ok, seconds: result.seconds },
      });

      return result;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Сертификаты и DNS                                                  */
  /* ---------------------------------------------------------------- */

  app.get('/monitoring/expiry', { preHandler: requireAdmin(app, 'overview.read') }, async () => {
    const targets: TlsTarget[] = [
      {
        title: 'Отправка почты (SMTPS 465)',
        host: apiConfig.SMTP_HOST,
        port: 465,
        implicitTls: true,
      },
      {
        title: 'Чтение почты (IMAPS 993)',
        host: apiConfig.IMAP_HOST,
        port: 993,
        implicitTls: true,
      },
      {
        title: 'Чтение почты (POP3S 995)',
        host: apiConfig.IMAP_HOST,
        port: 995,
        implicitTls: true,
      },
    ];
    const [certificates, domains, renewal, certSource] = await Promise.all([
      readCertificates(targets),
      ctx.db.listDomains().catch(() => []),
      /*
       * Состояние автопродления. Оно обязано быть ИМЕННО ЗДЕСЬ, а не
       * только в разделе «Сертификат»: раздел открывают нарочно, когда
       * уже что-то заподозрили, а сюда смотрят каждый день. Отказавшее
       * продление не меняет ни одного показателя — срок просто перестаёт
       * отодвигаться, — и заметить это без отдельной проверки нельзя.
       */
      readRenewalReport(ctx.config.TLS_CERT_DIR),
      readCertificateSource(ctx.config.TLS_CERT_DIR),
    ]);

    /**
     * Дата по-русски, ДД.ММ.ГГГГ.
     *
     * Не ISO-строкой: «до 2036-08-02T01:53:49.000Z» в строке про срок
     * действия читается как техническая отладка, а не как ответ на вопрос
     * «когда продлевать». Часовой пояс тут не важен — счёт идёт на сутки.
     */
    const dayOf = (iso: string | null): string => {
      if (iso === null) return '?';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '?';
      const pad = (value: number): string => String(value).padStart(2, '0');
      return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear())}`;
    };

    const certificateChecks: HealthCheck[] = certificates.map((cert) => {
      const state: CheckState = cert.available
        ? gradeCertificate(cert.daysLeft, TLS_WARN_DAYS)
        : 'fail';
      return {
        id: `cert:${cert.host}:${String(cert.port)}`,
        group: 'Сертификаты',
        title: cert.title,
        state,
        detail: !cert.available
          ? (cert.error ?? 'Сертификат не прочитан')
          : cert.daysLeft === null
            ? 'Срок действия прочитать не удалось'
            : cert.daysLeft <= 0
              ? `Истёк ${String(-cert.daysLeft)} суток назад`
              : `Действует ещё ${String(cert.daysLeft)} суток, до ${dayOf(cert.validTo)}` +
                (cert.selfSigned ? '; самоподписанный' : ''),
        ...(state === 'ok' ? {} : { hint: `Продление: ${RENEW_COMMAND} (при отказе — с --force)` }),
      };
    });

    certificateChecks.push(renewalHealthCheck(renewal, certSource));

    const dnsChecks: HealthCheck[] = domains.map((domain) => {
      const overall = domain.dns_overall ?? 'unknown';
      const state: CheckState =
        overall === 'ok'
          ? 'ok'
          : overall === 'warn'
            ? 'warn'
            : overall === 'fail'
              ? 'fail'
              : 'unknown';
      const checkedAt = domain.dns_checked_at;
      // Проверка недельной давности — это не «проверено»: записи меняют у
      // регистратора, и панель об этом не узнаёт, пока не спросит заново.
      const staleDays =
        checkedAt === null ? null : Math.floor((Date.now() - checkedAt.getTime()) / 86_400_000);
      /*
       * УСТАРЕВШАЯ ПРОВЕРКА НЕ БЫВАЕТ ЗЕЛЁНОЙ.
       *
       * Правило записано строкой выше, но в состояние не входило:
       * `staleDays` попадал только в текст и в подсказку. Домен,
       * проверенный полгода назад с итогом «всё в порядке», давал
       * зелёную строку «Проверка 180 суток назад: все записи на месте» —
       * то есть раздел уверял, что почта дойдёт, ничего об этом не зная.
       * Записи меняют у регистратора, и панель узнаёт об этом, только
       * когда спросит заново.
       *
       * Зелёной остаётся свежая проверка (моложе недели); всё, что
       * старше, — жёлтая: не «сломано», а «неизвестно».
       */
      const fresh = staleDays !== null && staleDays < DNS_FRESH_DAYS;
      const shown = checkedAt === null ? 'unknown' : state === 'ok' && !fresh ? 'warn' : state;
      return {
        id: `dns:${String(domain.id)}`,
        group: 'DNS',
        title: `Записи домена ${domain.name}`,
        state: shown,
        detail:
          checkedAt === null
            ? 'Ни разу не проверялись: неизвестно, дойдёт ли до нас почта и не уйдёт ли наша в спам'
            : `Проверка ${staleDays === 0 ? 'сегодня' : `${String(staleDays)} суток назад`}: ` +
              (overall === 'ok'
                ? 'все записи на месте'
                : overall === 'warn'
                  ? 'есть замечания'
                  : 'записи не настроены'),
        ...(state === 'ok' && fresh ? {} : { hint: 'Проверить заново — в разделе «Домены и DNS»' }),
      };
    });

    const checks = [...certificateChecks, ...dnsChecks];
    return {
      takenAt: new Date().toISOString(),
      warnDays: TLS_WARN_DAYS,
      summary: summarize(checks),
      checks,
      certificateNote:
        'Сертификат читается из живого соединения со службой, а не из файла: после обновления ' +
        'файла служба продолжает отдавать старый, пока её не перезапустят. Состояние ' +
        'автопродления — из отчёта, который оставляет install/renew-certs.sh на самом сервере; ' +
        'подробности и история попыток — в разделе «Сертификат»',
      dnsNote:
        'Состояние DNS показано по последней проверке в разделе «Домены и DNS»; сам этот ' +
        'раздел записи заново не спрашивает',
    };
  });

  /* ---------------------------------------------------------------- */
  /* Последние отказы                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Что не доставлено за последние часы.
   *
   * Право audit.read, а не overview.read: здесь адреса отправителей и
   * получателей, то есть та же чувствительность, что у журналов почты.
   */
  app.get(
    '/monitoring/failures',
    { preHandler: requireAdmin(app, 'audit.read') },
    async (request) => {
      const q = z
        .object({
          hours: z.coerce
            .number()
            .int()
            .min(1)
            .max(24 * 7)
            .default(24),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(request.query);
      const to = new Date();
      const from = new Date(to.getTime() - q.hours * 3600_000);

      if (!(await flow.schemaReady())) {
        return {
          available: false,
          note:
            'История доставки недоступна: не применена миграция 0007_mail_flow.sql. ' +
            'Остальные проверки раздела работают и без неё',
          hours: q.hours,
          items: [],
          counts: {},
          rspamdErrors: [],
        };
      }

      const [events, stats, rspamdErrors] = await Promise.all([
        flow.listEvents({
          from,
          to,
          statuses: ['rejected', 'bounced', 'expired'],
          limit: q.limit,
        }),
        flow.stats(from, to),
        // Ошибки самого антиспама: они не видны ни в журнале Postfix, ни в
        // истории доставки — письмо при этом проходит «успешно», просто без
        // части проверок.
        rspamd.errors(10).catch(() => []),
      ]);

      return {
        available: true,
        note:
          'Отказы и возвраты за выбранное окно по разобранному журналу Postfix. Отложенные ' +
          '(deferred) сюда не попадают: они ещё не потеряны и видны в очереди',
        hours: q.hours,
        counts: stats.counts,
        items: events.map((row) => ({
          id: row.id,
          at: row.occurred_at.toISOString(),
          status: row.status,
          sender: row.sender,
          recipient: row.recipient,
          dsn: row.dsn,
          reason: row.reason,
        })),
        rspamdErrors,
      };
    },
  );
}
