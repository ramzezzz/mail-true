/**
 * Клиент к посреднику перезапуска служб.
 *
 * ОТКУДА ВЗЯЛСЯ ПОСРЕДНИК. Перезапустить службу нельзя, не имея доступа к
 * Docker, а сокет Docker — это права root на всей машине. Серверу
 * приложения, который принимает запросы из интернета и разбирает чужие
 * письма, такой доступ не даётся ни за какую возможность. Поэтому сокет
 * выдан отдельной маленькой службе, умеющей ровно две вещи над закрытым
 * списком служб (infra/service-agent/agent.pl), а здесь — клиент к ней.
 *
 * Устроено так же, как посредник очереди Postfix (queue-agent.ts):
 * общий секрет в заголовке, честный отказ вместо тишины, объяснение
 * причины словами. Второй посредник, а не расширение первого, потому что
 * тот живёт ВНУТРИ контейнера postfix и рядом с очередью — сокета Docker
 * у него нет и быть не должно.
 *
 * ОТКАЗ ВМЕСТО ТИШИНЫ. Стек можно поднять и без посредника — например,
 * старым docker-compose.yml или без секрета в infra/.env. Тогда все
 * методы здесь бросают ServiceAgentUnavailableError с текстом, который
 * панель показывает человеку вместе с командой для консоли. Кнопка,
 * которая молча ничего не делает, хуже отсутствующей кнопки.
 */
import type { Logger } from 'pino';
import { ApiError } from '../errors.js';
import { RepeatGuard, warnOnce } from './repeat-log.js';
import type { RestartAction, RestartTarget } from './restart-targets.js';

/** Состояние службы после того, как её тронули. */
export interface ServiceState {
  service: string;
  /** running | exited | restarting | absent | unknown — как у Docker. */
  state: string;
  /** healthy | unhealthy | starting | none — none у служб без пробы. */
  health: string;
  /** Поднялась ли служба по мнению посредника. */
  up: boolean;
  /** Почему не поднялась: причина плюс хвост журнала контейнера. */
  detail: string | null;
  startedAt: string | null;
  exitCode: string | null;
  restarts: string | null;
}

export interface ServiceAgentOptions {
  /** Пусто — посредник не настроен, чужие службы из панели не перезапускаются. */
  baseUrl: string;
  token: string;
  logger: Logger;
  /**
   * Предел ожидания. Больше, чем у очереди, и намеренно: посредник
   * дожидается, пока служба объявит себя здоровой, а у Dovecot и Postfix
   * это десяток секунд даже в спокойной обстановке.
   */
  timeoutMs?: number;
}

/** Посредник не настроен или не отвечает. */
export class ServiceAgentUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'SERVICE_AGENT_UNAVAILABLE', message);
    this.name = 'ServiceAgentUnavailableError';
  }
}

const NOT_CONFIGURED =
  'Перезапуск служб из панели недоступен: не настроен посредник. Задайте ' +
  'SERVICE_AGENT_TOKEN в infra/.env (тот же секрет получает служба service-agent) ' +
  'и поднимите стек заново. Без секрета посредник не открывает порт вовсе — ' +
  'это защита, а не сбой.';

export class ServiceAgent {
  private readonly timeoutMs: number;
  /**
   * Сторож повторов. Раздел настроек открывают вкладками, и каждая
   * спрашивает, доступен ли посредник. Не поднявшийся посредник —
   * состояние на часы, и без сторожа оно писало бы в журнал строку на
   * каждый опрос (см. repeat-log.ts).
   */
  private readonly failures = new RepeatGuard();

  constructor(private readonly opts: ServiceAgentOptions) {
    this.timeoutMs = opts.timeoutMs ?? 150_000;
  }

  /** Настроен ли посредник. Пустой секрет — это «нет», а не «попробуем». */
  get configured(): boolean {
    return this.opts.baseUrl !== '' && this.opts.token !== '';
  }

  private assertConfigured(): void {
    if (!this.configured) throw new ServiceAgentUnavailableError(NOT_CONFIGURED);
  }

