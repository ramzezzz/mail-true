/**
 * Автопродление TLS-сертификата: работает ли оно вообще.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ СРОКА САМОГО СЕРТИФИКАТА
 * ------------------------------------------------------------------
 * Срок панель показывает давно и честно — из живого рукопожатия со
 * службой (metrics-tls.ts). Но срок отвечает на вопрос «сколько осталось»,
 * а не «отодвинется ли он сам». Это разные вопросы, и второй важнее:
 * сертификат Let's Encrypt живёт 90 суток, продление занимает минуты, а
 * простой из-за истёкшего — часы. Разница между ними ровно в том, узнали
 * ли о поломке ПРОДЛЕНИЯ заранее.
 *
 * Молчаливый отказ продления и есть та поломка. Таймер не завёлся (при
 * установке без systemd его нет вовсе), certbot перестал проходить
 * проверку, порт 80 занял чужой веб-сервер — во всех трёх случаях срок
 * просто перестаёт отодвигаться, и заметить это можно не раньше, чем за
 * неделю до беды, да и то если сравнивать даты в уме.
 *
 * ------------------------------------------------------------------
 * ОТКУДА БЕРУТСЯ СВЕДЕНИЯ
 * ------------------------------------------------------------------
 * Из отчёта, который оставляет install/renew-certs.sh на хосте:
 * infra/data/certs/renewal.json. Каталог сертификатов примонтирован в
 * контейнер сервера приложения (TLS_CERT_DIR), поэтому ни сокет Docker,
 * ни доступ к systemd панели для этого не нужны — она читает файл.
 *
 * Обратная сторона: файл обновляется только тогда, когда скрипт
 * запускается. Выключенный таймер запускать его перестаёт, и поле
 * «включено» в отчёте застынет в положении «да». Поэтому тревога здесь
 * строится НЕ на этом поле, а на ВОЗРАСТЕ последней попытки: таймер
 * ходит дважды в сутки, и отчёт старше полутора суток означает, что
 * ходить он перестал, что бы в нём ни было записано.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CheckState } from './selfcheck.js';

/* ------------------------------------------------------------------ */
/* Откуда взялся сертификат                                            */
/* ------------------------------------------------------------------ */

/**
 * Отметка «откуда сертификат» — файл source рядом с ним.
 *
 * Живёт здесь, а не в маршрутах раздела «Сертификат», потому что
 * читателей у неё стало двое: сам раздел и «Наблюдение». Для оценки
 * автопродления она обязательна — свой сертификат продлевать не нужно и
 * не положено, и тревожить из-за отсутствия таймера там, где его нет
 * намеренно, значит приучить не смотреть на тревоги.
 */
export type CertificateSource = 'selfsigned' | 'letsencrypt' | 'custom' | 'unknown';

export const SOURCE_LABELS: Readonly<Record<CertificateSource, string>> = {
  selfsigned: 'самоподписанный (выпущен установщиком)',
  letsencrypt: 'Let’s Encrypt',
  custom: 'свой сертификат',
  unknown: 'неизвестно',
};

