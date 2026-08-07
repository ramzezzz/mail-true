/**
 * Раздел «Настройки сервера».
 *
 * Проверки закрывают ровно то, чем этот раздел может соврать, а врать
 * ему есть чем: настроек 133, и три их состояния похожи друг на друга.
 *
 *   1. Пункт меню появляется ВМЕСТЕ С ПРАВОМ: роль без serversettings.read
 *      раздела не видит вовсе.
 *   2. Три состояния названы РАЗНЫМИ словами, а «ждёт перезапуска» —
 *      признак отдельный от «нужен перезапуск»: первый требует действия,
 *      второй нет, и отбор в списке у них разный.
 *   3. Запертая настройка показывает ПРИЧИНУ текстом, а не серым цветом,
 *      и поля ввода у неё нет.
 *   4. Секрет не выходит наружу ни значением, ни полем ввода — только
 *      «задан» или «не задан».
 *   5. Поиск идёт по описанию, а не только по имени ключа: имена
 *      английские и заглавными, наизусть их никто не знает.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAV_ITEMS, visibleNav } from '../src/lib/access';
import { breadcrumbsFor } from '../src/lib/breadcrumbs';
import {
  FILTER_LABELS,
  filterSections,
  humanValue,
  isDirty,
  matchesSearch,
  sourceLabel,
  stateLabel,
  toWire,
  unitLabel,
  validate,
  valueText,
} from '../src/lib/serverSettings';
import { SettingRow } from '../src/pages/ServerSettingsPage';
import type { Permission, ServerSetting, ServerSettingsSection } from '../src/api/types';

const READONLY: Permission[] = ['overview.read', 'users.read', 'audit.read', 'branding.read'];
const OWNER: Permission[] = [...READONLY, 'serversettings.read', 'serversettings.write'];

/** Настройка-образец: поля перекрываются в каждом тесте по месту. */
function setting(patch: Partial<ServerSetting> = {}): ServerSetting {
  return {
    key: 'ADMIN_SESSION_TTL_SECONDS',
    section: 'panel',
    group: 'live',
    kind: 'int',
    unit: 'seconds',
    min: 60,
    max: 2_592_000,
    options: null,
    description: 'Срок жизни сессии админки, секунды.',
    reason: null,
    editable: true,
    secret: false,
    requiresRestart: false,
    pendingRestart: false,
    // Чем настройка включается. У живой — ничем: она действует сразу.
    applies: [],
    value: 28_800,
    default: 28_800,
    configured: null,
    source: 'env',
    updatedBy: null,
    updatedAt: null,
    ...patch,
  };
}

describe('пункт меню появляется вместе с правом', () => {
  it('без serversettings.read раздела нет', () => {
    expect(visibleNav(READONLY).map((i) => i.title)).not.toContain('Настройки сервера');
  });

  it('с правом — есть, и не помечен «скоро»', () => {
    expect(visibleNav(OWNER).map((i) => i.title)).toContain('Настройки сервера');
    expect(NAV_ITEMS.find((i) => i.to === '/server-settings')?.stub).toBeFalsy();
  });

  it('право именно своё, а не overview.read', () => {
    const item = NAV_ITEMS.find((i) => i.to === '/server-settings');
    expect(item?.requires).toEqual(['serversettings.read']);
  });

  it('в крошках раздел назван по-русски', () => {
    expect(breadcrumbsFor('/server-settings').at(-1)?.title).toBe('Настройки сервера');
  });
});

describe('три состояния различимы', () => {
  it('у каждого своя подпись и свой цвет', () => {
    const live = stateLabel(setting({ group: 'live' }));
    const restart = stateLabel(setting({ group: 'restart', requiresRestart: true }));
    const locked = stateLabel(setting({ group: 'locked', editable: false, reason: 'потому что' }));

    expect(live.text).toBe('действует сразу');
    expect(restart.text).toBe('нужен перезапуск');
    expect(locked.text).toBe('не меняется из веба');
    expect(new Set([live.tone, restart.tone, locked.tone]).size).toBe(3);
  });

  it('у запертой в подсказке стоит причина, а не общие слова', () => {
    const label = stateLabel(
      setting({ group: 'locked', editable: false, reason: 'Читается самим docker compose.' }),
    );
    expect(label.title).toBe('Читается самим docker compose.');
  });
});

