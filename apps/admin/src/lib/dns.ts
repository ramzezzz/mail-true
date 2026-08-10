/**
 * Как показывать проверку DNS.
 *
 * Раньше на странице доменов было две кнопки: «Проверить DNS» отвечала
 * итоговой плашкой, «Что прописать» показывала готовые значения. Человеку
 * же нужно одно: понять, что не так и что с этим делать. Здесь собрано
 * всё, что для этого нужно решить до отрисовки, — чтобы это можно было
 * проверить тестом, а не глазами.
 */
import type {
  DnsCheck,
  DnsCheckOne,
  DnsGroup,
  DnsReport,
  DnsResolverInfo,
  DnsVerdict,
} from '../api/types';

export type BadgeTone = 'ok' | 'warn' | 'fail' | 'muted';

/**
 * Вывод по записи словами заказчика: «настроено верно / не настроено /
 * настроено с ошибкой». Именно этих трёх слов не хватало: раньше и
 * отсутствие записи, и неверное значение показывались одинаково.
 */
export const VERDICT_LABEL: Record<DnsVerdict, string> = {
  ok: 'настроено верно',
  missing: 'не настроено',
  mismatch: 'настроено с ошибкой',
  warn: 'настроено, есть замечание',
  unreachable: 'не удалось проверить',
};

export function verdictTone(verdict: DnsVerdict): BadgeTone {
  switch (verdict) {
    case 'ok':
      return 'ok';
    case 'mismatch':
      return 'fail';
    case 'missing':
    case 'warn':
      return 'warn';
    case 'unreachable':
      return 'muted';
  }
}

export const GROUP_TITLE: Record<DnsGroup, string> = {
  core: 'Обязательный минимум',
  web: 'Веб-интерфейс',
  client: 'Автонастройка почтовых клиентов',
};

export const GROUP_NOTE: Record<DnsGroup, string> = {
  core: 'Без этих записей почта не ходит или уходит в спам.',
  web: 'Без них почта работает, но открыть её в браузере по своему имени не выйдет.',
  client: 'Без них Thunderbird и Outlook не настроятся сами — адреса придётся вводить руками.',
};

export const GROUP_ORDER: DnsGroup[] = ['core', 'web', 'client'];

export interface DnsGroupView {
  group: DnsGroup;
  title: string;
  note: string;
  checks: DnsCheck[];
  /** Сколько записей в разделе требует внимания. */
  problems: number;
}

/** Раскладывает проверки по разделам docs/install.md, пустые разделы убирает. */
export function groupChecks(checks: readonly DnsCheck[]): DnsGroupView[] {
  return GROUP_ORDER.map((group) => {
    const own = checks.filter((c) => c.group === group);
    return {
      group,
      title: GROUP_TITLE[group],
      note: GROUP_NOTE[group],
      checks: own,
      problems: own.filter(needsAttention).length,
    };
  }).filter((view) => view.checks.length > 0);
}

/**
 * Нужно ли раскрыть карточку сразу. Настроенное верно интересно редко,
 * поэтому по умолчанию раскрыто ровно то, с чем надо что-то делать:
 * иначе полтора десятка карточек превращают диалог в простыню.
 */
export function needsAttention(check: DnsCheck): boolean {
  return check.verdict !== 'ok';
}

export interface DnsSummary {
  total: number;
  ok: number;
  /** Не настроено или настроено с ошибкой. */
  broken: number;
  warnings: number;
  unknown: number;
  /** Одна строка над списком: что вообще происходит. */
  headline: string;
  tone: BadgeTone;
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};

/** Короткий итог по отчёту — то, что читают первым. */
export function summarize(report: DnsReport): DnsSummary {
  const checks = report.checks;
  const ok = checks.filter((c) => c.verdict === 'ok').length;
  const broken = checks.filter((c) => c.verdict === 'missing' || c.verdict === 'mismatch').length;
  const warnings = checks.filter((c) => c.verdict === 'warn').length;
  const unknown = checks.filter((c) => c.verdict === 'unreachable').length;

  let headline: string;
  let tone: BadgeTone;
  if (!report.resolver.reachable) {
    headline = 'Проверить не удалось: ни один резольвер не ответил';
    tone = 'muted';
  } else if (broken > 0) {
    headline = `${String(broken)} ${plural(broken, 'запись требует', 'записи требуют', 'записей требуют')} правки`;
    tone = 'fail';
  } else if (warnings > 0) {
    headline = `Всё главное на месте, ${String(warnings)} ${plural(warnings, 'замечание', 'замечания', 'замечаний')}`;
    tone = 'warn';
  } else if (unknown > 0) {
    headline = `Проверено не всё: ${String(unknown)} ${plural(unknown, 'запись', 'записи', 'записей')} спросить не удалось`;
    tone = 'muted';
  } else {
    headline = 'Все записи настроены верно';
    tone = 'ok';
  }

  return { total: checks.length, ok, broken, warnings, unknown, headline, tone };
}