export async function readCertificateSource(dir: string): Promise<CertificateSource> {
  try {
    const value = (await readFile(join(dir, 'source'), 'utf8')).trim();
    if (value === 'selfsigned' || value === 'letsencrypt' || value === 'custom') return value;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */

/** Имя файла отчёта. Совпадает с RENEW_REPORT_NAME в install/lib/common.sh. */
export const RENEWAL_REPORT_FILE = 'renewal.json';

/**
 * Чем кончилась попытка. Значения задаёт install/renew-certs.sh; список
 * закрытый, но незнакомое значение не отбрасывается — см. ниже.
 */
export type RenewalOutcome =
  'renewed' | 'not-due' | 'deployed' | 'issued' | 'failed' | 'skipped-custom';

const OUTCOME_LABELS: Readonly<Record<RenewalOutcome, string>> = {
  renewed: 'продлён',
  'not-due': 'срок ещё не подошёл',
  deployed: 'разложен по стеку',
  issued: 'выпущен',
  failed: 'отказ',
  'skipped-custom': 'пропущено: стоит свой сертификат',
};

export function outcomeLabel(outcome: string): string {
  return outcome in OUTCOME_LABELS ? OUTCOME_LABELS[outcome as RenewalOutcome] : outcome;
}

/**
 * Разбор нарочно снисходительный: строки, а не перечисления.
 *
 * Файл пишет скрипт на хосте, а обновляются хост и контейнер порознь.
 * Строгая схема означала бы, что новая версия скрипта с новым значением
 * итога делает отчёт нечитаемым для старого сервера приложения — то есть
 * гасит тревогу ровно в тот момент, когда продукт обновляют. Незнакомое
 * значение показывается как есть; на оценку влияют только те, что здесь
 * названы поимённо.
 */
const attemptSchema = z.object({
  at: z.string(),
  trigger: z.string().default(''),
  mode: z.string().default(''),
  outcome: z.string().default(''),
  validTo: z.string().default(''),
  seconds: z.number().default(0),
  message: z.string().default(''),
});

const timerSchema = z.object({
  kind: z.string().default('none'),
  unit: z.string().default(''),
  enabled: z.boolean().default(false),
  nextRunAt: z.string().default(''),
  detail: z.string().default(''),
});

const reportSchema = z.object({
  version: z.number().default(1),
  updatedAt: z.string().default(''),
  certSource: z.string().default(''),
  timer: timerSchema,
  attempts: z.array(attemptSchema).default([]),
});

export type RenewalAttempt = z.infer<typeof attemptSchema>;
export type RenewalTimer = z.infer<typeof timerSchema>;
export type RenewalReport = z.infer<typeof reportSchema>;

/** Что удалось узнать об отчёте. Пустой problem — отчёт прочитан. */
export interface RenewalState {
  report: RenewalReport | null;
  /** Почему отчёта нет. Показывается человеку словами, а не кодом ошибки. */
  problem: string;
}

/** Разбор содержимого файла. Вынесен от файловой системы — ради проверок. */
export function parseRenewalReport(text: string): RenewalState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      report: null,
      problem: `Отчёт о продлении не разобрался как JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      report: null,
      problem: 'Отчёт о продлении есть, но написан не тем, чего мы ждём — состав полей не совпал',
    };
  }
  return { report: parsed.data, problem: '' };
}

export async function readRenewalReport(dir: string): Promise<RenewalState> {
  let text: string;
  try {
    text = await readFile(join(dir, RENEWAL_REPORT_FILE), 'utf8');
  } catch {
    return {
      report: null,
      problem:
        'Отчёта о продлении на сервере нет. Так выглядит установка, где автопродление ни разу ' +
        'не запускалось, — либо сервер, поставленный до появления отчёта',
    };
  }
  return parseRenewalReport(text);
}

/* ------------------------------------------------------------------ */
/* Оценка                                                              */
/* ------------------------------------------------------------------ */

/**
 * Сколько часов молчания считаем поводом.
 *
 * Таймер ходит дважды в сутки (03:17 и 15:17) со случайной задержкой до
 * получаса, то есть обычный промежуток между попытками — не больше
 * тринадцати часов. Тридцать часов — это две пропущенные подряд, что
 * само по себе уже не совпадение; двое суток — четыре пропущенные, тут
 * гадать не о чем.
 *
 * Пороги нарочно не равны 12 и 24: перезагрузка сервера, сдвинутое время
 * и Persistent=true дают законный разброс, а тревога, которая срабатывает
 * от нормальной работы, гасит сама себя.
 */
export const RENEW_STALE_WARN_HOURS = 30;
export const RENEW_STALE_FAIL_HOURS = 48;

/** Команды, которые человек выполняет на сервере. Одни и те же везде. */
export const RENEW_COMMAND = 'sudo bash install/renew-certs.sh';
export const RENEW_FORCE_COMMAND = 'sudo bash install/renew-certs.sh --force';
export const RENEW_TIMER_COMMAND = 'sudo bash install/renew-certs.sh --install-timer';

export interface RenewalVerdict {
  state: CheckState;
  detail: string;
  hint?: string;
}

const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  timer: 'по таймеру',
  manual: 'вручную',
  install: 'при установке',
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

/** Дата по-русски, ДД.ММ.ГГГГ ЧЧ:ММ. Тот же вид, что в остальных строках раздела. */
function moment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '?';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function hoursSince(iso: string, now: number): number | null {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return (now - at) / 3_600_000;
}

function ago(hours: number): string {
  if (hours < 1) return 'меньше часа назад';
  if (hours < 48) return `${String(Math.floor(hours))} ч назад`;
  return `${String(Math.floor(hours / 24))} сут назад`;
}

/**
 * Оценка автопродления одной строкой.
 *
 * Порядок ветвей — от «продлевать нечего» к «продлевать некому» и дальше
 * к «продлевали, но не вышло». Он не случаен: первым отсеивается случай,
 * когда автопродление выключено НАМЕРЕННО (свой сертификат), потому что
 * ложная тревога здесь дороже пропущенной — на сервере со своим
 * сертификатом она повторялась бы вечно.
 */
/**
 * За сколько дней до конца СВОЕГО сертификата начинать беспокоить.
 *
 * Больше обычного порога: продлевать его будет человек руками, и ему
 * нужно время — заказать, дождаться, поставить.
 */
const CUSTOM_WARN_DAYS = 21;

export function gradeRenewal(
  state: RenewalState,
  source: CertificateSource,
  now: number = Date.now(),
  /**
   * Сколько дней осталось у ФАКТИЧЕСКОГО сертификата (null — неизвестно).
   *
   * Нужен только своему сертификату: у него автопродления нет, и
   * единственное, что о нём можно честно сказать, — успевает ли человек
   * поставить новый.
   */
  daysLeft: number | null = null,
): RenewalVerdict {
  const { report } = state;

  // 1. Свой сертификат: автопродление не работает и работать не должно.
  //
  // Но «не должно продлеваться» — не то же самое, что «всё в порядке».
  // Прежнее безусловное `ok` держалось зелёным и на сертификате,
  // кончившемся вчера: строка «Следить за сроком придётся самому»
  // уходила в раздел «Наблюдение» как исправная. Срок фактического
  // сертификата передаётся сюда вызывающим (daysLeft) — по нему и
  // решаем.
  if (source === 'custom') {
    if (daysLeft !== null && daysLeft < 0) {
      return {
        state: 'fail',
        detail:
          'Свой сертификат истёк, а автопродление для него не работает — оно и не должно: ' +
          'продление затёрло бы ваш сертификат',
        hint: 'Поставьте свежий в разделе «Сертификат» или вернитесь к Let’s Encrypt.',
      };
    }
    if (daysLeft !== null && daysLeft <= CUSTOM_WARN_DAYS) {
      return {
        state: 'warn',
        detail: `Свой сертификат кончается через ${String(daysLeft)} дн., а продлевать его автоматически некому`,
        hint: 'Приготовьте новый заранее: почта и панель перестанут отвечать по TLS в тот же день.',
      };
    }
    return {
      state: 'ok',
      detail:
        'Автопродление Let’s Encrypt намеренно не работает: на сервере стоит свой сертификат, ' +
        'и продление затёрло бы его. Следить за сроком придётся самому',
      hint:
        'Когда свой сертификат кончится, поставьте новый в разделе «Сертификат» — ' +
        'или вернитесь к Let’s Encrypt: MT_REPLACE_CUSTOM_CERT=1 ' +
        RENEW_FORCE_COMMAND,
    };
  }

  // 2. Самоподписанный: продлевать нечего, Let's Encrypt здесь не при чём.
  if (source === 'selfsigned') {
    return {
      state: 'ok',
      detail:
        'Автопродление не применяется: на сервере самоподписанный сертификат, а не Let’s Encrypt',
      hint: `Выпустить настоящий (имена домена должны указывать на сервер): ${RENEW_FORCE_COMMAND}`,
    };
  }

  // 3. Отчёта нет вовсе.
  if (report === null) {
    return {
      state: 'warn',
      detail: state.problem,
      hint: `Включить автопродление и записать отчёт: ${RENEW_TIMER_COMMAND}`,
    };
  }

  const last = report.attempts[0] ?? null;
  const timer = report.timer;

  // 4. Автоматики нет ни в каком виде. Это отказ, а не замечание: без неё
  //    сертификат истечёт в известный день, и вопрос только когда.
  if (timer.kind === 'none') {
    return {
      state: 'fail',
      // Пояснение таймера сюда НЕ приклеивается: при kind=none оно
      // повторяет ровно эту же мысль теми же словами, и строка на экране
      // получалась вдвое длиннее без единого нового сведения.
      detail:
        'Автопродление не включено: ни таймера systemd, ни записи в cron. ' +
        'Сертификат Let’s Encrypt живёт 90 суток и сам не продлится',
      hint: `Включить: ${RENEW_TIMER_COMMAND}`,
    };
  }

  // 5. Таймер заведён, но выключен. Отдельный случай: файл юнита на месте,
  //    и глазами это выглядит как «всё настроено».
  if (!timer.enabled) {
    return {
      state: 'fail',
      detail:
        (timer.detail === '' ? 'Автопродление настроено, но выключено' : timer.detail) +
        '. Продление не запустится',
      hint: `Включить заново: ${RENEW_TIMER_COMMAND}`,
    };
  }

  const next = timer.nextRunAt === '' ? '' : `. Следующая попытка ${moment(timer.nextRunAt)}`;

  // 6. Автоматика есть, а попыток ещё не было.
  if (last === null) {
    return {
      state: 'warn',
      detail: `Автопродление включено (${timer.detail || timer.kind}), но ни одной попытки ещё не записано${next}`,
      hint: `Проверить прямо сейчас: ${RENEW_COMMAND}`,
    };
  }

  const when = moment(last.at);
  const age = hoursSince(last.at, now);
  const how = triggerLabel(last.trigger);

  // 7. Последняя попытка не удалась. Это главное, ради чего всё затевалось.
  if (last.outcome === 'failed') {
    return {
      state: 'fail',
      detail: `Последняя попытка (${when}, ${how}) не удалась: ${last.message}`,
      hint: `Повторить и увидеть причину целиком: ${RENEW_FORCE_COMMAND}`,
    };
  }

  // 8. Попытки давно не было. Ловит именно то, чего не ловит поле
  //    «включено»: таймер, который перестал ходить.
  if (age !== null && age >= RENEW_STALE_WARN_HOURS) {
    const stale: CheckState = age >= RENEW_STALE_FAIL_HOURS ? 'fail' : 'warn';
    return {
      state: stale,
      detail:
        `Отчёт числит автопродление включённым, но последняя попытка была ${ago(age)} ` +
        `(${when}). Таймер ходит дважды в сутки — значит он остановился`,
      hint: `Проверить состояние: systemctl status ${timer.unit || 'mailtrue-certs.timer'}; продлить вручную: ${RENEW_COMMAND}`,
    };
  }

  // 9. Всё как надо.
  return {
    state: 'ok',
    detail:
      `Включено (${timer.detail || timer.kind}). Последняя попытка ${when} (${how}): ` +
      `${outcomeLabel(last.outcome)}${next}`,
  };
}

/** Готовая проверка для раздела «Наблюдение». */
export function renewalHealthCheck(
  state: RenewalState,
  source: CertificateSource,
  now: number = Date.now(),
  /**
   * Срок ФАКТИЧЕСКОГО сертификата. Без него оценка своего сертификата
   * проваливалась в безусловное «в порядке»: у него автопродления нет,
   * и единственное, что о нём можно честно сказать, — успевает ли
   * человек поставить новый. Раздел «Сертификат» это значение передавал,
   * а «Наблюдение» — нет, и один и тот же истёкший сертификат был там
   * красным, а тут зелёным.
   */
  daysLeft: number | null = null,
): { id: string; group: string; title: string } & RenewalVerdict {
  return {
    id: 'cert:renewal',
    group: 'Сертификаты',
    title: 'Автопродление сертификата',
    ...gradeRenewal(state, source, now, daysLeft),
  };
}