  /**
   * Сколько ждать ЧИТАЮЩИЙ вызов.
   *
   * Посредник — строго последовательный цикл `accept` без ветвления: один
   * запрос за раз. Пересоздание службы держит его на всё время
   * `docker compose up -d` плюс ожидание готовности, и всё это время
   * читающие `/healthz`, `/stack`, `/audit` стоят в очереди.
   *
   * Ждать их по общему пределу (150 секунд) нельзя: раздел «Наблюдение»
   * — это то место, куда идут, когда что-то не так, в том числе когда
   * подвис демон Docker (типичное состояние при забитом диске). У nginx
   * на админских маршрутах стоит 120 секунд, и запрос просто возвращал
   * 504: администратор терял раздел целиком, вместе с уже посчитанными
   * пробами портов, очередью, диском и сертификатами.
   *
   * Десять секунд — заведомо больше, чем нужно исправному посреднику, и
   * заведомо меньше терпения nginx.
   */
  private static readonly READ_TIMEOUT_MS = 10_000;

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: URLSearchParams,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    this.assertConfigured();
    let response: Response;
    try {
      response = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          'X-Agent-Token': this.opts.token,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body ? { body: body.toString() } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      warnOnce(this.failures, this.opts.logger, err, 'Посредник перезапуска не отвечает', { path });
      throw new ServiceAgentUnavailableError(
        'Посредник перезапуска не отвечает. Проверьте, что служба service-agent поднята: ' +
          'docker compose -f infra/docker-compose.yml up -d service-agent',
      );
    }
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ServiceAgentUnavailableError(
        `Посредник перезапуска ответил не по формату (код ${String(response.status)}).`,
      );
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new ServiceAgentUnavailableError(
          'Посредник перезапуска не принял секрет: SERVICE_AGENT_TOKEN у api и у службы ' +
            'service-agent должны совпадать.',
        );
      }
      const detail =
        typeof parsed.error === 'string' ? parsed.error : `код ${String(response.status)}`;
      throw new ServiceAgentUnavailableError(`Посредник перезапуска отказал: ${detail}`);
    }
    return parsed;
  }

  /** Жив ли посредник и что он о себе знает. Ответ не кэшируется намеренно. */
  async health(): Promise<{ ok: boolean; project: string; error: string | null }> {
    const body = await this.call('/healthz', 'GET', undefined, ServiceAgent.READ_TIMEOUT_MS);
    return {
      ok: body.ok === true,
      project: typeof body.project === 'string' ? body.project : '',
      error: typeof body.error === 'string' && body.error !== '' ? body.error : null,
    };
  }

  /** Состояние службы, ничего не трогая. */
  async status(target: RestartTarget): Promise<ServiceState> {
    return readState(await this.call(`/status?service=${encodeURIComponent(target.id)}`, 'GET'));
  }

  /**
   * Состояние всего стека: что запущено, здорово ли, сколько
   * перезапусков и сколько памяти занято.
   *
   * Первый пункт в списке «чего раздел не проверяет» — и стоял он там с
   * верной причиной: нужен сокет Docker, а серверу приложения его давать
   * нельзя. Причина в силе, изменилось другое: сокет есть у посредника, и
   * он умеет отдать это чтением, не открывая ничего лишнего.
   */
  async stack(): Promise<
    Array<ServiceState & { memory?: string; memPerc?: string; cpuPerc?: string }>
  > {
    const body = await this.call('/stack', 'GET', undefined, ServiceAgent.READ_TIMEOUT_MS);
    const list = Array.isArray(body.services) ? body.services : [];
    return list.map((item) => {
      const row = item as Record<string, unknown>;
      const state = readState(row);
      return {
        ...state,
        ...(typeof row.memory === 'string' ? { memory: row.memory } : {}),
        ...(typeof row.memPerc === 'string' ? { memPerc: row.memPerc } : {}),
        ...(typeof row.cpuPerc === 'string' ? { cpuPerc: row.cpuPerc } : {}),
      };
    });
  }

  /**
   * То, чего сервер приложения о себе узнать не может: на каких адресах
   * слушают порты и кто может прочитать infra/.env.
   *
   * Оба вопроса упираются в одно и то же: изнутри контейнера видно только
   * внутреннюю сеть Docker, а файл настроек сюда не примонтирован и
   * монтироваться не должен. Посредник отдаёт вердикты и числа, но не
   * значения — ответ не должен превращаться в подсказку, какой пароль
   * подбирать первым.
   */
  async audit(): Promise<{
    ports: Array<{
      service: string;
      container: number;
      host: number;
      proto: string;
      bind: string;
      public: boolean;
    }>;
    env: {
      readable: boolean;
      mode?: string;
      groupReadable?: boolean;
      worldReadable?: boolean;
      crlfLines?: number;
      keys?: number;
      sameAsExample?: number;
    };
  }> {
    return parseAudit(await this.call('/audit', 'GET', undefined, ServiceAgent.READ_TIMEOUT_MS));
  }

  /**
   * Убрать ключи из infra/.env, ничего не пересоздавая.
   *
   * Зовётся при возврате настройки к умолчанию: строка в файле осталась
   * бы навсегда, и панель показывала бы одно, а служба поднималась с
   * другим. Догадываться, писала ли панель этот ключ, по источнику
   * значения нельзя — внутрь контейнера ключи приходят под другими
   * именами. Поэтому убираем ровно тогда, когда человек явно нажал
   * «вернуть к умолчанию».
   */
  async unsetEnv(target: RestartTarget, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const form = new URLSearchParams();
    form.set('keys', keys.join(','));
    await this.call(`/env-unset?service=${encodeURIComponent(target.id)}`, 'POST', form);
  }

  /**
   * Выпустить сертификат Let's Encrypt и разложить его по стеку.
   *
   * До сих пор это умела только консоль (install/renew-certs.sh), и
   * переход с самоподписанного на настоящий требовал доступа к серверу —
   * при том что панель показывает срок, предупреждает об истечении и
   * умеет поставить свой сертификат.
   *
   * Долгая операция: проверка домена, обращение к Let's Encrypt и
   * остановка nginx на время проверки. Предел ожидания у клиента общий
   * (150 с) и его хватает: обычный выпуск — секунды.
   */
  async issueLetsEncrypt(input: {
    domains: readonly string[];
    email: string;
    staging: boolean;
  }): Promise<{ certName: string; staging: boolean; output: string }> {
    const form = new URLSearchParams();
    form.set('domains', input.domains.join(','));
    form.set('email', input.email);
    form.set('staging', input.staging ? '1' : '0');
    const body = await this.call('/certbot', 'POST', form);
    return {
      certName: typeof body.cert_name === 'string' ? body.cert_name : '',
      staging: body.staging === true,
      output: typeof body.output === 'string' ? body.output : '',
    };
  }

  /**
   * Готовая строка DNS для DKIM: то, что rspamd сам положил рядом с
   * ключом. Публичная часть — та же, что потом уходит в общедоступный
   * DNS; приватный ключ посредник не отдаёт ни при каких параметрах.
   *
   * Нужно, потому что панель до сих пор отправляла человека в консоль:
   * «зайдите на сервер, откройте файл внутри контейнера rspamd,
   * скопируйте оттуда p=». Установщик эту строку печатает сам — значит
   * и панель может её показать.
   */
  async dkimRecord(domain: string, selector: string): Promise<string> {
    const query = `domain=${encodeURIComponent(domain)}&selector=${encodeURIComponent(selector)}`;
    const body = await this.call(`/dkim?${query}`, 'GET');
    return typeof body.record === 'string' ? body.record : '';
  }

  /**
   * Перезапустить или пересоздать службу.
   *
   * Имя службы берётся из ОПИСАНИЯ (RestartTarget), а не из строки
   * запроса: до этого места строка обязана была пройти проверку по
   * закрытому списку (см. resolveTarget в restart-targets.ts). Здесь же
   * повторно проверяется, что действие для этой службы разрешено, —
   * ошибка в вызывающем коде не должна превращаться в неожиданную
   * команду посреднику.
   *
   * `env` — значения, которые обязаны попасть в infra/.env до
   * пересоздания, иначе новый контейнер получит прежнее окружение и
   * настройка молча не подействует. Ключи посредник сверяет со СВОИМ
   * списком, своим для каждой службы.
   */
  async apply(
    target: RestartTarget,
    action: RestartAction,
    env: Readonly<Record<string, string>> = {},
  ): Promise<ServiceState> {
    if (!target.actions.includes(action)) {
      throw new ServiceAgentUnavailableError(
        `Для службы «${target.id}» действие «${action}» не предусмотрено.`,
      );
    }
    const path = `/${action === 'recreate' ? 'recreate' : 'restart'}?service=${encodeURIComponent(
      target.id,
    )}`;
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(env)) form.set(key, value);
    return readState(await this.call(path, 'POST', action === 'recreate' ? form : undefined));
  }
}

