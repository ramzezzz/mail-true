/**
 * Перезапуск служб глазами панели: тексты и состояние ожидания.
 *
 * Чистые функции без React — по той же причине, что и в остальной панели:
 * то, что здесь написано, проверяется без браузера, а компонент остаётся
 * тонким и занимается только разметкой.
 *
 * ------------------------------------------------------------------
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ РЕШАЕТСЯ
 * ------------------------------------------------------------------
 * «Панель должна вернуться сама». Сервер приложения, перезапуская себя,
 * не может ответить, чем это кончилось: его в этот момент нет. Значит
 * панель обязана понять это САМА — и понять надёжно, а не «подождём
 * десять секунд и обновим страницу».
 *
 * Надёжный признак ровно один: МЕТКА ПРОЦЕССА. Панель запоминает её до
 * нажатия и опрашивает сервер; пока метка та же — отвечает всё ещё
 * старый процесс (он закрывает текущие запросы и ещё жив). Пока сервер
 * не отвечает вовсе — идёт перезапуск, и это нормально, а не ошибка.
 * Метка сменилась — перед нами новый процесс, перезапуск удался.
 *
 * Без метки пришлось бы гадать: любой удачный ответ можно принять за
 * «сервер вернулся», хотя это тот же самый процесс, который ещё не начал
 * останавливаться, — и панель радостно отчиталась бы об успехе за
 * секунду до того, как связь пропадёт.
 */
import type {
  RestartAction,
  RestartJobState,
  RestartTarget,
  ServerSetting,
  SettingApply,
} from '../api/types';

/* ------------------------------------------------------------------ */
/* Тексты                                                              */
/* ------------------------------------------------------------------ */

/**
 * Подпись кнопки. Именно «пересоздать контейнер», а не «перезапустить»:
 * это разные действия с разной ценой, и человек должен видеть, какое из
 * них он запускает (см. группу recreate в перечне настроек).
 */
export function applyButtonLabel(target: RestartTarget, action: RestartAction): string {
  return action === 'recreate'
    ? `Пересоздать контейнер: ${lowerFirst(target.title)}`
    : `Перезапустить: ${lowerFirst(target.title)}`;
}

/** Короткая подпись рядом с настройкой: чем её включить. */
export function applyHint(apply: SettingApply, targets: readonly RestartTarget[]): string {
  const target = targets.find((t) => t.id === apply.target);
  const title = target ? lowerFirst(target.title) : apply.target;
  return apply.action === 'recreate'
    ? `пересоздать контейнер: ${title}`
    : `перезапустить: ${title}`;
}

/**
 * Строка «что нужно сделать, чтобы настройка заработала».
 *
 * Шагов бывает два (скажем, у имени продукта: пересоздать автонастройку
 * И перезапустить сервер приложения), и объединять их в «перезапустить
 * всё» нельзя: это разные службы с разными последствиями.
 */
export function appliesSummary(
  setting: Pick<ServerSetting, 'applies'>,
  targets: readonly RestartTarget[],
): string {
  const steps = setting.applies.map((a) => applyHint(a, targets));
  if (steps.length === 0) return 'действует сразу';
  return steps.join(', затем ');
}

/** Полное предупреждение перед нажатием: последствия, срок, что уцелеет. */
export interface ApplyWarning {
  title: string;
  impact: string;
  downtime: string;
  safe: string;
  /** Команда для консоли — её показывают, когда кнопка недоступна. */
  command: string | null;
  /** Почему нельзя нажать. null — можно. */
  blocked: string | null;
}

export function applyWarning(target: RestartTarget, action: RestartAction): ApplyWarning {
  return {
    title: applyButtonLabel(target, action),
    impact: target.impact,
    downtime: target.downtime,
    safe: target.safe,
    command: target.commands[action] ?? null,
    blocked: target.available ? null : target.unavailableReason,
  };
}

/**
 * Пересоздание контейнера — не просто «перезапуск подольше», и об этом
 * надо сказать отдельно: новый контейнер получает окружение из
 * infra/.env целиком, вместе со всем, что там успели поправить руками и
 * не применить. Умолчать об этом значило бы, что кнопка иногда делает
 * больше, чем обещает.
 */
export const RECREATE_NOTE =
  'Контейнер будет создан заново с окружением из infra/.env. Панель запишет туда только ' +
  'то, что задано в ней самой, но вместе с этим применится и всё, что кто-то ранее ' +
  'поправил в файле руками и не применял.';

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/* ------------------------------------------------------------------ */
/* Ожидание: панель возвращается сама                                   */
/* ------------------------------------------------------------------ */

