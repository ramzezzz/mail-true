/**
 * «Почта с других ящиков» (эталонные снимки интерфейса): список уже
 * подключённых ящиков и мастер добавления нового.
 *
 * Мастер идёт тем же порядком, что в привычных почтовых интерфейсах: кнопка известной службы или
 * адрес ящика → пароль → настройки сервера (для известных подставлены) →
 * папка-приёмник.
 */

import { useState } from 'react';
import type { Folder } from '@mail-true/shared';
import {
  useAddCollector,
  useCollectors,
  useDeleteCollector,
  useSyncCollector,
  useUpdateCollector,
} from '../../api/settingsQueries';
import { useFolders } from '../../api/queries';
import type { CollectorAccount, CollectorDraft, CollectorProtocol } from '../../api/settingsTypes';
import {
  Button,
  Checkbox,
  IconButton,
  Modal,
  SelectField,
  Switch,
  TextField,
} from '../../components';
import { ConfirmDialog } from '../../settings/ConfirmDialog';
import { cx } from '../../lib/cx';
import { folderTitle } from '../../lib/folderNames';
import { formatMessageDate } from '../../lib/listDates';
import { IconPlus, IconTrash } from '../../mail/icons';
import {
  COLLECTOR_PROVIDERS,
  defaultPort,
  providerForEmail,
  type CollectorProvider,
} from '../../settings/collectorProviders';
import {
  SettingsEmpty,
  SettingsError,
  SettingsLead,
  SettingsRow,
  SettingsSkeleton,
  SettingsTitle,
} from '../../settings/ui';
import styles from './CollectorPage.module.css';

export function CollectorPage() {
  const { data: collectors, isPending, isError } = useCollectors();
  const { data: folders } = useFolders();
  const add = useAddCollector();
  const update = useUpdateCollector();
  const remove = useDeleteCollector();
  const sync = useSyncCollector();

  const [wizard, setWizard] = useState<CollectorProvider | null>(null);
  /**
   * Подключение, которое собрались удалить.
   *
   * Раньше корзина удаляла сразу, а стоит она вплотную к кнопке
   * «Проверить». Пропадают при этом адрес сервера, порт, логин и пароль —
   * то, что человек вводил тремя шагами мастера, и часто это отдельный
   * «пароль приложения», который надо идти выпускать заново. Отмены нет.
   */
  const [removing, setRemoving] = useState<CollectorAccount | null>(null);

  return (
    <>
      <SettingsTitle>Почта с других ящиков</SettingsTitle>
      <SettingsLead>
        Собирайте письма из всех своих ящиков в один. Подойдёт любой сервер, работающий по протоколу
        IMAP или POP3.
      </SettingsLead>

      <SettingsRow className={styles.providers}>
        {COLLECTOR_PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className={cx(styles.provider, provider.id === 'other' && styles.providerOther)}
            onClick={() => setWizard(provider)}
          >
            {provider.id !== 'other' && (
              <span className={styles.providerMark} aria-hidden="true">
                {provider.title[0]}
              </span>
            )}
            {provider.title}
          </button>
        ))}
      </SettingsRow>

      <SettingsRow className={styles.addRow}>
        <Button
          before={<IconPlus />}
          onClick={() => setWizard(COLLECTOR_PROVIDERS[COLLECTOR_PROVIDERS.length - 1]!)}
        >
          Добавить ящик
        </Button>
      </SettingsRow>

      {isPending && <SettingsSkeleton rows={3} />}
      {isError && <SettingsError>Не удалось загрузить список ящиков.</SettingsError>}

      {collectors?.length === 0 && <SettingsEmpty>Подключённых ящиков пока нет.</SettingsEmpty>}

      <div className={styles.list}>
        {collectors?.map((collector) => {
          const target = folders?.find((f) => f.id === collector.targetFolderId);
          return (
            <div key={collector.id} className={styles.item}>
              <Switch
                aria-label={collector.enabled ? 'Выключить сбор' : 'Включить сбор'}
                checked={collector.enabled}
                onChange={(e) =>
                  update.mutate({ id: collector.id, patch: { enabled: e.target.checked } })
                }
              />

              <div className={styles.itemInfo}>
                <div className={styles.itemEmail}>{collector.email}</div>
                <div className={styles.itemMeta}>
                  {collector.protocol.toUpperCase()} · {collector.host}:{collector.port} · в папку «
                  {target ? folderTitle(target) : collector.targetFolderId}»
                </div>
                <div
                  className={cx(
                    styles.status,
                    collector.status === 'error' && styles.statusError,
                    collector.status === 'syncing' && styles.statusSyncing,
                  )}
                >
                  {collector.status === 'error' && (collector.error ?? 'Ошибка сбора')}
                  {collector.status === 'syncing' && 'Идёт первая синхронизация…'}
                  {collector.status === 'ok' &&
                    (collector.lastSyncAt
                      ? `Обновлено: ${formatMessageDate(collector.lastSyncAt)}`
                      : 'Ещё не синхронизировался')}
                </div>
              </div>

              <div className={styles.itemActions}>
                <Button
                  mode="secondary"
                  disabled={sync.isPending}
                  onClick={() => sync.mutate(collector.id)}
                >
                  Проверить
                </Button>
                <IconButton
                  label="Удалить ящик"
                  disabled={remove.isPending}
                  onClick={() => {
                    // Отказ прошлого удаления не должен висеть в новом окне.
                    remove.reset();
                    setRemoving(collector);
                  }}
                >
                  <IconTrash />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>

      {removing && (
        <ConfirmDialog
          title="Удалить подключение?"
          text={`Сбор писем с «${removing.email}» прекратится, а настройки подключения — сервер, порт, логин и пароль — будут удалены. Уже собранные письма останутся в ящике. Чтобы подключить ящик заново, все данные придётся ввести снова.`}
          confirmText="Удалить"
          busy={remove.isPending}
          error={remove.isError ? 'Не удалось удалить подключение. Попробуйте ещё раз.' : null}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            remove.mutate(removing.id, { onSuccess: () => setRemoving(null) });
          }}
        />
      )}

      {wizard && (
        <CollectorWizard
          provider={wizard}
          folders={folders ?? []}
          saving={add.isPending}
          error={add.isError ? add.error.message : null}
          onClose={() => setWizard(null)}
          onSubmit={(draft) => add.mutate(draft, { onSuccess: () => setWizard(null) })}
        />
      )}
    </>
  );
}

