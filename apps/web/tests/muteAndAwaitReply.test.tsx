// @vitest-environment jsdom
/**
 * Кнопки «Заглушить» и «Ждать ответа» появляются вместе с поведением.
 *
 * Общее правило продукта: кнопки нет, пока сервер не сказал, что за ней
 * что-то стоит. У этих двух возможностей условие ЖЁСТЧЕ обычного, и
 * проверяется здесь именно оно:
 *
 *   - заглушка без правил доставки прячет письма только в списке — то есть
 *     человек нажимает кнопку, а письма продолжают падать во «Входящие».
 *     Ровно от таких кнопок продукт и избавляется;
 *   - ожидание ответа без служебного доступа к Dovecot поставит срок,
 *     который некому проверить, — обещание, которого не будет.
 *
 * Плюс режим заглушек интерфейса: там ни того, ни другого нет вовсе, и
 * клиент обязан сказать это ЧЕСТНО, а не сходить на настоящий адрес и
 * увести человека на экран входа.
 */

import { describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type { Folder } from '@mail-true/shared';
import { ListToolbar, type ListToolbarProps } from '../src/mail/ListToolbar';
import { MUTE_ON_MOCKS, MUTE_UNAVAILABLE } from '../src/mail/muteApi';
import { AWAIT_ON_MOCKS, AWAIT_UNAVAILABLE } from '../src/mail/awaitReplyApi';

const folders: Folder[] = [
  {
    id: 'inbox',
    path: 'INBOX',
    name: 'INBOX',
    role: 'inbox',
    parentId: null,
    depth: 0,
    unreadCount: 0,
    totalCount: 1,
    system: true,
    uidValidity: 1,
  },
];

const noop = () => undefined;

function props(patch: Partial<ListToolbarProps> = {}): ListToolbarProps {
  return {
    selectedCount: 2,
    filter: 'all',
    onFilterChange: noop,
    folders,
    onSelectAll: noop,
    onClearSelection: noop,
    onMarkAllRead: noop,
    onDelete: noop,
    onArchive: noop,
    onMoveTo: noop,
    onUnsubscribe: noop,
    onMarkUnread: noop,
    onToggleFlag: noop,
    onSpam: noop,
    onPrint: noop,
    onCreateFilter: noop,
    onForwardAsAttachment: noop,
    ...patch,
  };
}

function withToolbar(p: ListToolbarProps, check: (host: HTMLDivElement) => void): void {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  try {
    act(() => root.render(<ListToolbar {...p} />));
    check(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

function hasButton(host: HTMLDivElement, text: string): boolean {
  return [...host.querySelectorAll('button')].some((b) => b.textContent?.includes(text));
}

describe('кнопка появляется вместе с поведением', () => {
  it('без обработчика кнопки «Заглушить» нет вовсе', () => {
    withToolbar(props(), (host) => {
      expect(hasButton(host, 'Заглушить')).toBe(false);
    });
  });

  it('с обработчиком кнопка «Заглушить» есть', () => {
    withToolbar(props({ onMute: noop }), (host) => {
      expect(hasButton(host, 'Заглушить')).toBe(true);
    });
  });

  it('в самой папке «Заглушённые» вместо неё обратное действие', () => {
    withToolbar(props({ onUnmute: noop }), (host) => {
      expect(hasButton(host, 'Заглушить')).toBe(false);
      expect(hasButton(host, 'Вернуть переписку')).toBe(true);
    });
  });

  it('без обработчика кнопки «Ждать ответа» нет вовсе', () => {
    withToolbar(props(), (host) => {
      expect(hasButton(host, 'Ждать ответа')).toBe(false);
    });
  });

  it('с обработчиком кнопка «Ждать ответа» есть, а рядом — «Больше не ждать»', () => {
    withToolbar(props({ onAwaitReply: noop }), (host) => {
      expect(hasButton(host, 'Ждать ответа')).toBe(true);
      expect(hasButton(host, 'Больше не ждать')).toBe(false);
    });
    withToolbar(props({ onCancelAwaitReply: noop }), (host) => {
      expect(hasButton(host, 'Больше не ждать')).toBe(true);
    });
  });

  it('меню сроков говорит «если не ответят», а не «вернуть письмо»', () => {
    withToolbar(props({ onAwaitReply: noop }), (host) => {
      const trigger = [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Ждать ответа'),
      );
      expect(trigger).toBeDefined();
      act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const menu = host.querySelector('[role="menu"]');
      expect(menu).not.toBeNull();
      /*
       * Разница не в словах: письмо, которое возвращается ВСЕГДА, — это
       * ещё один пункт в списке дел, и через неделю человек перестаёт его
       * замечать. Возможность стоит ровно того, что возврат происходит
       * только при молчании собеседника.
       */
      expect(menu!.textContent).toContain('Напомнить, если не ответят');
      expect(menu!.textContent).toContain('Завтра утром');
    });
  });

  it('предупреждение о неработающей проверке стоит в самом меню', () => {
    withToolbar(props({ onAwaitReply: noop, awaitScheduledCheck: false }), (host) => {
      const trigger = [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Ждать ответа'),
      );
      act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      // Человек должен узнать об этом ДО того, как понадеется на срок.
      expect(host.querySelector('[role="menu"]')?.textContent).toContain('некому');
    });
  });
});

describe('состояние возможности до ответа сервера', () => {
  it('пока сервер молчит, обе возможности считаются отсутствующими', () => {
    expect(MUTE_UNAVAILABLE.available).toBe(false);
    expect(MUTE_UNAVAILABLE.delivery).toBe(false);
    expect(AWAIT_UNAVAILABLE.available).toBe(false);
    expect(AWAIT_UNAVAILABLE.scheduledCheck).toBe(false);
  });

  it('на заглушках интерфейса возможности нет — и сказано почему', () => {
    expect(MUTE_ON_MOCKS.available).toBe(false);
    expect(MUTE_ON_MOCKS.reason).toMatch(/сервере/);
    expect(AWAIT_ON_MOCKS.available).toBe(false);
    expect(AWAIT_ON_MOCKS.reason).toMatch(/сервер/);
  });
});