export type WatchStatus =
  /** Идёт: опрашиваем сервер. */
  | 'polling'
  /** Служба поднялась. */
  | 'ok'
  /** Не поднялась, причина в detail. */
  | 'failed'
  /** Не дождались за отведённое время. */
  | 'timeout';

export interface WatchState {
  status: WatchStatus;
  /** Всего опросов с начала ожидания. */
  attempts: number;
  /** Сколько раз подряд сервер не ответил. Ноль — связь есть. */
  offline: number;
  /** Что показать человеку прямо сейчас. */
  message: string;
  /** Подробности итога: почему не поднялась. */
  detail: string | null;
}

export interface WatchLimits {
  /**
   * Сколько опросов терпеть. При шаге в секунду это и есть срок в
   * секундах. Двух минут хватает самому долгому подъёму (Dovecot с
   * большим индексом) и заметно меньше того, сколько человек готов
   * смотреть на «перезапускаю».
   */
  maxAttempts: number;
}

export const DEFAULT_WATCH_LIMITS: WatchLimits = { maxAttempts: 120 };
/** Шаг опроса. Чаще секунды незачем: перезапуск занимает секунды. */
export const WATCH_INTERVAL_MS = 1000;

export type WatchEvent =
  /** Сервер ответил о состоянии заявки. */
  | { type: 'job'; job: RestartJobState }
  /** Сервер не ответил вовсе. Во время перезапуска это норма, а не сбой. */
  | { type: 'offline' };

export function startWatch(target: RestartTarget, action: RestartAction): WatchState {
  return {
    status: 'polling',
    attempts: 0,
    offline: 0,
    message:
      action === 'recreate'
        ? `Пересоздаём контейнер: ${lowerFirst(target.title)}…`
        : `Перезапускаем: ${lowerFirst(target.title)}…`,
    detail: null,
  };
}

/**
 * Один шаг ожидания.
 *
 * `expectBootId` — метка процесса ДО нажатия. Смена метки означает, что
 * отвечает уже новый процесс сервера приложения; для перезапуска самого
 * себя это и есть доказательство успеха, причём более раннее и более
 * надёжное, чем запись в журнале: запись ставит тот же новый процесс, но
 * чуть позже, когда доберётся до базы.
 */
export function watchStep(
  state: WatchState,
  event: WatchEvent,
  expectBootId: string | null,
  limits: WatchLimits = DEFAULT_WATCH_LIMITS,
): WatchState {
  if (state.status !== 'polling') return state;
  const attempts = state.attempts + 1;

  if (event.type === 'offline') {
    if (attempts >= limits.maxAttempts) {
      return {
        status: 'timeout',
        attempts,
        offline: state.offline + 1,
        message: 'Сервер не вернулся',
        detail:
          `Связи с сервером приложения нет уже ${String(limits.maxAttempts)} секунд. ` +
          'Скорее всего, он не поднялся: посмотрите журнал контейнера — ' +
          'docker compose -f infra/docker-compose.yml logs --tail 100 api',
      };
    }
    return {
      status: 'polling',
      attempts,
      offline: state.offline + 1,
      // Отдельный текст на время обрыва: молчание сервера сейчас
      // ОЖИДАЕМО, и человек не должен принимать его за поломку.
      message: 'Связь с сервером пропала — так и должно быть, ждём его возвращения…',
      detail: null,
    };
  }

  const { job } = event;
  const bootChanged = expectBootId !== null && job.bootId !== null && job.bootId !== expectBootId;
  if (bootChanged) {
    return {
      status: 'ok',
      attempts,
      offline: 0,
      message: 'Сервер приложения вернулся',
      detail: job.detail,
    };
  }
  if (job.status === 'ok') {
    return { status: 'ok', attempts, offline: 0, message: 'Служба поднялась', detail: job.detail };
  }
  if (job.status === 'failed') {
    return {
      status: 'failed',
      attempts,
      offline: 0,
      message: 'Служба не поднялась',
      detail: job.detail,
    };
  }
  if (attempts >= limits.maxAttempts) {
    return {
      status: 'timeout',
      attempts,
      offline: 0,
      message: 'Ответа так и не пришло',
      detail:
        `Прошло ${String(limits.maxAttempts)} секунд, а служба всё ещё не сообщила о себе. ` +
        'Посмотрите её журнал в разделе «Журналы» или в консоли.',
    };
  }
  return { ...state, attempts, offline: 0 };
}

/** Идёт ли ожидание — панели, чтобы решить, опрашивать ли дальше. */
export function watching(state: WatchState | null): boolean {
  return state !== null && state.status === 'polling';
}
