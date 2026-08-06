/**
 * Меню ящика в шапке — по образцу меню аватара mail.ru.
 *
 * Сервер умеет несколько ящиков в одном интерфейсе давно
 * (`/api/accounts/*`), а в вебе не было ни одного обращения к этим
 * маршрутам: возможность существовала и была недоступна человеку.
 * Здесь она наконец видна — список ящиков с непрочитанными у каждого,
 * переключение по нажатию, «Добавить ящик», отвязка и «Выйти».
 *
 * Переключение отдано `useSession().switchMailbox`: смена ящика — это
 * смена сессии, и чистить кэш запросов должно одно место, а не каждый,
 * кто вздумал переключиться.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts, useUnlinkAccount, useUnreadTotal } from '../api/accountsQueries';
import type { ExternalAccountSummary, LinkedAccount, UnreadEntry } from '../api/accountsTypes';
import { useAiState } from '../api/aiQueries';
import { useAccount } from '../api/queries';
import { AI_SETTINGS_PATH, aiNeedsConsent, aiVisible } from '../ai/aiVisibility';
import { useSession } from '../app/session';
import { useUiStore } from '../app/store';
import { Dropdown, MenuItem, MenuSeparator, Spinner, useDropdownClose } from '../components';
import { cx } from '../lib/cx';
import { actionErrorText } from '../lib/errorText';
import { IconExit, IconPlus, IconSparkles, IconTrash } from '../mail/icons';
import { AddMailboxDialog } from './AddMailboxDialog';
import styles from './AccountMenu.module.css';

/** Раздел настроек, где чужим ящиком можно управлять. */
const COLLECTOR_SETTINGS_PATH = '/settings/collector';