describe('«нужен перезапуск» и «ждёт перезапуска» — разные вещи', () => {
  const promised = setting({ key: 'A', group: 'restart', requiresRestart: true });
  const factual = setting({
    key: 'B',
    group: 'restart',
    requiresRestart: true,
    pendingRestart: true,
    source: 'db',
  });
  const sections: ServerSettingsSection[] = [
    { id: 'web', title: 'Почта', note: null, settings: [promised, factual] },
  ];

  it('отбор «ждут перезапуска» показывает только те, из-за которых он нужен', () => {
    const found = filterSections(sections, '', 'pending');
    expect(found.shown).toBe(1);
    expect(found.sections[0]?.settings[0]?.key).toBe('B');
  });

  it('отбор «нужен перезапуск» показывает обе: это свойство настройки', () => {
    expect(filterSections(sections, '', 'restart').shown).toBe(2);
  });

  it('в списке отборов оба названы по-разному', () => {
    expect(FILTER_LABELS.restart).not.toBe(FILTER_LABELS.pending);
  });
});

describe('поиск', () => {
  it('идёт по описанию, а не только по имени ключа', () => {
    const item = setting({ key: 'SENDER_LOGO_TTL_HOURS', description: 'Срок хранения логотипа.' });
    expect(matchesSearch(item, 'логотип')).toBe(true);
    expect(matchesSearch(item, 'SENDER_LOGO')).toBe(true);
    expect(matchesSearch(item, 'квота')).toBe(false);
  });

  it('раздел без единой подходящей настройки не показывается', () => {
    const sections: ServerSettingsSection[] = [
      { id: 'panel', title: 'Вход', note: null, settings: [setting()] },
      { id: 'ai', title: 'ИИ', note: null, settings: [setting({ key: 'AI_ENABLED' })] },
    ];
    const found = filterSections(sections, 'AI_', 'all');
    expect(found.sections).toHaveLength(1);
    expect(found.sections[0]?.id).toBe('ai');
  });
});

describe('значения по-человечески', () => {
  it('секунды переводятся в часы и сутки', () => {
    expect(humanValue('seconds', 28_800)).toBe('8 ч');
    expect(humanValue('seconds', 2_592_000)).toBe('30 сут');
    // Мелкое не переводим: «45 секунд» и так понятно
    expect(humanValue('seconds', 45)).toBeNull();
  });

  it('байты — привычными единицами', () => {
    expect(humanValue('bytes', 26_214_400)).toBe('25 МБ');
  });

  it('у настройки без единиц переводить нечего', () => {
    expect(humanValue(null, 5)).toBeNull();
    expect(unitLabel(null)).toBe('');
    expect(unitLabel('perMinute')).toBe('в минуту');
  });

  it('«да/нет» и пустая строка названы словами, а не true и ""', () => {
    expect(valueText(true)).toBe('да');
    expect(valueText(false)).toBe('нет');
    expect(valueText('')).toBe('пусто');
    expect(valueText(null)).toBe('—');
  });
});

describe('источник значения назван прямо', () => {
  it('база, окружение и умолчание — разными словами', () => {
    const db = sourceLabel(setting({ source: 'db' }));
    const env = sourceLabel(setting({ source: 'env' }));
    const def = sourceLabel(setting({ source: 'default' }));
    expect(new Set([db, env, def]).size).toBe(3);
    expect(env).toContain('infra/.env');
  });
});

