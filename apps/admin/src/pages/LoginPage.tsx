/**
 * Вход в админку.
 *
 * Отдельная точка входа: почтовый ящик здесь не примут, и наоборот —
 * админский логин не пустит в почту. Так требует docs/admin-spec.md.
 */
import { useState, type FormEvent } from 'react';
import { Button } from '@web/components';
import { useSession } from '../app/session';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { login } = useSession();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(name.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={(e) => void onSubmit(e)}>
        <h1 className={styles.title}>Администрирование Mail.True</h1>
        <p className={styles.subtitle}>
          Вход только для администраторов. Почтовый ящик здесь не подойдёт.
        </p>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.field}>
          <label className="mt-label" htmlFor="admin-login">
            Логин администратора
          </label>
          <input
            id="admin-login"
            className="mt-input"
            autoComplete="username"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className="mt-label" htmlFor="admin-password">
            Пароль
          </label>
          <input
            id="admin-password"
            className="mt-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <Button type="submit" stretched disabled={busy || name === '' || password === ''}>
          {busy ? 'Проверяем…' : 'Войти'}
        </Button>

        <p className={styles.footnote}>
          Первый администратор заводится из консоли:
          <br />
          <code className="mt-mono">node dist/admin/cli.js create-admin &lt;логин&gt; &lt;пароль&gt;</code>
        </p>
      </form>
    </div>
  );
}
