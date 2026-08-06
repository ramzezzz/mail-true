// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MessageList } from '../src/mail/MessageList';
import styles from '../src/mail/MessageList.module.css';

describe('dbg', () => {
  it('dbg', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <MemoryRouter>
          <MessageList
            messages={[{ id: '1', folderId: 'inbox', uid: 1, threadId: 't', from: {name:'A',address:'a@b'}, to: [], cc: [], subject: 'S', snippet: '', date: new Date().toISOString(), flags: {seen:true,flagged:false,answered:false,forwarded:false,draft:false,deleted:false,mdnSent:false}, hasAttachments: false, attachmentNames: [], labels: ['mt-oplatit'], pinned: false, returnedFromSnooze: false, sizeBytes: 1, senderLogoDomain: null } as never]}
            labels={[{ key: 'mt-oplatit', name: 'Оплатить', color: 'red', position: 0 }]}
            rowLabels={new Map([['1', ['mt-oplatit']]])}
          />
        </MemoryRouter>,
      );
    });
    console.log('rowLabels class =', JSON.stringify((styles as Record<string,string>)['rowLabels']));
    console.log('HTML:', host.innerHTML.slice(0, 1500));
    expect(1).toBe(1);
  });
});
