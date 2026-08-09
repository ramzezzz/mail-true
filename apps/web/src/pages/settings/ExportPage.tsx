/**
 * Настройки → «Выгрузка ящика»: забрать всю свою почту одним архивом.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЗДЕСЬ ПОЛОСКА, А НЕ КНОПКА «СКАЧАТЬ»
 * ------------------------------------------------------------------
 * Ящик бывает на гигабайты, и обход по IMAP со сжатием идёт минутами, а
 * то и часами. «Нажал и жди» на таком объёме — это оборванное соединение
 * и ноль объяснений. Поэтому кнопка ставит задание, страница показывает
 * ход работы числами (сколько писем из скольких, сколько уже весит), а
 * готовый архив скачивается отдельно и переживает закрытую вкладку.
 *
 * Числа, а не только полоска, — намеренно: полоска на 40% ничего не
 * говорит человеку, у которого 60 тысяч писем, а «24 130 из 60 412»
 * говорит всё, включая то, что процесс жив.
 */

import { useState } from 'react';
import { Button, Checkbox, Spinner } from '../../components';
import { actionErrorText } from '../../lib/errorText';
import { cx } from '../../lib/cx';
import {
  formatBytes,
  formatLeft,
  formatMoment,
  isExportLive,
  ownerApi,
  plural,
  type ExportJob,
} from '../../settings/ownerApi';
import {
  useCancelExport,
  useDeleteExport,
  useExports,
  useStartExport,
} from '../../settings/ownerQueries';
import {
  SettingsEmpty,
  SettingsError,
  SettingsHint,
  SettingsLead,
  SettingsRow,
  SettingsTitle,
} from '../../settings/ui';
import styles from './ExportPage.module.css';

const STATE_TITLES: Record<ExportJob['state'], string> = {
  queued: 'В очереди',
  running: 'Идёт выгрузка',
  ready: 'Готово',
  failed: 'Не получилось',
  cancelled: 'Отменено',
  expired: 'Срок хранения вышел',
};

export function ExportPage() {
  const { available, reason, jobs, ttlHours, loading } = useExports();
  const start = useStartExport();
  const cancel = useCancelExport();
  const remove = useDeleteExport();
  const [includeSpam, setIncludeSpam] = useState(false);
  const [includeTrash, setIncludeTrash] = useState(false);

  const live = jobs.find(isExportLive);
  const error = start.error ?? cancel.error ?? remove.error;

  return (
    <>
      <SettingsTitle>Выгрузка ящика</SettingsTitle>
      <SettingsLead>
        Соберём всю вашу почту в один ZIP-архив: папка ящика — каталог, письмо — файл .eml. Такой
        файл открывается двойным щелчком в любой почтовой программе, а сам архив — в проводнике без
        единой установленной программы.
      </SettingsLead>

      {!available && (
        <SettingsError>
          {reason ?? 'Выгрузка сейчас недоступна — сервер не отдал состояние.'}
        </SettingsError>
      )}

      {available && loading && (
        <div className={styles.loading}>
          <Spinner size={22} />
        </div>
      )}

      {available && !loading && (
        <>
          {error && <SettingsError>{actionErrorText('Не получилось', error)}</SettingsError>}

          {!live && (
            <div className={styles.order}>
              <label className={styles.option}>
                <Checkbox
                  checked={includeSpam}
                  onChange={(event) => setIncludeSpam(event.target.checked)}
                />
                <span>
                  Включить «Спам»
                  <span className={styles.optionNote}>
                    Обычно это половина объёма ящика и ничего нужного
                  </span>
                </span>
              </label>
              <label className={styles.option}>
                <Checkbox
                  checked={includeTrash}
                  onChange={(event) => setIncludeTrash(event.target.checked)}
                />
                <span>
                  Включить «Корзину»
                  <span className={styles.optionNote}>
                    То, что вы уже решили выбросить, но ещё не очистили
                  </span>
                </span>
              </label>
              <SettingsRow>
                <Button
                  onClick={() => start.mutate({ includeSpam, includeTrash })}
                  disabled={start.isPending}
                >
                  {start.isPending ? 'Ставим в очередь…' : 'Выгрузить ящик'}
                </Button>
              </SettingsRow>
            </div>
          )}

          {jobs.length === 0 && <SettingsEmpty>Выгрузок пока не было.</SettingsEmpty>}

          {jobs.length > 0 && (
            <div className={styles.jobs}>
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onCancel={() => cancel.mutate(job.id)}
                  cancelling={cancel.isPending}
                  onDelete={() => remove.mutate(job.id)}
                  deleting={remove.isPending}
                />
              ))}
            </div>
          )}

          <SettingsHint>
            Готовый архив хранится {ttlHours} {plural(ttlHours, 'час', 'часа', 'часов')}, потом
            удаляется с сервера: это копия всей вашей переписки в открытом виде, и лежать на диске
            вечно она не должна. Одновременно идёт одна выгрузка на весь сервер — так она не мешает
            почте остальных. Пометки «прочитано», флажки и метки в архив не попадают: файл .eml их
            не хранит, это свойства письма в ящике, а не самого письма.
          </SettingsHint>
        </>
      )}
    </>
  );
}

