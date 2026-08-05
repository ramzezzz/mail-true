/**
 * Раздел настроек помощника на основе ИИ — он же экран согласия.
 *
 * Здесь говорится конкретными словами и без юридического тумана:
 * какой сервис получит данные и по какому адресу, что именно уходит
 * при каждой возможности, что не уходит никогда, что ответы сохраняются
 * у нас, и как всё это отключить и удалить.
 *
 * Раздела не существует, пока помощник не разрешён администратором:
 * при `enabled: false` страница не рисует ничего.
 *
 * Показ отделён от загрузки данных: {@link AiSettingsView} — чистый
 * компонент, его можно проверить тестом без сети и без QueryClient.
 */

import { useEffect, useState } from 'react';
import { useAiConsent, useAiFeatures, useAiRevokeConsent, useAiState } from '../api/aiQueries';
import type { AiBudget, AiFeatureKey, AiProviderInfo, AiState } from '../api/aiTypes';
import { aiErrorText } from '../ai/aiVisibility';
import { Button, Checkbox, Spinner } from '../components';
import { IconShield } from '../mail/icons';
import styles from './AiSettingsPage.module.css';

/* ------------------------------------------------------------------ */
/* Страница: данные                                                     */
/* ------------------------------------------------------------------ */

export function AiSettingsPage() {
  const { data: state, isPending } = useAiState();
  const consent = useAiConsent();
  const revoke = useAiRevokeConsent();
  const features = useAiFeatures();

  const busy = consent.isPending || revoke.isPending || features.isPending;
  const error = consent.error ?? revoke.error ?? features.error;

  if (isPending) {
    return (
      <div className={styles.centered}>
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <AiSettingsView
      state={state}
      busy={busy}
      removedCacheEntries={revoke.data?.removedCacheEntries ?? null}
      error={error ? aiErrorText(error) : null}
      onAccept={(keys) => consent.mutate(keys)}
      onRevoke={() => revoke.mutate()}
      onSaveFeatures={(keys) => features.mutate(keys)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Показ                                                                */
/* ------------------------------------------------------------------ */

export interface AiSettingsViewProps {
  /** undefined — состояние ещё не загружено. */
  state: AiState | undefined;
  busy: boolean;
  /** Сколько резюме и меток удалено при отзыве согласия; null — отзыва не было. */
  removedCacheEntries: number | null;
  error: string | null;
  onAccept(features: AiFeatureKey[]): void;
  onRevoke(): void;
  onSaveFeatures(features: AiFeatureKey[]): void;
}

export function AiSettingsView({
  state,
  busy,
  removedCacheEntries,
  error,
  onAccept,
  onRevoke,
  onSaveFeatures,
}: AiSettingsViewProps) {
  /** Отмеченные возможности. До согласия — черновик, после — то, что сохранено. */
  const [selected, setSelected] = useState<AiFeatureKey[]>(() => enabledKeys(state));

  // Сервер — источник истины: после согласия, отзыва или сохранения
  // список приходит обратно, и местный черновик ему уступает.
  useEffect(() => {
    setSelected(enabledKeys(state));
  }, [state]);

  // Помощник запрещён администратором (или состояние ещё не пришло) —
  // раздела не существует.
  if (!state?.enabled) return null;

  const consentGiven = state.consent.given && state.consent.matchesProvider;
  const allowed = state.features.filter((f) => f.allowed);

  const toggle = (key: AiFeatureKey, on: boolean) => {
    const next = on ? [...new Set([...selected, key])] : selected.filter((k) => k !== key);
    setSelected(next);
    // Согласие уже дано — изменение сохраняется сразу; до согласия это
    // всего лишь черновик, который уйдёт вместе с согласием.
    if (consentGiven) onSaveFeatures(next);
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <h1 className={styles.title}>Помощник на основе ИИ</h1>
        <p className={styles.lead}>
          Помощник умеет пересказывать письма, подсказывать ответы, вытаскивать даты
          и суммы и переводить текст. Чтобы это делать, он отправляет содержимое письма
          сервису, указанному ниже. Пока вы не согласитесь, наружу не уходит ничего.
        </p>

        {error && <div className={styles.error}>{error}</div>}

        {/* --- Кто получит данные --- */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Кто получит данные</h2>
          <ProviderBlock provider={state.provider} />
        </section>

        {/* --- Согласие --- */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Согласие</h2>

          {state.consent.given && !state.consent.matchesProvider && (
            <div className={styles.warning}>
              Администратор сменил сервис. Раньше вы соглашались отправлять письма
              на {state.consent.consentedEndpoint ?? 'другой адрес'}
              {state.consent.consentedModel ? `, модель ${state.consent.consentedModel}` : ''}.
              Согласие нужно дать заново — уже на новый сервис.
            </div>
          )}

          {consentGiven ? (
            <>
              <p className={styles.text}>
                Согласие дано{state.consent.at ? ` ${formatDate(state.consent.at)}` : ''}.
                Помощник работает.
              </p>
              <p className={`${styles.text} ${styles.muted}`}>
                Отзыв согласия выключает помощника и удаляет всё, что он успел
                насчитать: резюме, метки, извлечённые данные и переводы. Не помечает
                удалёнными — удаляет.
              </p>
              <div className={styles.actions}>
                <Button mode="outline" onClick={onRevoke} disabled={busy}>
                  Отозвать согласие и удалить созданное
                </Button>
                {removedCacheEntries !== null && (
                  <span className={styles.muted}>
                    Удалено записей: {removedCacheEntries}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <p className={styles.text}>
                Отметьте возможности, которые хотите включить, и нажмите «Включить
                помощника». Каждую можно выключить потом по отдельности.
              </p>
              <div className={styles.actions}>
                <Button mode="primary" onClick={() => onAccept(selected)} disabled={busy}>
                  Включить помощника
                </Button>
                {removedCacheEntries !== null && (
                  <span className={styles.muted}>Удалено записей: {removedCacheEntries}</span>
                )}
              </div>
            </>
          )}
        </section>

        {/* --- Возможности --- */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Возможности и что при них уходит</h2>
          <div className={styles.features}>
            {allowed.map((feature) => (
              <div key={feature.key} className={styles.feature}>
                <div className={styles.featureHead}>
                  <Checkbox
                    checked={selected.includes(feature.key)}
                    disabled={busy}
                    onChange={(e) => toggle(feature.key, e.target.checked)}
                    aria-label={feature.title}
                  />
                  <span className={styles.featureTitle}>{feature.title}</span>
                </div>
                <p className={styles.featureText}>{feature.description}</p>
                <p className={styles.featureSends}>
                  <span className={styles.featureSendsLabel}>Отправляется: </span>
                  {feature.sends}
                </p>
              </div>
            ))}
            {allowed.length === 0 && (
              <p className={styles.text}>
                Администратор не разрешил ни одной возможности.
              </p>
            )}
          </div>
        </section>

        {/* --- Что не уходит никогда --- */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Что не отправляется никогда</h2>
          <ul className={styles.list}>
            {state.neverSent.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {/* Обещания сверху проверяемы: точный состав виден у каждого ответа */}
          <p className={`${styles.text} ${styles.muted} ${styles.spacedNote}`}>
            Это обещания. Точный состав отправленного показывается рядом с каждым
            ответом помощника — там же, где сам ответ, под ссылкой «Что ушло наружу».
          </p>
        </section>

        {/* --- Хранение ответов --- */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Что хранится у нас</h2>
          <p className={styles.text}>
            Ответы сервиса сохраняются на нашем сервере и привязываются к письму.
            Второй раз за то же резюме или ту же метку мы не платим и наружу
            повторно ничего не отправляем: ответ берётся из сохранённого.
          </p>
          <p className={`${styles.text} ${styles.muted}`}>
            Отдельное письмо можно «забыть» — тогда всё, что помощник по нему
            насчитал, удаляется, а при следующем нажатии считается заново.
            Отзыв согласия удаляет сохранённое целиком.
          </p>
        </section>

        {/* --- Расход --- */}
        {state.budget && (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Расход</h2>
            <BudgetBlock budget={state.budget} />
          </section>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProviderBlock({ provider }: { provider: AiProviderInfo | null }) {
  if (!provider) {
    return <p className={styles.text}>Сервис ещё не настроен администратором.</p>;
  }
  return (
    <>
      {provider.local ? (
        <div className={styles.local}>
          <span className={styles.localIcon}>
            <IconShield size={20} />
          </span>
          <span>
            <span className={styles.localTitle}>
              Модель поднята на этом же сервере — письма не покидают периметр.
            </span>{' '}
            Запросы идут во внутреннюю сеть, наружу в интернет не выходит ничего.
          </span>
        </div>
      ) : (
        <div className={styles.remote}>
          Это внешний сервис. Содержимое письма уйдёт за пределы вашего сервера —
          на адрес, указанный ниже. Если так нельзя, попросите администратора
          поднять модель рядом с почтой.
        </div>
      )}
      <div className={styles.rows}>
        <span className={styles.rowKey}>Сервис</span>
        <span className={styles.rowValue}>{provider.label}</span>
        <span className={styles.rowKey}>Адрес</span>
        <span className={styles.rowValue}>{provider.endpoint}</span>
        <span className={styles.rowKey}>Модель</span>
        <span className={styles.rowValue}>{provider.model}</span>
      </div>
    </>
  );
}

function BudgetBlock({ budget }: { budget: AiBudget }) {
  return (
    <>
      <div className={styles.budget}>
        <div className={styles.budgetItem}>
          <div className={styles.budgetValue}>{budget.tokensUsed.toLocaleString('ru-RU')}</div>
          <div className={styles.budgetLabel}>
            токенов израсходовано
            {budget.tokensLimit !== null
              ? ` из ${budget.tokensLimit.toLocaleString('ru-RU')}`
              : ' (предел не задан)'}
          </div>
        </div>
        <div className={styles.budgetItem}>
          <div className={styles.budgetValue}>{budget.requestsUsed.toLocaleString('ru-RU')}</div>
          <div className={styles.budgetLabel}>
            обращений
            {budget.requestsLimit !== null
              ? ` из ${budget.requestsLimit.toLocaleString('ru-RU')}`
              : ' (предел не задан)'}
          </div>
        </div>
      </div>
      <p className={`${styles.text} ${styles.muted} ${styles.spacedNote}`}>
        Период учёта — {formatPeriod(budget.periodMs)}, отсчёт с{' '}
        {formatDate(new Date(budget.windowStartedAt).toISOString())}.
        {budget.tokensLeft !== null ? ` Осталось токенов: ${budget.tokensLeft.toLocaleString('ru-RU')}.` : ''}
        {budget.requestsLeft !== null ? ` Осталось обращений: ${budget.requestsLeft.toLocaleString('ru-RU')}.` : ''}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

function enabledKeys(state: AiState | undefined): AiFeatureKey[] {
  return (state?.features ?? []).filter((f) => f.allowed && f.enabled).map((f) => f.key);
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPeriod(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? 'сутки' : `${days} сут.`;
  }
  return `${hours} ч`;
}
