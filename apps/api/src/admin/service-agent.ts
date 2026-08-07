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

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: URLSearchParams,
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
        signal: AbortSignal.timeout(this.timeoutMs),
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
    const body = await this.call('/healthz', 'GET');
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
