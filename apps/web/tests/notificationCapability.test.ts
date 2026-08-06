/**
 * Что именно не работает и что с этим делать.
 *
 * «Уведомления не приходят» — жалоба с восемью возможными причинами и
 * нулевой видимостью. Каждая причина требует РАЗНЫХ действий от человека,
 * и ни одну нельзя показать словом «ошибка». Поэтому проверяется каждая
 * по отдельности, а заодно — что в рабочем случае не показывается ничего:
 * страница, всегда о чём-то предупреждающая, читается как сломанная.
 */

import { describe, expect, it } from 'vitest';
import {
  browserFamily,
  capabilitiesOf,
  capabilityNotice,
  recoverySteps,
  type BrowserEnvironment,
} from '../src/notifications/capability';
import { claimWinner, type Claim } from '../src/notifications/local';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

function env(patch: Partial<BrowserEnvironment> = {}): BrowserEnvironment {
  return {
    hasNotification: true,
    permission: 'granted',
    hasServiceWorker: true,
    hasPushManager: true,
    hasActions: true,
    isSecureContext: true,
    userAgent: CHROME,
    ...patch,
  };
}

function notice(patch: Partial<BrowserEnvironment> = {}, options: Partial<Parameters<typeof capabilityNotice>[0]> = {}) {
  return capabilityNotice({
    capabilities: capabilitiesOf(env(patch)),
    userAgent: env(patch).userAgent,
    wantsPush: false,
    pushAvailable: true,
    pushUnavailableReason: null,
    ...options,
  });
}

describe('состояние браузера', () => {
  it('в рабочем случае не предупреждает ни о чём', () => {
    // Страница, всегда показывающая предупреждение, обесценивает
    // предупреждения — их перестают читать.
    expect(notice()).toBeNull();
  });

  it('браузер без уведомлений: честно и без слова «ошибка»', () => {
    const result = notice({ hasNotification: false, permission: null });
    expect(capabilitiesOf(env({ hasNotification: false, permission: null })).support).toBe(
      'unsupported',
    );
    expect(result?.tone).toBe('blocked');
    // Обещаем ровно то, что продолжит работать
    expect(result?.text).toContain('счётчик непрочитанных');
    expect(result?.steps).toEqual([]);
  });

  it('незащищённое соединение называется своим именем', () => {
    const result = notice({ isSecureContext: false });
    expect(capabilitiesOf(env({ isSecureContext: false })).support).toBe('insecure');
    expect(result?.title).toContain('защищённому соединению');
    expect(result?.steps.join(' ')).toContain('https://');
  });

  it('заблокированное разрешение объясняет, что сайт спросить не может', () => {
    const result = notice({ permission: 'denied' });
    expect(result?.tone).toBe('blocked');
    // Главное — не «включите уведомления», а «вот как это сделать руками»:
    // после отказа браузер больше не покажет запрос НИКОГДА.
    expect(result?.text).toContain('ещё раз');
    expect(result?.steps.length).toBeGreaterThan(0);
  });

  it('неспрошенное разрешение — не предупреждение, а объяснение', () => {
    const result = notice({ permission: 'default' });
    expect(result?.tone).toBe('info');
    expect(result?.text).toContain('не раньше');
  });

  it('браузер без фоновой доставки предупреждает только тех, кто её просил', () => {
    // Не просили — молчим: сообщение о неработающей возможности, которой
    // не пользуются, это шум.
    expect(notice({ hasPushManager: false }, { wantsPush: false })).toBeNull();

    const result = notice({ hasPushManager: false }, { wantsPush: true });
    expect(result?.tone).toBe('warning');
    expect(result?.title).toContain('закрытой вкладке');
    expect(result?.text).toContain('хотя бы в одной вкладке');
  });

  it('выключенный на сервере push пересказывает причину сервера', () => {
    const result = notice(
      {},
      {
        wantsPush: true,
        pushAvailable: false,
        pushUnavailableReason: 'Уведомления при закрытой вкладке выключены на сервере (PUSH_ENABLED=false)',
      },
    );
    expect(result?.text).toContain('PUSH_ENABLED=false');
    expect(result?.steps.join(' ')).toContain('администратору');
  });

  it('браузер без кнопок в уведомлении не выдаётся за поломку', () => {
    const result = notice({ hasActions: false });
    expect(result?.tone).toBe('info');
    expect(result?.text).toContain('откроется нужное письмо');
  });
});

describe('как вернуть отклонённое разрешение', () => {
  it('семейство браузера определяется, и Chrome не принимается за Safari', () => {
    // Chrome представляется и Chrome, и Safari сразу: при обратном
    // порядке проверок все инструкции были бы от Safari.
    expect(browserFamily(CHROME)).toBe('chrome');
    expect(browserFamily('Mozilla/5.0 … Chrome/131 Safari/537.36 Edg/131.0')).toBe('edge');
    expect(browserFamily('Mozilla/5.0 … Firefox/133.0')).toBe('firefox');
    expect(browserFamily('Mozilla/5.0 … Version/17.6 Safari/605.1.15')).toBe('safari');
    expect(browserFamily('какой-то неизвестный браузер')).toBe('other');
  });

  it('на каждое семейство есть свои шаги, и ни один список не пуст', () => {
    for (const family of ['chrome', 'edge', 'firefox', 'safari', 'other'] as const) {
      const steps = recoverySteps(family);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      // Последний шаг всегда возвращает человека сюда: без него он
      // включит разрешение в браузере и решит, что дальше само.
      expect(steps[steps.length - 1]).toContain('снова');
    }
  });

  it('шаги для Firefox и Safari разные — общей инструкции тут не бывает', () => {
    expect(recoverySteps('firefox')).not.toEqual(recoverySteps('safari'));
    expect(recoverySteps('safari').join(' ')).toContain('Safari');
  });
});

describe('две вкладки — одно окно', () => {
  const claims = (ids: string[], tabs: string[]): Claim[] =>
    ids.flatMap((id) => tabs.map((tabId) => ({ id, tabId })));

  it('показывает вкладка с наименьшим номером', () => {
    const list = claims(['inbox:296'], ['вкладка-3', 'вкладка-1', 'вкладка-2']);
    expect(claimWinner(list, 'inbox:296')).toBe('вкладка-1');
  });

  it('выбор не зависит от порядка заявок', () => {
    // Иначе «иногда» показывалось бы два окна — самая неприятная разновидность
    // ошибки: воспроизвести её нельзя, а жалобы приходят.
    const forward: Claim[] = [
      { id: 'x', tabId: 'a' },
      { id: 'x', tabId: 'b' },
      { id: 'x', tabId: 'c' },
    ];
    expect(claimWinner(forward, 'x')).toBe('a');
    expect(claimWinner([...forward].reverse(), 'x')).toBe('a');
  });

  it('заявки на разные письма друг другу не мешают', () => {
    const list: Claim[] = [
      { id: 'inbox:296', tabId: 'вкладка-2' },
      { id: 'inbox:297', tabId: 'вкладка-1' },
    ];
    expect(claimWinner(list, 'inbox:296')).toBe('вкладка-2');
    expect(claimWinner(list, 'inbox:297')).toBe('вкладка-1');
    expect(claimWinner(list, 'inbox:298')).toBeNull();
  });

  it('единственная вкладка выигрывает сама у себя', () => {
    expect(claimWinner([{ id: 'x', tabId: 'одна' }], 'x')).toBe('одна');
  });
});
