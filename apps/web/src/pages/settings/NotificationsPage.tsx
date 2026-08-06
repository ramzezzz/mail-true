/**
 * Настройки уведомлений о новых письмах.
 *
 * ------------------------------------------------------------------
 * ЧЕМ ЭТА СТРАНИЦА ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ НАСТРОЕК
 * ------------------------------------------------------------------
 * Остальные разделы работают по схеме «черновик — кнопка Сохранить»:
 * правки копятся, уходят одним запросом. Здесь так нельзя, и вот почему.
 *
 * Включение уведомлений — это не запись значения, а РАЗГОВОР С БРАУЗЕРОМ:
 * он показывает своё окно с вопросом, и показать его можно только прямо
 * в обработчике нажатия. Отложить до кнопки «Сохранить» — значит потерять
 * связь между действием человека и вопросом браузера; Chrome и Firefox в
 * таком случае запрос глушат. Поэтому переключатели здесь применяются
 * сразу, а страница честно показывает, что произошло.
 *
 * Главный выключатель живёт в ОБЩИХ настройках ящика (`notifications.browser`)
 * — он был там раньше этого раздела и показывается на странице «Общие».
 * Второго такого же здесь нет намеренно: два выключателя одного и того же
 * — прямая дорога к «включил, а не работает». Эта страница правит тот же
 * самый флажок через тот же самый маршрут.
 */

import { useEffect, useMemo, useState } from 'react';
import { useGeneralSettings, useSaveGeneralSettings } from '../../api/settingsQueries';
import { Button, Switch } from '../../components';
import {
  SettingsError,
  SettingsHint,
  SettingsSection,
  SettingsSkeleton,
  SettingsTitle,
} from '../../settings/ui';
import { capabilitiesOf, capabilityNotice, readEnvironment } from '../../notifications/capability';
import { browserClientId, browserTimeZone, notificationsApi } from '../../notifications/api';
import {
  useRefreshPushState,
  useSaveNotificationPrefs,
  usePushState,
} from '../../notifications/queries';
import { disablePush, enablePush } from '../../notifications/subscribe';
import { LEVEL_INFO, NOTIFICATION_LEVELS, type NotificationLevel } from '../../notifications/types';
import styles from './NotificationsPage.module.css';

/** Минуты от полуночи в «ЧЧ:ММ» для поля времени и обратно. */
export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function timeToMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

