/**
 * Вход в почту.
 *
 * Оформление перенесено из прототипа `login_page/`: тёмный фон с созвездием
 * точек, тянущихся к курсору, проволочный глобус слева и белая карточка
 * входа справа. Всё нарисовано кодом — ни одной растровой картинки, поэтому
 * страница не тянет за собой мегабайты и одинаково выглядит на любом экране.
 *
 * Чего из прототипа здесь НЕТ и почему:
 *
 *  - переключателя языков: продукт русскоязычный, а переключатель, меняющий
 *    язык только на одной странице, обещает то, чего нет;
 *  - поля с картинкой-кодом: подбор пароля у нас ограничивает сервер
 *    (10 попыток в минуту с адреса), и картинка добавила бы человеку работы,
 *    ничего не добавив к защите;
 *  - ссылки «забыли пароль»: своей выдачи паролей у продукта нет, пароль
 *    меняет администратор. Вместо мёртвой ссылки — подсказка об этом.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../components';
import { useSession } from '../app/session';
import { logoAlt, logoSrc, useBranding } from '../lib/branding';
import { loginErrorText } from '../lib/errorText';
import { LoginConstellation } from './login/LoginConstellation';
import { LoginGlobe } from './login/LoginGlobe';
import { pausedAttr, usePageVisible } from './login/usePageVisible';
import styles from './LoginPage.module.css';

/** Где помним адрес между входами. Пароль не помним никогда. */
const REMEMBERED_EMAIL = 'mt.login.email';

export function LoginPage() {
  const { login } = useSession();
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBERED_EMAIL) ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => localStorage.getItem(REMEMBERED_EMAIL) !== null);
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  /** Своё оформление входа: логотип и название компании (см. lib/branding.ts). */
  const branding = useBranding();
  /** Пока вкладку не видно, украшения фона стоят: они всё равно никому не видны. */
  const visible = usePageVisible();

  // Если адрес уже запомнен, курсор ставим в пароль: человеку остаётся
  // ровно одно действие вместо двух.
  useEffect(() => {
    if (email !== '') passwordRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      if (remember) localStorage.setItem(REMEMBERED_EMAIL, email.trim());
      else localStorage.removeItem(REMEMBERED_EMAIL);
    } catch (err) {
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Caps Lock ловим на обоих полях: включённый Caps — частая причина отказа. */
  function trackCaps(event: React.KeyboardEvent<HTMLInputElement>): void {
    setCapsOn(event.getModifierState('CapsLock'));
  }

  return (
    <div className={styles.page} data-paused={pausedAttr(visible)}>
      <LoginConstellation />
      <div className={styles.bokehBlue} aria-hidden="true" />
      <div className={styles.bokehWarm} aria-hidden="true" />

      <LoginGlobe />

      <section className={styles.panel}>
        <form className={styles.card} onSubmit={(e) => void onSubmit(e)}>
          <div className={styles.brand}>
            {/* Логотип берётся из настроек панели управления (OEM): продукт
                ставят под своим именем, и лицо страницы входа задаёт
                администратор, а не сборка. Пока ответа нет — стандартный
                знак, см. lib/branding.ts. */}
            <img className={styles.logo} src={logoSrc(branding)} alt={logoAlt(branding)} />
            {branding.companyName !== null && (
              <span className={styles.company}>{branding.companyName}</span>
            )}
          </div>
          {/*
            Настоящий заголовок, а не просто подпись: у страницы должен быть
            заголовок первого уровня — по нему человек, читающий с экрана,
            понимает, куда попал.
          */}
          <h1 className={styles.tagline}>Вход в почту</h1>

          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-email">
              Почтовый адрес
            </label>
            <div className={styles.uline}>
              <input
                id="login-email"
                className={styles.input}
                type="email"
                autoComplete="username"
                autoFocus={email === ''}
                spellCheck={false}
                placeholder="имя@домен.ру"
                value={email}
                onKeyUp={trackCaps}
                onChange={(e) => setEmail(e.target.value)}
              />
              {email !== '' && (
                <button
                  type="button"
                  className={styles.ulineBtn}
                  aria-label="Очистить адрес"
                  tabIndex={-1}
                  onClick={() => setEmail('')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.5 12.1-1.4 1.4L12 13.4l-2.1 2.1-1.4-1.4L10.6 12 8.5 9.9l1.4-1.4L12 10.6l2.1-2.1 1.4 1.4L13.4 12l2.1 2.1Z" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-password">
              Пароль
            </label>
            <div className={styles.uline}>
              <input
                id="login-password"
                ref={passwordRef}
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

          <div className={styles.row}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className={styles.checkBox} aria-hidden="true" />
              <span>Запомнить адрес</span>
            </label>
          </div>

          <Button
            type="submit"
            mode="primary"
            stretched
            disabled={busy || email.trim() === '' || password === ''}
          >
            {busy ? 'Проверяем…' : 'Войти'}
          </Button>

          <p className={styles.hint}>
            Пароль забыт или не подходит — обратитесь к администратору почты.
          </p>
        </form>
      </section>

      <footer className={styles.footer}>
        <p>Mail.True — почтовый сервер вашей организации. Работает в любом современном браузере.</p>
        <p>Ваша почта хранится на вашем сервере.</p>
      </footer>
    </div>
  );
}
