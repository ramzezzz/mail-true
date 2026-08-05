/**
 * Как показывать проверку DNS.
 *
 * Раньше на странице доменов было две кнопки: «Проверить DNS» отвечала
 * итоговой плашкой, «Что прописать» показывала готовые значения. Человеку
 * же нужно одно: понять, что не так и что с этим делать. Здесь собрано
 * всё, что для этого нужно решить до отрисовки, — чтобы это можно было
 * проверить тестом, а не глазами.
 */
import type { DnsCheck, DnsGroup, DnsReport, DnsResolverInfo, DnsVerdict } from '../api/types';

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
 * Все записи одним куском — для тех, кто заполняет панель регистратора
 * подряд. Недоступные для копирования (PTR) и неизвестные значения
 * не попадают: строка должна быть годной для вставки как есть.
 */
export function buildZoneText(report: DnsReport): string {
  const lines = [`; DNS-записи домена ${report.domain} (Mail.True)`];
  for (const check of report.checks) {
    if (!check.copyable) continue;
    if (check.expected.startsWith('<')) continue;
    lines.push(`${check.recordName}.\t3600\tIN\t${check.recordType}\t${check.expected}`);
  }
  return lines.join('\n');
}