/**
 * Кого спрашивали. Показываем явно: проверка ходит к публичным
 * резольверам, а не к своему unbound, — иначе она показывала бы то,
 * что мы сами себе прописали.
 */
export function resolverNote(resolver: DnsResolverInfo): { tone: BadgeTone; text: string } {
  if (!resolver.reachable) {
    return {
      tone: 'muted',
      text:
        `Ни один из резольверов (${resolver.servers.join(', ')}) не ответил. ` +
        'Это не значит, что записей нет: проверьте, выпускает ли сервер запросы на 53/udp наружу, ' +
        'и повторите проверку.',
    };
  }
  return {
    tone: 'ok',
    text:
      `Спрашивали внешний мир: ${resolver.answeredBy.join(', ')}. ` +
      'Свой резольвер стека намеренно не используется — он показал бы то, что мы прописали себе сами.',
  };
}

/**
 * Предупреждение про время жизни записи.
 *
 * Без него «перепроверить» сразу после правки обманывает: резольвер
 * держит прежний ответ до конца TTL, человек видит «не настроено» и
 * начинает править верную настройку. Поэтому у каждой непройденной
 * записи говорится, когда получен ответ и что свежая правка расходится
 * не мгновенно.
 */
export const PROPAGATION_NOTE =
  'У записей DNS есть время жизни: правка у регистратора расходится по миру ' +
  'от нескольких минут до суток. Если только что исправили — подождите и перепроверьте.';

/** Нужно ли напомнить про время жизни у этой записи. */
export function needsPropagationNote(check: DnsCheck): boolean {
  return check.verdict === 'missing' || check.verdict === 'mismatch';
}

/** Время суток из отметки ответа: «22:05:41». Пусто — отметки нет. */
export function answerTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Подпись под строкой ответа: когда и у кого спросили. Именно у этой
 * записи, а не «отчёт целиком»: после точечной перепроверки общее время
 * отчёта врёт про остальные строки.
 */
export function answerStamp(check: DnsCheck): string {
  const time = answerTime(check.checkedAt);
  if (check.verdict === 'unreachable') {
    return time === '' ? 'ответа нет' : `спросить не удалось в ${time}`;
  }
  if (time === '') return '';
  return check.askedVia
    ? `ответ получен в ${time} от ${check.askedVia}`
    : `ответ получен в ${time}`;
}

/** Что показать в строке «Что опубликовано». */
export function formatActual(check: DnsCheck): string {
  if (check.verdict === 'unreachable') return 'спросить не удалось';
  if (check.actual.length === 0) return 'записи нет';
  return check.actual.join('\n');
}

/** Подпись кнопки копирования: у PTR копировать к регистратору нечего. */
export function copyHint(check: DnsCheck): string | null {
  if (!check.copyable) {
    return 'Обратную запись заводит владелец адреса (хостер), а не регистратор домена.';
  }
  return null;
}

/**
 * Значение TXT в виде, годном для файла зоны.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ КАВЫЧКИ ОБЯЗАТЕЛЬНЫ
 * ------------------------------------------------------------------
 * В файле зоны точка с запятой начинает КОММЕНТАРИЙ, а пробел разделяет
 * значения. Без кавычек из наших записей оставалось вот что:
 *
 *   DMARC  «v=DMARC1; p=quarantine; rua=…»  →  «v=DMARC1»
 *          то есть запись без обязательного p= — недействительная;
 *   DKIM   «v=DKIM1; k=rsa; p=MIIBI…»       →  «v=DKIM1»
 *          ключ отрезан целиком;
 *   SPF    «v=spf1 mx ~all»                  →  три отдельных куска,
 *          которые получатель склеивает в «v=spf1mx~all».
 *
 * Ломались ровно те три записи, ради которых раздел и существует, — а MX,
 * A и CNAME рядом вставали правильно. «Половина заработала» выглядит как
 * беда регистратора, и искать её будут не здесь.
 *
 * Длина одного куска TXT ограничена 255 БАЙТАМИ (RFC 1035, §3.3.14), а
 * публичный ключ DKIM длиннее. Несколько кусков подряд получатель
 * склеивает сам — это и есть штатный способ записать длинный TXT.
 */
