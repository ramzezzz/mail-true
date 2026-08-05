/**
 * Вход в почту.
 *
 * Маршрута входа не было вовсе: без сессии пользователь попадал на пустой
 * список писем и видел ошибку загрузки, не понимая, что нужно войти.
 * Экран намеренно скромный — логотип, два поля и кнопка, как на входе mail.ru.
 */

import { useState, type FormEvent } from 'react';
import { Button } from '../components';
import { useSession } from '../app/session';
import { loginErrorText } from '../lib/errorText';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={(e) => void onSubmit(e)}>
        <img className={styles.logo} src="/brand/logo-full.svg" alt="Mail.True" />
        <h1 className={styles.title}>Вход в почту</h1>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-email">
            Почтовый адрес
          </label>
          <input
            id="login-email"
            className={styles.input}
            type="email"
            autoComplete="username"
            autoFocus
            placeholder="имя@mail.local"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-password">
            Пароль
          </label>
          <input
            id="login-password"
            className={styles.input}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <Button
          type="submit"
          mode="primary"
          stretched
          disabled={busy || email.trim() === '' || password === ''}
        >
          {busy ? 'Проверяем…' : 'Войти'}
        </Button>
      </form>
    </div>
  );
}
