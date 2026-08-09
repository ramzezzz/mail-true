/**
 * Набранное человеком не должно пропадать само.
 *
 * Три места, где оно пропадало, и все три — молча: ни сообщения, ни
 * отката, поле просто показывает другое значение.
 *
 * 1. НАСТРОЙКИ ЧУЖОГО ЯЩИКА. Черновик формы перезаписывался при каждом
 *    обновлении запроса, а правила фильтрации живут в том же запросе:
 *    любое действие с ними (сохранить, удалить, переставить стрелкой)
 *    вызывает invalidate. Человек пишет подпись, замечает, что правило
 *    стоит не в том порядке, жмёт стрелку — подпись пропала.
 *
 * 2. НАСТРОЙКИ СЕРВЕРА. После сохранения черновик стирался ЦЕЛИКОМ, а
 *    отправляется не всё: значения, не прошедшие проверку, пропускаются
 *    намеренно, и панель обещает «такие не отправятся: исправьте или
 *    отмените». Обещание было пустым — исправлять оказывалось нечего.
 *
 * 3. ВЫБРАННЫЙ ДОМЕН. Полный адрес при пустом имени пуст, и домен из
 *    него не восстановить: он молча возвращался к первому в списке.
 *    Стёр имя, чтобы набрать другое, — ящик уехал в чужой домен.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AddressInput } from '../src/components/AddressInput';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Управляемое поле адреса — как в настоящих формах панели. */
function renderAddress(domains: string[], initial = ''): { value: () => string } {
  let value = initial;
  const draw = (): void => {
    root.render(
      <AddressInput
        value={value}
        onChange={(next) => {
          value = next;
          draw();
        }}
        domains={domains}
      />,
    );
  };
  act(() => draw());
  return { value: () => value };
}

function field(label: string): HTMLInputElement {
  const found = container.querySelector(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`нет поля «${label}»`);
  return found as HTMLInputElement;
}

function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ввод адреса', () => {
  it('выбранный домен переживает стирание имени', () => {
    const form = renderAddress(['first.local', 'second.local', 'third.local']);

    type(field('Имя ящика'), 'ivan');
    type(field('Домен'), 'second.local');
    expect(form.value()).toBe('ivan@second.local');

    // Человек стирает имя, чтобы набрать другое.
    type(field('Имя ящика'), '');
    expect(form.value()).toBe('');
    expect(field('Домен').value, 'домен слетел на первый — ящик уедет не туда').toBe(
      'second.local',
    );

    type(field('Имя ящика'), 'petr');
    expect(form.value()).toBe('petr@second.local');
  });

  it('вставка полного адреса запоминает домен из него', () => {
    const form = renderAddress(['first.local', 'second.local']);
    type(field('Имя ящика'), 'anna@second.local');
    expect(form.value()).toBe('anna@second.local');

    type(field('Имя ящика'), '');
    type(field('Имя ящика'), 'anna2');
    expect(form.value()).toBe('anna2@second.local');
  });

  it('без выбора домена берётся первый — как и раньше', () => {
    const form = renderAddress(['first.local', 'second.local']);
    type(field('Имя ящика'), 'ivan');
    expect(form.value()).toBe('ivan@first.local');
  });
});

/* ------------------------------------------------------------------ */
/* Черновики страниц                                                    */
/* ------------------------------------------------------------------ */

/*
 * Проверяется САМ КОД страниц, а не его копия в тесте.
 *
 * Первая версия этих проверок повторяла условие рядом и зеленела бы даже
 * после того, как на странице его снесли, — то есть сторожила бы себя, а
 * не продукт. Обе поломки заключались в одной строке, и именно её
 * отсутствие здесь и ловится.
 */
// В среде jsdom import.meta.url не файловый — читаем от корня пакета.
const source = (name: string): string =>
  readFileSync(path.join(process.cwd(), 'src', 'pages', name), 'utf8');
const settingsSource = source('UserSettingsPage.tsx');
const serverSource = source('ServerSettingsPage.tsx');

/** Код без комментариев: объяснения рядом с правкой не должны её изображать. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('черновик переживает обновление данных', () => {
  it('настройки ящика не затираются приходом свежих данных', () => {
    const source = code(settingsSource);
    expect(
      /if \(bundle\.data\) setDraft\(bundle\.data\.general\);/.test(source),
      'безусловная перезапись стирает набранное при любом действии с правилами',
    ).toBe(false);
    // Сравнение с последним серверным значением — то, чем отличают
    // «человек ничего не трогал» от «трогал».
    expect(source).toMatch(/serverGeneral/);
    expect(source).toMatch(/untouched/);
  });

  it('настройки сервера сохраняют то, что не отправилось', () => {
    const source = code(serverSource);
    // Стирание всего черновика — ровно та строка, что теряла набранное.
    // В коде без комментариев её быть не должно нигде, кроме кнопки
    // «Отменить правки», где это и есть смысл действия.
    const wipes = source.match(/setDraft\(\{\}\)/g) ?? [];
    expect(wipes.length, 'после сохранения черновик стирался целиком').toBeLessThanOrEqual(1);
    expect(source).toMatch(/Отменить правки/);
    // Отсев по отправленному: остаётся ровно то, что не уехало.
    expect(source).toMatch(/onSuccess: \(result, sent\)/);
    expect(source).toMatch(/if \(!\(key in sent\)\) rest\[key\] = value;/);
  });
});