export function zoneTxtValue(value: string): string {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  /*
   * Режем по ИСХОДНЫМ знакам, а не по уже экранированной строке.
   *
   * Экранирование превращает один знак в два (обратная косая плюс сам
   * знак), и нарезка по экранированному тексту могла разложить эту пару
   * по разным кускам: первый заканчивался обратной косой, второй
   * начинался кавычкой — и запись становилась синтаксически битой.
   * Здесь каждый исходный знак переводится целиком и целиком же попадает
   * в один кусок.
   */
  for (const char of value) {
    const piece = char === '\\' || char === '"' ? `\\${char}` : char;
    const size = encoder.encode(piece).length;
    if (bytes + size > 255) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += piece;
    bytes += size;
  }
  chunks.push(current);
  return chunks.map((chunk) => `"${chunk}"`).join(' ');
}

/**
 * Все записи одним куском — для тех, кто заполняет панель регистратора
 * подряд. Недоступные для копирования (PTR) и неизвестные значения
 * не попадают: строка должна быть годной для вставки как есть.
 */
export function buildZoneText(report: DnsReport): string {
  const lines = [`; DNS-записи домена ${report.domain} (Mail.True)`];
  for (const check of report.checks) {
    if (!check.copyable) continue;
    if (check.expected.startsWith('<')) continue;
    const value = check.recordType === 'TXT' ? zoneTxtValue(check.expected) : check.expected;
    lines.push(`${check.recordName}.\t3600\tIN\t${check.recordType}\t${value}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Куда класть пришедший ответ                                          */
/* ------------------------------------------------------------------ */

/**
 * Открытый диалог: домен и последний известный по нему отчёт.
 *
 * Домен здесь типом-параметром, а не Domain: проверке нужен только номер,
 * а тащить в неё всю карточку домена незачем.
 */
export interface OpenedDns<D extends { id: number }> {
  domain: D;
  report: DnsReport | null;
}

/*
 * ОТВЕТ ПО ОДНОМУ ДОМЕНУ ПОКАЗЫВАЛСЯ В ДИАЛОГЕ ДРУГОГО.
 *
 * Проверка DNS ходит к внешним резольверам и занимает секунды. За это
 * время диалог успевают закрыть и открыть на соседнем домене — а закрытие
 * запрос не отменяет (и отменить его нечем: ответ всё равно придёт).
 * Обработчики же вклеивали пришедшее в ТЕКУЩИЙ диалог, не глядя, для
 * какого домена его спрашивали.
 *
 * Итог хуже, чем «показали лишнее»: у записей spf/mx/dmarc одинаковые
 * опознаватели у всех доменов, поэтому точечная перепроверка подменяла
 * строку чужого отчёта своей. Администратор видел «SPF настроен верно» в
 * домене, где SPF нет вовсе, и уходил чинить другое.
 *
 * Правило одно и простое: пришедшее принимается, только если диалог до
 * сих пор открыт и открыт на ТОМ ЖЕ домене.
 */

/** Полный отчёт — только в диалог того домена, для которого его спрашивали. */
export function acceptReport<D extends { id: number }>(
  prev: OpenedDns<D> | null,
  domainId: number,
  report: DnsReport,
): OpenedDns<D> | null {
  if (prev === null || prev.domain.id !== domainId) return prev;
  return { domain: prev.domain, report };
}

/** Одна перепроверенная запись — туда же и по тому же правилу. */
export function acceptCheck<D extends { id: number }>(
  prev: OpenedDns<D> | null,
  domainId: number,
  data: DnsCheckOne,
): OpenedDns<D> | null {
  if (prev === null || prev.report === null || prev.domain.id !== domainId) return prev;
  return {
    domain: prev.domain,
    report: {
      ...prev.report,
      overall: data.overall,
      resolver: data.resolver,
      checks: prev.report.checks.map((c) => (c.id === data.check.id ? data.check : c)),
    },
  };
}