function JobCard({
  job,
  onCancel,
  cancelling,
  onDelete,
  deleting,
}: {
  job: ExportJob;
  onCancel: () => void;
  cancelling: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const live = isExportLive(job);
  /*
   * Пока общее число писем не сосчитано, доли не существует — и рисовать
   * полоску на нуле нельзя: она читается как «ничего не происходит».
   * Честнее сказать словами, что идёт подсчёт.
   */
  const counted = job.totalMessages > 0;
  const percent = counted
    ? Math.min(100, Math.round((job.doneMessages / job.totalMessages) * 100))
    : 0;

  return (
    <section className={styles.job}>
      <header className={styles.jobHead}>
        <span className={cx(styles.state, styles[`state_${job.state}`])}>
          {STATE_TITLES[job.state]}
        </span>
        <span className={styles.jobDate}>{formatMoment(job.createdAt)}</span>
      </header>

      {live && (
        <>
          <div className={styles.bar} role="progressbar" aria-valuenow={percent}>
            <div
              className={cx(styles.barFill, !counted && styles.barIndeterminate)}
              style={{ width: counted ? `${percent}%` : '100%' }}
            />
          </div>
          <p className={styles.jobLine}>
            {job.state === 'queued'
              ? 'Ждёт своей очереди — сервер выгружает по одному ящику за раз'
              : counted
                ? `${job.doneMessages.toLocaleString('ru-RU')} из ${job.totalMessages.toLocaleString('ru-RU')} писем · ${formatBytes(job.doneBytes)}`
                : 'Считаем письма в папках…'}
          </p>
          <SettingsRow>
            <Button mode="secondary" onClick={onCancel} disabled={cancelling}>
              Отменить
            </Button>
          </SettingsRow>
        </>
      )}

      {job.state === 'ready' && (
        <>
          {/*
            Готовый архив с оговоркой — это по-прежнему готовый архив, но
            молчать о том, чего в нём нет, нельзя: полоска дошла до конца,
            написано «Готово», и человек уверен, что забрал всю почту.
            Сюда сервер кладёт две вещи, которые он раньше проглатывал:
            папки, которые не удалось прочитать, и остановку на потолке
            размера (тогда в архиве только часть ящика — но она сохранена
            и её можно скачать, а не выброшена, как было).
          */}
          {job.error && <p className={styles.jobWarning}>{job.error}</p>}
          <p className={styles.jobLine}>
            {job.doneMessages.toLocaleString('ru-RU')}{' '}
            {plural(job.doneMessages, 'письмо', 'письма', 'писем')} · архив{' '}
            {formatBytes(job.fileBytes)}
            {job.skipped > 0 && (
              <span className={styles.skipped}> · не удалось прочитать: {job.skipped}</span>
            )}
          </p>
          <SettingsRow>
            {/*
              Обычная ссылка, а не запрос из кода: файл бывает на гигабайты,
              и браузер качает такое сам, показывая свой ход загрузки.
              Скачивание через fetch держало бы весь архив в памяти вкладки.
            */}
            <a className={styles.download} href={ownerApi.exportFileUrl(job.id)} download>
              Скачать архив
            </a>
            {/*
              «Удалить» рядом со «Скачать», а не спрятано в углу.
              В архиве вся переписка ящика в открытом виде, и до этой
              кнопки убрать его с сервера было нечем: файл ждал своих
              двух суток и попадал в каждую резервную копию, снятую за
              это время. Человек, скачавший архив себе, хочет закрыть за
              собой дверь сразу, а не через двое суток.
            */}
            <Button
              mode="secondary"
              onClick={() => {
                if (window.confirm('Удалить архив с сервера? Скачать его после этого не выйдет.')) {
                  onDelete();
                }
              }}
              disabled={deleting}
            >
              Удалить архив
            </Button>
            {job.expiresAt && (
              <span className={styles.expires}>
                иначе удалится через {formatLeft(job.expiresAt)}
              </span>
            )}
          </SettingsRow>
        </>
      )}

      {job.state === 'failed' && (
        <p className={styles.jobError}>{job.error ?? 'Причина неизвестна'}</p>
      )}

      {job.state === 'expired' && (
        <p className={styles.jobLine}>
          Файл удалён с сервера. Закажите выгрузку заново — она соберётся с нуля.
        </p>
      )}
    </section>
  );
}