/* --- Мастер добавления ------------------------------------------------- */

interface WizardProps {
  provider: CollectorProvider;
  folders: readonly Folder[];
  saving: boolean;
  error: string | null;
  onClose(): void;
  onSubmit(draft: CollectorDraft): void;
}

type Step = 'account' | 'server' | 'target';

function CollectorWizard({ provider, folders, saving, error, onClose, onSubmit }: WizardProps) {
  const [step, setStep] = useState<Step>('account');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [detected, setDetected] = useState<CollectorProvider>(provider);
  const [protocol, setProtocol] = useState<CollectorProtocol>(provider.protocol);
  const [host, setHost] = useState(provider.host);
  const [port, setPort] = useState(provider.port);
  const [secure, setSecure] = useState(provider.secure);
  const [login, setLogin] = useState('');
  const [targetFolderId, setTargetFolderId] = useState('inbox');
  /*
   * Двух переключателей здесь БОЛЬШЕ НЕТ, и это решение.
   *
   * «Оставлять письма на сервере-источнике» и «Применять к собранным
   * письмам правила фильтрации» сохранялись и показывались как настоящие
   * настройки, а не делали ничего: письма на источнике не удаляются ни
   * при каком значении, а собранные письма кладутся IMAP-командой
   * APPEND, при которой правила Sieve не срабатывают вовсе — они
   * работают на доставке.
   *
   * Человек снимал первую галку, чтобы освободить место в старом ящике,
   * и узнавал об обратном, упершись в квоту у прежнего провайдера.
   * Оставлял вторую и ждал, что письма разложатся по папкам, — они все
   * ложились в одну. Правило продукта здесь простое: кнопка появляется
   * вместе с поведением. Поведения нет — нет и кнопки; вместо неё сказано,
   * как оно есть на самом деле.
   */

  /**
   * Шаг «адрес и пароль» закончен: если служба выбрана как «Другая почта»,
   * пробуем узнать её по домену — тогда на следующем шаге сервер уже заполнен.
   */
  const finishAccount = () => {
    if (provider.id === 'other') {
      const guess = providerForEmail(email);
      setDetected(guess);
      if (guess.host) {
        setProtocol(guess.protocol);
        setHost(guess.host);
        setPort(guess.port);
        setSecure(guess.secure);
      }
    }
    setStep('server');
  };

  const changeProtocol = (next: CollectorProtocol) => {
    setProtocol(next);
    setPort(defaultPort(next, secure));
  };

  const changeSecure = (next: boolean) => {
    setSecure(next);
    setPort(defaultPort(protocol, next));
  };

  const submit = () =>
    onSubmit({
      email: email.trim(),
      password,
      protocol,
      host: host.trim(),
      port,
      secure,
      login: login.trim() || email.trim(),
      targetFolderId,
      // Значения соответствуют тому, что происходит на деле: письма на
      // источнике остаются, правила фильтрации к собранным не применяются.
      leaveOnServer: true,
      applyFilters: false,
    });

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim());

  return (
    <Modal
      title={`Добавление ящика${provider.id === 'other' ? '' : `: ${provider.title}`}`}
      onClose={onClose}
      className={styles.dialog}
      footer={
        step === 'target' ? (
          <>
            <Button disabled={saving} onClick={submit}>
              {saving ? 'Подключаем…' : 'Добавить ящик'}
            </Button>
            <Button mode="secondary" disabled={saving} onClick={() => setStep('server')}>
              Назад
            </Button>
          </>
        ) : step === 'server' ? (
          <>
            <Button disabled={host.trim().length === 0} onClick={() => setStep('target')}>
              Далее
            </Button>
            <Button mode="secondary" onClick={() => setStep('account')}>
              Назад
            </Button>
          </>
        ) : (
          <>
            <Button disabled={!emailValid || password.length === 0} onClick={finishAccount}>
              Далее
            </Button>
            <Button mode="secondary" onClick={onClose}>
              Отменить
            </Button>
          </>
        )
      }
    >
      <ol className={styles.steps}>
        <li className={cx(styles.step, step === 'account' && styles.stepCurrent)}>Ящик</li>
        <li className={cx(styles.step, step === 'server' && styles.stepCurrent)}>Сервер</li>
        <li className={cx(styles.step, step === 'target' && styles.stepCurrent)}>Куда собирать</li>
      </ol>

      {step === 'account' && (
        <>
          <TextField
            label="Адрес ящика"
            type="email"
            autoFocus
            placeholder="адрес@почта"
            value={email}
            error={email.length > 0 && !emailValid ? 'Проверьте адрес' : null}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Пароль"
            type="password"
            value={password}
            hint={detected.appPasswordHint}
            onChange={(e) => setPassword(e.target.value)}
          />
        </>
      )}

      {step === 'server' && (
        <>
          <SelectField
            label="Протокол"
            value={protocol}
            onChange={(e) => changeProtocol(e.target.value as CollectorProtocol)}
          >
            <option value="imap">IMAP — папки остаются как есть</option>
            <option value="pop3">POP3 — письма забираются во «Входящие»</option>
          </SelectField>
          <SettingsRow>
            <TextField
              label="Сервер"
              wrapperClassName={styles.hostField}
              value={host}
              placeholder="imap.почта"
              onChange={(e) => setHost(e.target.value)}
            />
            <TextField
              label="Порт"
              type="number"
              wrapperClassName={styles.portField}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 0)}
            />
          </SettingsRow>
          <Checkbox
            label="Шифрованное соединение (SSL/TLS)"
            checked={secure}
            onChange={(e) => changeSecure(e.target.checked)}
          />
          <TextField
            label="Логин"
            value={login}
            placeholder={email || 'совпадает с адресом'}
            hint="Заполните, только если логин отличается от адреса ящика"
            onChange={(e) => setLogin(e.target.value)}
          />
        </>
      )}

      {step === 'target' && (
        <>
          <SelectField
            label="Складывать письма в папку"
            value={targetFolderId}
            onChange={(e) => setTargetFolderId(e.target.value)}
          >
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderTitle(f)}
              </option>
            ))}
          </SelectField>
          <p className={styles.hint}>
            Письма остаются на сервере-источнике — сбор их не удаляет. Все собранные письма попадают
            в выбранную папку: правила фильтрации к ним не применяются, потому что срабатывают они
            только на доставке.
          </p>
        </>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