/** Разбор ответа посредника. Всё строками: числами он наружу не отдаёт ничего. */
function readState(body: Record<string, unknown>): ServiceState {
  const str = (key: string): string | null => {
    const value = body[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return {
    service: str('service') ?? '',
    state: str('state') ?? 'unknown',
    health: str('health') ?? 'none',
    up: body.ok === true,
    detail: str('detail'),
    startedAt: str('startedAt'),
    exitCode: str('exitCode'),
    restarts: str('restarts'),
  };
}

/**
 * Человеческое объяснение состояния службы. Живёт здесь, а не в панели:
 * тот же текст нужен и журналу перезапусков, и записи аудита, а второй
 * набор формулировок для одного и того же состояния однажды разошёлся бы
 * с первым.
 */
export function describeState(state: ServiceState): string {
  if (state.up) {
    const health = state.health === 'healthy' ? ', проба контейнера зелёная' : '';
    return `Служба поднялась (${state.state}${health}).`;
  }
  const base =
    state.state === 'absent'
      ? 'Контейнера службы в проекте нет вовсе.'
      : `Служба не поднялась: состояние «${state.state}», проба «${state.health}».`;
  return state.detail === null ? base : `${base} ${state.detail}`;
}

/** Порт, опубликованный наружу, глазами посредника. */
export interface AuditPort {
  service: string;
  container: number;
  host: number;
  proto: string;
  bind: string;
  public: boolean;
}

/** Состояние файла настроек: вердикты и числа, без единого значения. */
export interface AuditEnv {
  readable: boolean;
  mode?: string;
  groupReadable?: boolean;
  worldReadable?: boolean;
  crlfLines?: number;
  keys?: number;
  sameAsExample?: number;
}

/*
 * Число может прийти строкой — и приходит.
 *
 * Посредник написан на Perl без библиотеки JSON: там число и строка не
 * различаются, и в ответе оказывается "993", а не 993. Первая версия
 * разбора требовала именно number — и молча выбрасывала ВСЕ порты,
 * оставляя раздел без единой проверки. Именно молча: пустой список
 * неотличим от «портов нет вовсе», и на живом сервере это выглядело как
 * «проверка не написана», а не как «проверка сломана».
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Разбор ответа /audit. Вынесен из класса, чтобы проверялся напрямую:
 * ошибка здесь не роняет ничего и не пишет в журнал — она просто убирает
 * проверки из раздела, а это самый дорогой вид поломки.
 */
export function parseAudit(body: Record<string, unknown>): { ports: AuditPort[]; env: AuditEnv } {
  const rawPorts = Array.isArray(body.ports) ? body.ports : [];
  const ports = rawPorts.flatMap((item): AuditPort[] => {
    const row = item as Record<string, unknown>;
    const host = toNumber(row.host);
    if (typeof row.service !== 'string' || host === undefined) return [];
    return [
      {
        service: row.service,
        container: toNumber(row.container) ?? 0,
        host,
        proto: typeof row.proto === 'string' ? row.proto : 'tcp',
        bind: typeof row.bind === 'string' ? row.bind : '',
        public: row.public === true,
      },
    ];
  });

  const rawEnv = (body.env ?? {}) as Record<string, unknown>;
  // Поле, которого посредник не прислал, не подставляется нулём или
  // ложью: «не ответил» и «ноль» — разные ответы, и раздел показывает их
  // по-разному.
  const num = (key: string): { [k: string]: number } => {
    const value = toNumber(rawEnv[key]);
    return value === undefined ? {} : { [key]: value };
  };
  const flag = (key: string): { [k: string]: boolean } =>
    typeof rawEnv[key] === 'boolean' ? { [key]: rawEnv[key] } : {};

  return {
    ports,
    env: {
      readable: rawEnv.readable === true,
      ...(typeof rawEnv.mode === 'string' ? { mode: rawEnv.mode } : {}),
      ...flag('groupReadable'),
      ...flag('worldReadable'),
      ...num('crlfLines'),
      ...num('keys'),
      ...num('sameAsExample'),
    },
  };
}
