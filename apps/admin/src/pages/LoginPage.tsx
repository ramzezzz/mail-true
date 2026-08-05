/**
 * Вход в панель управления почтовым сервером.
 *
 * Отдельная точка входа: почтовый ящик здесь не примут, и наоборот —
 * админский логин не пустит в почту. Так требует docs/admin-spec.md.
 *
 * Оформление устроено как у входа в почту — тёмный фон с созвездием точек,
 * проволочный глобус слева, светлая карточка справа, ни одной растровой
 * картинки, — но в своей гамме и со своими значками (см. login/loginPalette.ts
 * и login/adminIcons.tsx). Это не украшательство: администратор, увидев
 * привычный синий экран почты, набирает почтовый пароль вслепую.
 */
import { useState, type FormEvent } from 'react';
import { Button } from '@web/components';
import { useSession } from '../app/session';
import { AdminIconSprite, ICON_PREFIX } from './login/adminIcons';
import { LoginConstellation } from './login/LoginConstellation';
import { LoginGlobe } from './login/LoginGlobe';
import { paletteVars } from './login/loginPalette';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { login } = useSession();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
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

  /** Caps Lock ловим на обоих полях: включённый Caps — частая причина отказа. */
  function trackCaps(event: React.KeyboardEvent<HTMLInputElement>): void {
    setCapsOn(event.getModifierState('CapsLock'));
  }

  return (
    <div className={styles.page} style={paletteVars() as React.CSSProperties}>
      {/* Значки рисуются кодом и живут прямо в странице: своей папки со
          статикой у админки нет, файл спрайта в её сборку не попадает. */}
      <AdminIconSprite />

      <LoginConstellation />
      <div className={styles.hazeTeal} aria-hidden="true" />
      <div className={styles.hazeSteel} aria-hidden="true" />

      <LoginGlobe />

      <section className={styles.panel}>
        <form className={styles.card} onSubmit={(e) => void onSubmit(e)}>
          <div className={styles.brand}>
            <svg className={styles.brandMark} viewBox="0 0 24 24" aria-hidden="true">
              <use href={`#${ICON_PREFIX}console`} />
            </svg>
            <span className={styles.brandName}>Mail.True</span>
          </div>

          {/* Заголовок первого уровня, а не подпись: по нему человек,
              читающий с экрана, понимает, куда попал. */}
          <h1 className={styles.title}>Вход в панель управления</h1>
          <p className={styles.subtitle}>
            Управление почтовым сервером: ящики и пользователи, домены, ключи подписи, журнал.
            Это не вход в почту — почтовый ящик здесь не подойдёт.
          </p>

          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="admin-login">
              Логин администратора
            </label>
            <div className={styles.uline}>
              <input
                id="admin-login"
                className={styles.input}
                autoComplete="username"
                autoFocus
                spellCheck={false}
                value={name}
                onKeyUp={trackCaps}
                onChange={(e) => setName(e.target.value)}
              />
              {name !== '' && (
                <button
                  type="button"
                  className={styles.ulineBtn}
                  aria-label="Очистить логин"
                  tabIndex={-1}
                  onClick={() => setName('')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.5 12.1-1.4 1.4L12 13.4l-2.1 2.1-1.4-1.4L10.6 12 8.5 9.9l1.4-1.4L12 10.6l2.1-2.1 1.4 1.4L13.4 12l2.1 2.1Z" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="admin-password">
              Пароль
            </label>
            <div className={styles.uline}>
              <input
                id="admin-password"
                className={styles.input}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onKeyUp={trackCaps}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className={styles.ulineBtn}
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                aria-pressed={showPassword}
                tabIndex={-1}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 4.3 3.3 3 21 20.7 19.7 22l-3.1-3.1A11.7 11.7 0 0 1 12 19C6.5 19 2.7 14.9 1 12a17 17 0 0 1 4.2-4.9L2 4.3Zm7.6 7.6 2.5 2.5a2 2 0 0 1-2.5-2.5Zm2.4-3.9c2.2 0 4 1.8 4 4 0 .5-.1 1-.3 1.5l-5.2-5.2c.5-.2 1-.3 1.5-.3Zm0-3C17.5 5 21.3 9.1 23 12a17.2 17.2 0 0 1-2.8 3.6l-2.9-2.9a4 4 0 0 0-5-5L9.9 5.3c.7-.2 1.4-.3 2.1-.3Z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5C6.5 5 2.7 9.1 1 12c1.7 2.9 5.5 7 11 7s9.3-4.1 11-7c-1.7-2.9-5.5-7-11-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
                  </svg>
                )}
              </button>
            </div>
            {capsOn && (
              <p className={styles.caps} role="status">
                Включён Caps Lock — пароль вводится заглавными
              </p>
            )}
          </div>

          {/* Размер l — это 44 точки высоты: попасть пальцем с первого раза. */}
          <Button
            type="submit"
            mode="primary"
            size="l"
            stretched
            disabled={busy || name.trim() === '' || password === ''}
          >
            {busy ? 'Проверяем…' : 'Войти'}
          </Button>

          {/*
            Команда должна быть такой, чтобы её можно было скопировать и
            выполнить. Прежняя подсказка врала дважды: путь `dist/admin/cli.js`
            не существует (рабочий каталог контейнера — /srv, а программа лежит
            в apps/api/dist), и роль была опущена, поэтому по подсказке всегда
            получался администратор с полным доступом.
          */}
          <p className={styles.hint}>
            Первый администратор заводится из консоли сервера:
            <br />
            <code>
              docker compose -f infra/docker-compose.yml exec api \
              <br />
              &nbsp;&nbsp;node apps/api/dist/admin/cli.js create-admin &lt;логин&gt; &lt;пароль&gt; owner
            </code>
            <br />
            Роль: <code>owner</code>, <code>user_manager</code> или <code>readonly</code>.
          </p>
        </form>
      </section>

      <footer className={styles.footer}>
        <p>Панель управления почтовым сервером Mail.True. Отдельный вход, отдельные права.</p>
        <p>Каждое действие в панели попадает в журнал: кто, что и когда.</p>
      </footer>
    </div>
  );
}