/** Буквы на аватаре: первые буквы первых двух слов имени. */
export function initials(name: string): string {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Счётчик на значок: трёхзначные числа в кружок 18px не влезают, а
 * «336» вместо «99+» растянуло бы аватар в шапке.
 */
export function badgeText(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

interface MailboxRowProps {
  item: LinkedAccount;
  /** Строка счётчика этого ящика из общего ответа сервера. */
  entry: UnreadEntry | undefined;
  busy: boolean;
  onSwitch(email: string): Promise<void>;
  onAskUnlink(email: string): void;
}

/**
 * Строка привязанного ящика.
 *
 * Отдельным компонентом ради `useDropdownClose`: хук работает только у
 * того, кто нарисован внутри меню. Без закрытия меню зависало бы поверх
 * уже переключённой почты.
 */
function MailboxRow({ item, entry, busy, onSwitch, onAskUnlink }: MailboxRowProps) {
  const close = useDropdownClose();
  return (
    <div className={styles.row}>
      <button
        type="button"
        role="menuitem"
        className={styles.mailbox}
        disabled={busy}
        onClick={() => {
          // Меню закрываем после переключения, а не до: пока сервер заводит
          // новую сессию, в строке видно, что что-то происходит.
          //
          // Обещание намеренно не возвращается наружу: onClick ждёт обычную
          // функцию, и обещание, отданное ему, при отказе никем не ловится —
          // человек видел бы застывшую строку без объяснения. Отказ
          // обрабатывает сам onSwitch (он показывает сообщение), а здесь
          // остаётся только не закрыть меню.
          void onSwitch(item.email).then(close);
        }}
      >
        <span className={styles.mailboxAvatar} aria-hidden="true">
          {initials(item.label ?? item.email)}
        </span>
        <span className={styles.mailboxEmail}>{item.email}</span>
        {busy ? (
          <Spinner size={16} />
        ) : entry?.error ? (
          /* Ящик не ответил: врать нулём непрочитанных нельзя */
          <span className={styles.mailboxWarn} title={entry.error}>
            !
          </span>
        ) : (
          entry != null &&
          entry.unread > 0 && (
            <span className={styles.mailboxUnread}>{badgeText(entry.unread)}</span>
          )
        )}
      </button>
      <button
        type="button"
        className={styles.unlink}
        aria-label={`Отвязать ящик ${item.email}`}
        title="Отвязать ящик"
        onClick={() => onAskUnlink(item.email)}
      >
        <IconTrash size={16} />
      </button>
    </div>
  );
}

/**
 * Что показать в строке подключённого чужого ящика.
 *
 * Отказ сборщика обязан быть виден здесь, а не только в настройках:
 * подключение, которое молча перестало забирать почту, — худший исход
 * из возможных. Человек видит «!» и причину, а не пустую строку.
 */
export function externalHint(item: ExternalAccountSummary): { text: string; failed: boolean } {
  if (!item.enabled) return { text: 'сбор выключен', failed: false };
  if (item.state.status === 'error') {
    return { text: item.state.error ?? 'сбор не удался', failed: true };
  }
  if (item.state.status === 'running') return { text: 'забираем письма…', failed: false };
  if (item.state.status === 'never') return { text: 'ещё не забирали', failed: false };
  if (item.state.status === 'partial') {
    return { text: item.state.error ?? 'забрали не всё', failed: true };
  }
  return { text: 'письма приходят сюда', failed: false };
}

/**
 * Строка подключённого чужого ящика.
 *
 * Переключиться на него нельзя, и кнопкой она намеренно не притворяется:
 * письма сборщика лежат в ЭТОМ же ящике, отдельной сессии у чужого адреса
 * нет. Нажатие ведёт в настройки подключения — единственное место, где с
 * ним можно что-то сделать.
 */
function ExternalRow({ item, onOpen }: { item: ExternalAccountSummary; onOpen(): void }) {
  const close = useDropdownClose();
  const hint = externalHint(item);
  return (
    <button
      type="button"
      role="menuitem"
      className={cx(styles.mailbox, styles.externalRow)}
      onClick={() => {
        onOpen();
        close();
      }}
    >
      <span className={styles.mailboxAvatar} aria-hidden="true">
        {initials(item.label ?? item.address)}
      </span>
      <span className={styles.mailboxText}>
        <span className={styles.mailboxEmail}>{item.address}</span>
        <span className={cx(styles.mailboxHint, hint.failed && styles.mailboxHintError)}>
          {hint.text}
        </span>
      </span>
      {hint.failed && (
        <span className={styles.mailboxWarn} title={hint.text}>
          !
        </span>
      )}
    </button>
  );
}

export function AccountMenu() {
  const { data: account } = useAccount();
  const { data: accounts } = useAccounts();
  const { data: aiState } = useAiState();
  const { session, logout, switchMailbox } = useSession();
  const { total, byAccount } = useUnreadTotal();
  const unlink = useUnlinkAccount();
  const showNotice = useUiStore((s) => s.showNotice);
  const navigate = useNavigate();

  const [addOpen, setAddOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null);

  const aiShown = aiVisible(aiState);
  const aiNeedsSetup = aiNeedsConsent(aiState);

  const currentEmail = accounts?.current ?? account?.email ?? session?.email ?? '…';
  const linked = accounts?.linked ?? [];
  const external = accounts?.external ?? [];

  /** Непрочитанные конкретного ящика из общего ответа сервера. */
  const unreadOf = (email: string) =>
    byAccount.find((e) => e.email.toLowerCase() === email.toLowerCase());

  async function onSwitch(email: string) {
    setSwitching(email);
    try {
      await switchMailbox(email);
      // Ящик другой — и папка, и открытое письмо к нему не относятся.
      void navigate('/inbox/');
    } catch (error) {
      showNotice(actionErrorText('Не удалось переключить ящик', error));
    } finally {
      setSwitching(null);
    }
  }

  async function onUnlink(email: string) {
    setConfirmUnlink(null);
    try {
      await unlink.mutateAsync(email);
    } catch (error) {
      showNotice(actionErrorText('Не удалось отвязать ящик', error));
    }
  }

  return (
    <>
      <Dropdown
        align="right"
        menuClassName={styles.menu}
        trigger={({ toggle }) => (
          <button
            type="button"
            className={styles.avatarButton}
            title={currentEmail}
            aria-label={
              total > 0 ? `Меню ящика, непрочитанных во всех ящиках: ${total}` : 'Меню ящика'
            }
            onClick={toggle}
          >
            <span className={styles.avatar}>
              {account?.avatarUrl ? (
                <img src={account.avatarUrl} alt="" />
              ) : (
                <span>{account ? initials(account.displayName) : '·'}</span>
              )}
            </span>
            {/* Общий счётчик по всем ящикам — то же число, что в заголовке
                вкладки: источник у них один (useUnreadTotal) */}
            {total > 0 && (
              <span className={styles.avatarBadge} aria-hidden="true">
                {badgeText(total)}
              </span>
            )}
          </button>
        )}
      >
        <div className={styles.current}>
          <span className={styles.currentAvatar} aria-hidden="true">
            {account?.avatarUrl ? (
              <img src={account.avatarUrl} alt="" />
            ) : (
              <span>{account ? initials(account.displayName) : '·'}</span>
            )}
          </span>
          <span className={styles.currentText}>
            {account?.displayName && (
              <span className={styles.currentName}>{account.displayName}</span>
            )}
            <span className={styles.currentEmail}>{currentEmail}</span>
          </span>
        </div>

        {linked.length > 0 && <MenuSeparator />}

        {linked.map((item) =>
          confirmUnlink === item.email ? (
            <div key={item.id} className={styles.confirm} role="group">
              <span className={styles.confirmText}>Отвязать {item.email}?</span>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.confirmDanger}
                  onClick={() => void onUnlink(item.email)}
                >
                  Отвязать
                </button>
                <button
                  type="button"
                  className={styles.confirmCancel}
                  onClick={() => setConfirmUnlink(null)}
                >
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <MailboxRow
              key={item.id}
              item={item}
              entry={unreadOf(item.email)}
              busy={switching === item.email}
              onSwitch={onSwitch}
              onAskUnlink={setConfirmUnlink}
            />
          ),
        )}

        {/* Чужие ящики — отдельной группой: переключаться на них нельзя,
            их почта приходит сюда, и путать их со своими не надо */}
        {external.length > 0 && (
          <>
            <MenuSeparator />
            <div className={styles.groupTitle}>Почта с других ящиков</div>
            {external.map((item) => (
              <ExternalRow
                key={item.id}
                item={item}
                onOpen={() => void navigate(COLLECTOR_SETTINGS_PATH)}
              />
            ))}
          </>
        )}

        <MenuSeparator />

        <MenuItem before={<IconPlus />} onClick={() => setAddOpen(true)}>
          Добавить ящик
        </MenuItem>

        {/* Помощника нет в меню, пока администратор его не разрешил */}
        {aiShown && (
          <MenuItem
            before={<IconSparkles />}
            onClick={() => {
              void navigate(AI_SETTINGS_PATH);
            }}
          >
            Помощник на основе ИИ{aiNeedsSetup ? ' — включить' : ''}
          </MenuItem>
        )}

        <MenuSeparator />

        {/* Выход есть на сервере (POST /api/auth/logout), а в меню его не было */}
        <MenuItem before={<IconExit />} onClick={() => void logout()}>
          Выйти
        </MenuItem>
      </Dropdown>

      {addOpen && <AddMailboxDialog onClose={() => setAddOpen(false)} />}
    </>
  );
}
