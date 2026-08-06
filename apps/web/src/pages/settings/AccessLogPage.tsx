/**
 * Настройки → «Вход и действия»: кто и откуда заходил в ящик.
 *
 * Раздел отвечает ровно на один вопрос — «это был я?». Поэтому во главе
 * таблицы стоит не время, а способ и адрес: время человек и так помнит,
 * а вот строку «IMAP, интернет, 203.0.113.7, неверный пароль» он
 * не узнаёт и приходит именно за ней.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ СЛУЖЕБНЫЕ ПОДКЛЮЧЕНИЯ СВЁРНУТЫ
 * ------------------------------------------------------------------
 * Сам веб-интерфейс работает с почтой по IMAP и держит соединения всё
 * время, пока открыта вкладка. В журнале Dovecot на один вход человека
 * приходятся десятки таких строк — с адресом нашего же сервера. Скрывать
 * их совсем нельзя (они существуют, и человек вправе их увидеть), но
 * показывать вперемешку с настоящими входами значит утопить настоящие
 * в шуме. Поэтому они помечены и по умолчанию свёрнуты одним флажком.
 */

import { useMemo, useState } from 'react';
import { Checkbox, Spinner } from '../../components';
import { cx } from '../../lib/cx';
import {
  CHANNEL_TITLES,
  formatMoment,
  plural,
  type AccessEvent,
} from '../../settings/ownerApi';
import { useAccessLog } from '../../settings/ownerQueries';
import {
  SettingsEmpty,
  SettingsError,
  SettingsHint,
  SettingsLead,
  SettingsTitle,
} from '../../settings/ui';
import styles from './AccessLogPage.module.css';

export function AccessLogPage() {
  const { available, reason, items, retentionDays, loading } = useAccessLog();
  const [showService, setShowService] = useState(false);

  const serviceCount = useMemo(() => items.filter((e) => e.service).length, [items]);
  const shown = showService ? items : items.filter((e) => !e.service);
  const failures = items.filter((e) => !e.success).length;

  return (
    <>
      <SettingsTitle>Вход и действия</SettingsTitle>
      <SettingsLead>
        Здесь видно, когда и откуда входили в этот ящик — через почту в браузере, почтовую
        программу по IMAP или POP3 и при отправке писем. Если среди строк есть та, которую вы
        не узнаёте, смените пароль.
      </SettingsLead>

      {!available && (
        <SettingsError>
          {reason ?? 'История входов сейчас недоступна — сервер её не отдал.'}
        </SettingsError>
      )}

      {available && loading && (
        <div className={styles.loading}>
          <Spinner size={22} />
        </div>
      )}

      {available && !loading && (
        <>
          {failures > 0 && (
            <p className={styles.alarm} role="status">
              Неудачных попыток входа: {failures}. Это могли быть вы с опечаткой в пароле — но
              если нет, пароль пора сменить.
            </p>
          )}

          {serviceCount > 0 && (
            <label className={styles.toggle}>
              <Checkbox
                checked={showService}
                onChange={(event) => setShowService(event.target.checked)}
              />
              <span>
                Показывать служебные подключения самой почты ({serviceCount})
                <span className={styles.toggleNote}>
                  Веб-интерфейс сам читает ящик по IMAP, и каждое такое подключение попадает
                  в журнал почтового сервера. Это не чужие входы.
                </span>
              </span>
            </label>
          )}

          {shown.length === 0 && (
            <SettingsEmpty>
              Пока пусто. Записи появятся при следующем входе в ящик.
            </SettingsEmpty>
          )}

          {shown.length > 0 && (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.headCell}>Когда</th>
                  <th className={styles.headCell}>Как</th>
                  <th className={styles.headCell}>Откуда</th>
                  <th className={styles.headCell}>Что произошло</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event, index) => (
                  <Row key={`${event.at}-${index}`} event={event} />
                ))}
              </tbody>
            </table>
          )}

          <SettingsHint>
            Свои записи о входе через браузер хранятся {retentionDays}{' '}
            {plural(retentionDays, 'день', 'дня', 'дней')}. Входы по IMAP, POP3 и отправка
            читаются из журналов почтового сервера — они хранятся столько, сколько журналы, и
            уезжают при их провороте. Страну по адресу мы не определяем: для этого нужна либо
            база на сотни мегабайт, либо запрос в чужую службу — то есть выдача вашего адреса
            наружу.
          </SettingsHint>
        </>
      )}
    </>
  );
}

function Row({ event }: { event: AccessEvent }) {
  return (
    <tr className={cx(styles.row, event.service && styles.rowService)}>
      <td className={styles.timeCell}>{formatMoment(event.at)}</td>
      <td className={styles.channelCell}>
        <span className={cx(styles.badge, !event.success && styles.badgeFail)}>
          {CHANNEL_TITLES[event.channel]}
        </span>
      </td>
      <td className={styles.whereCell}>
        {event.ip ?? '—'}
        <span className={styles.whereNote}>{event.where}</span>
      </td>
      <td className={styles.detailCell}>
        {event.detail}
        {event.userAgent && <span className={styles.agent}>{event.userAgent}</span>}
      </td>
    </tr>
  );
}