describe('проверка набранного до отправки', () => {
  it('пределы с сервера проверяются на месте', () => {
    expect(validate(setting(), '30')).toBe('Не меньше 60.');
    expect(validate(setting(), '99999999')).toBe('Не больше 2592000.');
    expect(validate(setting(), '600')).toBeNull();
  });

  it('буквы в числовом поле не проходят', () => {
    expect(validate(setting(), '8 часов')).not.toBeNull();
    expect(validate(setting(), '')).not.toBeNull();
  });

  it('строковая настройка не может быть пустой', () => {
    expect(validate(setting({ kind: 'string', value: 'x' }), '  ')).not.toBeNull();
  });

  it('число уходит числом, а не строкой', () => {
    expect(toWire(setting(), '600')).toBe(600);
    expect(toWire(setting({ kind: 'bool', value: false }), true)).toBe(true);
  });

  it('набранное то же самое изменением не считается', () => {
    expect(isDirty(setting(), '28800')).toBe(false);
    expect(isDirty(setting(), '600')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Настоящая отрисовка строки настройки                                */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(item: ServerSetting, writable = true): void {
  act(() => {
    root.render(
      <SettingRow
        setting={item}
        draft={undefined}
        writable={writable}
        busy={false}
        onChange={() => undefined}
        onReset={() => undefined}
      />,
    );
  });
}

describe('запертая настройка', () => {
  const locked = setting({
    key: 'MAIL_DOMAIN',
    group: 'locked',
    kind: 'string',
    editable: false,
    unit: null,
    min: null,
    max: null,
    value: 'mail.local',
    default: 'mail.local',
    reason: 'Домен зашит в сертификаты и в конфигурацию Postfix.',
  });

  it('причина видна текстом на странице, а не только серым цветом', () => {
    render(locked);
    expect(container.textContent).toContain('Домен зашит в сертификаты');
    expect(container.textContent).toContain('Почему не меняется из веба');
  });

  it('поля ввода нет вовсе — недоступного тоже', () => {
    render(locked);
    expect(container.querySelectorAll('input, select')).toHaveLength(0);
    // Значение при этом показано: раздел для того и заведён
    expect(container.textContent).toContain('mail.local');
  });

  it('кнопки «вернуть к умолчанию» у неё нет', () => {
    render(setting({ ...locked, source: 'db' }));
    expect(container.textContent).not.toContain('Вернуть к умолчанию');
  });
});

describe('секрет', () => {
  const secret = setting({
    key: 'POSTGRES_PASSWORD',
    group: 'locked',
    kind: 'string',
    editable: false,
    secret: true,
    unit: null,
    min: null,
    max: null,
    value: null,
    default: null,
    configured: true,
    reason: 'Секрет. Наружу не отдаётся ни в каком виде.',
  });

  it('показывает только «задан» и не заводит поля ввода', () => {
    render(secret);
    expect(container.textContent).toContain('секрет задан');
    expect(container.querySelectorAll('input, select')).toHaveLength(0);
  });

  it('«не задан» — тоже словами', () => {
    render(setting({ ...secret, configured: false }));
    expect(container.textContent).toContain('секрет не задан');
  });

  it('умолчание секрета не показывается: его нет ни в каком виде', () => {
    render(secret);
    expect(container.textContent).not.toContain('умолчание:');
  });
});

describe('обычная настройка', () => {
  it('описание показано текстом, а не спрятано под знак вопроса', () => {
    render(setting());
    expect(container.textContent).toContain('Срок жизни сессии админки');
    expect(container.textContent).toContain('от 60 до 2592000');
    expect(container.textContent).toContain('сейчас это 8 ч');
  });

  it('изменённая говорит, кто и когда её менял, и даёт вернуть умолчание', () => {
    render(
      setting({
        source: 'db',
        value: 600,
        updatedBy: 'snimki',
        updatedAt: '2026-08-07T04:30:00.000Z',
      }),
    );
    expect(container.textContent).toContain('задано в панели');
    expect(container.textContent).toContain('snimki');
    expect(container.textContent).toContain('Вернуть к умолчанию');
  });

  it('ждущая перезапуска говорит, что сохранена, но ещё не действует', () => {
    render(
      setting({ group: 'restart', requiresRestart: true, pendingRestart: true, source: 'db' }),
    );
    expect(container.textContent).toContain('ждёт перезапуска');
    expect(container.textContent).toContain('Сохранено, но ещё не действует');
  });

  it('без права записи поле недоступно и кнопки возврата нет', () => {
    render(setting({ source: 'db', value: 600 }), false);
    const input = container.querySelector('input');
    expect(input?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Вернуть к умолчанию');
  });
});
