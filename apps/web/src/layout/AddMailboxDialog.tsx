/**
 * Окно «Добавить ящик» — второй свой ящик в том же интерфейсе.
 *
 * Пароль спрашивается ровно один раз: сервер проверяет его настоящим
 * IMAP-логином и дальше хранит зашифрованным, поэтому переключение
 * обходится без пароля (apps/api/src/accounts/routes.ts).
 *
 * Отказы называются словами сервера. Особенно 401: он значит «неверный
 * пароль ЭТОГО ящика», а не «ваша сессия закончилась», и вылетать из
 * почты из-за опечатки человек не должен (см. `api/http.ts`).
 */

import { useState, type FormEvent } from 'react';
import { useAccounts, useLinkAccount } from '../api/accountsQueries';
import { Button, Modal, TextField } from '../components';
import { linkErrorText } from '../lib/errorText';
import styles from './AddMailboxDialog.module.css';

export interface AddMailboxDialogProps {
  onClose(): void;
  /** Ящик добавлен — снаружи можно, например, обновить счётчики. */
  onAdded?(email: string): void;
}

export function AddMailboxDialog({ onClose, onAdded }: AddMailboxDialogProps) {
  const { data: accounts } = useAccounts();
  const link = useLinkAccount();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const secretsOff = accounts?.secrets.available === false;

  /**
   * Проверка до отправки. Сервер на повторное связывание отвечает 200 и
   * молча оставляет всё как было — человек нажал бы «Добавить» и не понял,
   * почему ничего не изменилось. Поэтому говорим прямо.
   */
  function localError(address: string): string | null {
    const value = address.trim().toLowerCase();
    if (value === '') return 'Укажите адрес ящика';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return 'Похоже, это не адрес почты';
    if (accounts && value === accounts.current.toLowerCase()) return 'Это и есть текущий ящик';
    if (accounts?.linked.some((a) => a.email.toLowerCase() === value)) {
      return 'Этот ящик уже добавлен';
    }
    return null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    const complaint = localError(address);
    if (complaint) {
      setError(complaint);
      return;
    }
    if (password === '') {
      setError('Введите пароль от добавляемого ящика');
      return;
    }
    setError(null);
    try {
      await link.mutateAsync({ email: address, password });
      onAdded?.(address);
      onClose();
    } catch (err) {
      setError(linkErrorText(err));
    }
  }

  return (
    <Modal title="Добавить ящик" onClose={onClose} className={styles.card}>
      {/* Обещание не отдаём наружу: onSubmit ждёт обычную функцию, и его
          отказ никто бы не поймал. Все отказы submit ловит сам и кладёт
          в сообщение над формой. */}
      <form
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <p className={styles.lead}>
          Второй ваш ящик на этом сервере. Пароль спросим один раз — дальше переключение будет без
          него.
        </p>

        {secretsOff && (
          <p className={styles.warning} role="alert">
            Сервер не может хранить пароли связанных ящиков
            {accounts?.secrets.reason ? `: ${accounts.secrets.reason}` : ''}. Добавление не
            сработает, пока это не настроят.
          </p>
        )}

        <TextField
          label="Адрес ящика"
          type="email"
          inputMode="email"
          autoComplete="username"
          placeholder="name@mail.local"
          value={email}
          autoFocus
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
        />
        <TextField
          label="Пароль"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <Button type="submit" disabled={link.isPending}>
            {link.isPending ? 'Проверяем…' : 'Добавить'}
          </Button>
          <Button type="button" mode="secondary" onClick={onClose} disabled={link.isPending}>
            Отменить
          </Button>
        </div>
      </form>
    </Modal>
  );
}