export function NotificationsPage() {
  const state = usePushState();
  const general = useGeneralSettings();
  const saveGeneral = useSaveGeneralSettings();
  const savePrefs = useSaveNotificationPrefs();
  const refresh = useRefreshPushState();

  /**
   * Возможности браузера читаются в состояние, а не при каждой отрисовке:
   * `Notification.permission` меняется прямо во время работы страницы
   * (человек ответил на вопрос браузера), и React об этом не узнает сам.
   */
  const [environment, setEnvironment] = useState(() => readEnvironment());
  const capabilities = useMemo(() => capabilitiesOf(environment), [environment]);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Часовой пояс отправляем один раз, если сервер его ещё не знает:
   * «тихие часы» задаются по местному времени, и спрашивать о нём
   * отдельно было бы вопросом с готовым ответом.
   */
  const prefs = state.data?.prefs;
  useEffect(() => {
    if (!prefs || prefs.timeZone) return;
    const zone = browserTimeZone();
    if (zone) savePrefs.mutate({ timeZone: zone });
    // savePrefs намеренно не в зависимостях: он новый на каждой отрисовке,
    // и с ним эффект зациклился бы на самом себе.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs?.timeZone]);

  if (state.isError || general.isError) {
    return (
      <>
        <SettingsTitle>Уведомления</SettingsTitle>
        <SettingsError>Не удалось загрузить настройки уведомлений. Обновите страницу.</SettingsError>
      </>
    );
  }

  if (state.isPending || general.isPending || !state.data || !general.data || !prefs) {
    return (
      <>
        <SettingsTitle>Уведомления</SettingsTitle>
        <SettingsSkeleton rows={6} />
      </>
    );
  }

  const settings = general.data;
  const enabled = settings.notifications.browser;
  const notice = capabilityNotice({
    capabilities,
    userAgent: environment.userAgent,
    wantsPush: prefs.push,
    pushAvailable: state.data.pushAvailable,
    pushUnavailableReason: state.data.pushUnavailableReason,
  });

  /**
   * Включение уведомлений. Разрешение спрашивается ЗДЕСЬ — прямо в
   * обработчике нажатия, как того требуют браузеры (см. subscribe.ts).
   */
  const toggleEnabled = async (next: boolean): Promise<void> => {
    setMessage(null);
    if (!next) {
      await saveGeneral.mutateAsync({
        ...settings,
        notifications: { ...settings.notifications, browser: false },
      });
      await disablePush().catch(() => undefined);
      savePrefs.mutate({ push: false });
      setEnvironment(readEnvironment());
      return;
    }

    setBusy(true);
    try {
      const permission =
        typeof Notification === 'undefined' ? 'denied' : await Notification.requestPermission();
      setEnvironment(readEnvironment());
      if (permission !== 'granted') {
        setMessage({
          tone: 'bad',
          text:
            permission === 'denied'
              ? 'Браузер заблокировал уведомления. Как вернуть разрешение — написано ниже.'
              : 'Разрешение не выдано: без него всплывающих окон не будет.',
        });
        return;
      }
      await saveGeneral.mutateAsync({
        ...settings,
        notifications: { ...settings.notifications, browser: true },
      });
      setMessage({ tone: 'ok', text: 'Уведомления включены.' });
    } finally {
      setBusy(false);
    }
  };

  /** Доставка при закрытой вкладке: подписка в браузере плюс запись у нас. */
  const togglePush = async (next: boolean): Promise<void> => {
    setMessage(null);
    setBusy(true);
    try {
      if (!next) {
        await disablePush().catch(() => undefined);
        savePrefs.mutate({ push: false });
        refresh();
        return;
      }
      const result = await enablePush(state.data.vapidPublicKey);
      setEnvironment(readEnvironment());
      if (!result.ok) {
        setMessage({ tone: 'bad', text: result.message ?? 'Не удалось включить фоновую доставку' });
        return;
      }
      savePrefs.mutate({ push: true });
      refresh();
      setMessage({
        tone: 'ok',
        text: 'Готово. Уведомления будут приходить и с закрытой вкладкой почты.',
      });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setMessage(null);
    setBusy(true);
    try {
      const result = await notificationsApi.sendTest(browserClientId());
      setMessage(
        result.sent > 0
          ? { tone: 'ok', text: 'Проверочное уведомление отправлено — оно вот-вот появится.' }
          : { tone: 'bad', text: result.error ?? 'Проверочное уведомление отправить не удалось' },
      );
    } catch {
      setMessage({ tone: 'bad', text: 'Проверочное уведомление отправить не удалось' });
    } finally {
      setBusy(false);
    }
  };

  const chooseLevel = (level: NotificationLevel): void => {
    savePrefs.mutate({ level });
  };

  const aiBlocked = !state.data.ai.available;

  return (
    <>
      <SettingsTitle>Уведомления</SettingsTitle>

      {notice && (
        <div className={styles[`notice-${notice.tone}`]} role="status">
          <p className={styles.noticeTitle}>{notice.title}</p>
          <p className={styles.noticeText}>{notice.text}</p>
          {notice.steps.length > 0 && (
            <ol className={styles.steps}>
              {notice.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}

      {message && (
        <p className={message.tone === 'ok' ? styles.messageOk : styles.messageBad} role="status">
          {message.text}
        </p>
      )}

      <SettingsSection
        title="Всплывающие окна о новых письмах"
        description="Разрешение у браузера спрашивается только сейчас, когда вы включаете уведомления, — не при открытии почты."
      >
        <Switch
          label="Показывать уведомления о новых письмах"
          description="Окно операционной системы, когда вкладка почты свёрнута или закрыта."
          checked={enabled}
          disabled={busy || capabilities.support === 'unsupported' || capabilities.support === 'insecure'}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
      </SettingsSection>

      {enabled && (
        <>
          <SettingsSection
            title="Что показывать в уведомлении"
            description="Уведомление видит всякий, кто в этот момент смотрит на экран, — в том числе когда почта закрыта."
          >
            <div className={styles.levels} role="radiogroup" aria-label="Подробность уведомления">
              {NOTIFICATION_LEVELS.map((key) => {
                const info = LEVEL_INFO[key];
                const disabled = key === 'ai-summary' && aiBlocked;
                return (
                  <label
                    key={key}
                    className={disabled ? styles.levelDisabled : styles.level}
                    data-checked={prefs.level === key ? 'true' : undefined}
                  >
                    <input
                      type="radio"
                      name="notification-level"
                      className={styles.levelInput}
                      checked={prefs.level === key}
                      disabled={disabled}
                      onChange={() => chooseLevel(key)}
                    />
                    <span className={styles.levelBody}>
                      <span className={styles.levelTitle}>{info.title}</span>
                      {/*
                        Пример важнее описания: «первые фразы» звучит одинаково
                        безобидно для всех, а увиденное окно сразу отвечает на
                        настоящий вопрос — что из этого прочтёт случайный взгляд.
                      */}
                      <span className={styles.preview} aria-label="Так будет выглядеть уведомление">
                        <img className={styles.previewIcon} src="/brand/notification-icon.png" alt="" />
                        <span className={styles.previewText}>
                          <span className={styles.previewTitle}>{info.example.title}</span>
                          {info.example.body.split('\n').map((line) => (
                            <span key={line} className={styles.previewLine}>
                              {line}
                            </span>
                          ))}
                        </span>
                      </span>
                      {info.caveat && <span className={styles.levelCaveat}>{info.caveat}</span>}
                      {disabled && (
                        /*
                          Пункт не прячется, а объясняется. Спрятанный выбор
                          выглядит как отсутствие возможности; человек должен
                          понимать, что мешает, — иначе он не сможет это
                          исправить и не поймёт, к кому обращаться.
                        */
                        <span className={styles.levelBlocked}>
                          Недоступно: {state.data.ai.reason ?? 'помощник на основе ИИ выключен'}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </SettingsSection>

          <SettingsSection
            title="Когда вкладка почты закрыта"
            description="Чтобы разбудить браузер с закрытой вкладкой, нужна служба доставки самого браузера: Google для Chrome, Mozilla для Firefox, Apple для Safari."
          >
            <Switch
              label="Присылать уведомления при закрытой вкладке"
              description="Через службу доставки браузера. Ей становятся видны время и частота писем — но не их содержимое."
              checked={prefs.push}
              disabled={busy || !state.data.pushAvailable || !capabilities.pushSupported}
              onChange={(e) => void togglePush(e.target.checked)}
            />

            {prefs.push && (
              <>
                {/*
                  Главное решение всего раздела — и оно принимается здесь,
                  осознанно, с честным объяснением обеих сторон.
                */}
                <Switch
                  label="Класть содержимое письма в само push-сообщение"
                  description="По умолчанию выключено: наружу уходит только «есть новости», а тему и текст почта забирает с вашего сервера в момент показа."
                  checked={prefs.pushPayload}
                  onChange={(e) => savePrefs.mutate({ pushPayload: e.target.checked })}
                />
                <SettingsHint>
                  Содержимое push-сообщения зашифровано, и служба доставки прочитать его не может.
                  Но шифротекст остаётся у неё, а показанное будет снимком прошлого: письмо
                  могли уже прочитать с другого устройства. Включать это стоит в одном случае —
                  когда ваш почтовый сервер недоступен с устройства в момент показа (телефон вне
                  сети предприятия): без содержимого в сообщении уведомление останется
                  безымянным «Новое письмо».
                </SettingsHint>

                <div className={styles.devices}>
                  <p className={styles.devicesTitle}>Где включены уведомления</p>
                  {state.data.devices.length === 0 ? (
                    <p className={styles.devicesEmpty}>Пока нигде.</p>
                  ) : (
                    <ul className={styles.deviceList}>
                      {state.data.devices.map((device) => (
                        <li key={device.id} className={styles.device}>
                          <span>{device.browser}</span>
                          {device.current && <span className={styles.deviceCurrent}>этот браузер</span>}
                          {device.lastError && (
                            <span className={styles.deviceError}>не доставлено: {device.lastError}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Button mode="secondary" onClick={() => void sendTest()} disabled={busy}>
                  Отправить проверочное уведомление
                </Button>
              </>
            )}
          </SettingsSection>

          <SettingsSection
            title="О чём не уведомлять"
            description="Спам, письма из других папок и ваши собственные отправленные не уведомляют никогда — об этом настройки нет, потому что другого разумного поведения тут не бывает."
          >
            <Switch
              label="Молчать о письмах, которые фильтр пометил прочитанными"
              description="Фильтр с действием «пометить прочитанным» — это уже решение, что письмо не срочное."
              checked={prefs.skipFiltered}
              onChange={(e) => savePrefs.mutate({ skipFiltered: e.target.checked })}
            />
          </SettingsSection>

          <SettingsSection
            title="Тихие часы"
            description="В эти часы уведомления не показываются и не отправляются. Письма приходят как обычно — их видно по счётчику непрочитанных."
          >
            <Switch
              label="Не беспокоить в заданные часы"
              checked={prefs.quietHours.enabled}
              onChange={(e) => savePrefs.mutate({ quietEnabled: e.target.checked })}
            />
            {prefs.quietHours.enabled && (
              <>
                <div className={styles.quietRow}>
                  <label className={styles.quietField}>
                    <span>с</span>
                    <input
                      type="time"
                      value={minutesToTime(prefs.quietHours.fromMinutes)}
                      onChange={(e) =>
                        savePrefs.mutate({
                          quietFrom: timeToMinutes(e.target.value, prefs.quietHours.fromMinutes),
                        })
                      }
                    />
                  </label>
                  <label className={styles.quietField}>
                    <span>до</span>
                    <input
                      type="time"
                      value={minutesToTime(prefs.quietHours.toMinutes)}
                      onChange={(e) =>
                        savePrefs.mutate({
                          quietTo: timeToMinutes(e.target.value, prefs.quietHours.toMinutes),
                        })
                      }
                    />
                  </label>
                </div>
                <SettingsHint>
                  {prefs.timeZone
                    ? `Время местное, по поясу ${prefs.timeZone}.`
                    : /*
                        Пояс неизвестен — говорим прямо. Молча промолчать
                        не в те часы хуже, чем лишний раз пикнуть: письмо,
                        о котором не сообщили, и есть то, ради чего
                        уведомления включали.
                      */
                      'Часовой пояс браузера определить не удалось, поэтому тихие часы пока не действуют. Откройте почту ещё раз — пояс определится сам.'}
                  {' '}
                  Накопившиеся за это время уведомления потом не всплывают все разом: пятьдесят
                  окон в восемь утра — не то, ради чего заводят тихие часы.
                </SettingsHint>
              </>
            )}
          </SettingsSection>
        </>
      )}
    </>
  );
}
