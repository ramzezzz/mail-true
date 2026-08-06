/**
 * Подлинность отправителя показывается человеческим языком.
 *
 * Было: «SPF: none · DKIM: pass · DMARC: pass». Заказчик сказал прямо —
 * «вместо none, pass, fail рисуй понятные значки, это будет понятнее для
 * пользователя, кто в этом не разбирается».
 *
 * Проверяется не вид, а смысл: что человек получает ответ на свой вопрос
 * («можно ли верить отправителю»), что значок не единственный носитель
 * этого ответа (слово рядом — для экранного диктора и для печати) и что
 * техническое значение никуда не делось: тот, кто разбирается, должен
 * по-прежнему его видеть.
 *
 * На старом коде падают все проверки: блока не существовало.
 *
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResult } from '@mail-true/shared';
import { SenderAuth } from '../src/mail/SenderAuth';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(a: { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult }): Promise<void> {
  await act(async () => {
    root.render(<SenderAuth authentication={a} />);
  });
}

describe('подлинность отправителя', () => {
  it('главный ответ даётся словами, а не аббревиатурами', async () => {
    await render({ spf: 'none', dkim: 'pass', dmarc: 'pass' });
    expect(container.textContent).toContain('Отправитель подтверждён');
  });

  it('проваленная проверка названа прямо: это подделка, а не «нет данных»', async () => {
    await render({ spf: 'fail', dkim: 'fail', dmarc: 'fail' });
    expect(container.textContent).toMatch(/не пройдена|поддельн/i);
  });

  it('отсутствие проверок не выдаётся за отказ', async () => {
    // Домен, не настроивший ни SPF, ни DKIM, — не мошенник; сказать надо
    // именно «подтвердить нечем», а не «проверка провалена».
    await render({ spf: 'none', dkim: 'none', dmarc: 'none' });
    const text = container.textContent ?? '';
    expect(text).toMatch(/нечем|не настроил/i);
    expect(text).not.toMatch(/поддельн/i);
  });

  it('каждая проверка объяснена по-русски, а не кодом', async () => {
    await render({ spf: 'pass', dkim: 'none', dmarc: 'pass' });
    const text = container.textContent ?? '';
    expect(text).toContain('Сервер отправителя');
    expect(text).toContain('Подпись письма');
    expect(text).toContain('Правило домена');
    expect(text).toContain('письмо не подписано');
  });

  it('техническое значение остаётся — для того, кто разбирается', async () => {
    await render({ spf: 'softfail', dkim: 'pass', dmarc: 'pass' });
    const text = container.textContent ?? '';
    expect(text).toContain('SPF: softfail');
    expect(text).toContain('DKIM: pass');
    expect(text).toContain('DMARC: pass');
  });

  it('состояние не держится на одном цвете: рядом со значком есть слово', async () => {
    // Цвет не различает часть людей, и он пропадает при печати. Значок
    // сам по себе тоже не читается диктором — он помечен aria-hidden.
    await render({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(container.textContent).toMatch(/проверка пройдена/);
    const signs = container.querySelectorAll('[aria-hidden="true"]');
    expect(signs.length).toBeGreaterThan(0);
  });

  it('неизвестные и ошибочные исходы не выпадают в пустоту', async () => {
    await render({ spf: 'temperror', dkim: 'permerror', dmarc: 'neutral' });
    const text = container.textContent ?? '';
    expect(text).toMatch(/не удалось|под вопросом|не высказ/i);
    expect(text).not.toMatch(/undefined/);
  });
});
