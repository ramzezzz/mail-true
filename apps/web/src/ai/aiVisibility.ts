/**
 * Правила видимости помощника — самое важное место всего его интерфейса.
 *
 * Администратор может запретить ИИ полностью, и тогда пользователь не
 * увидит ни одной кнопки: не «увидит и получит отказ», а именно не увидит.
 * Все компоненты помощника спрашивают разрешения только здесь, чтобы
 * правило было одно на всех и его нельзя было случайно обойти.
 */

import type { AiFeatureKey, AiState } from '../api/aiTypes';

/** Адрес раздела настроек помощника (он же — экран согласия). */
export const AI_SETTINGS_PATH = '/settings/ai';

/**
 * Показывать ли вообще что-либо, связанное с помощником.
 * Состояние ещё не загружено (undefined) — не показывать: молчание
 * безопаснее догадок.
 */
export function aiVisible(state: AiState | undefined): boolean {
  return state?.enabled === true;
}

/** Согласие нужно спросить: его не давали или сменился сервис. */
export function aiNeedsConsent(state: AiState | undefined): boolean {
  if (!aiVisible(state) || !state) return false;
  return !state.consent.given || !state.consent.matchesProvider;
}

/**
 * Показывать ли кнопку конкретной возможности.
 *
 * Возможность, запрещённую администратором, не показываем никогда.
 * Возможность, выключенную самим пользователем, не показываем тоже —
 * он её выключил осознанно. Но пока согласие не дано, кнопки разрешённых
 * возможностей видны: они ведут на экран согласия, а не молча падают.
 */
export function aiFeatureVisible(state: AiState | undefined, key: AiFeatureKey): boolean {
  if (!aiVisible(state) || !state) return false;
  const feature = state.features.find((f) => f.key === key);
  if (!feature?.allowed) return false;
  if (aiNeedsConsent(state)) return true;
  return feature.enabled;
}

/** Человеческий текст ошибки помощника. */
export function aiErrorText(error: unknown): string {
  if (!(error instanceof Error)) return 'Подсказки временно недоступны';
  const code = (error as { code?: string | null }).code ?? null;
  switch (code) {
    // Сообщение о лимите показываем дословно: в нём написано,
    // сколько именно израсходовано.
    case 'AI_BUDGET_EXCEEDED':
    case 'AI_CONSENT_REQUIRED':
    case 'AI_FEATURE_OFF':
    case 'AI_DISABLED':
    case 'AI_INVALID_INPUT':
      return error.message;
    // Отказ самого сервиса пользователю ничего не объясняет.
    case 'AI_UPSTREAM':
    case 'AI_UNAVAILABLE':
      return 'Подсказки временно недоступны';
    default:
      return error.message || 'Подсказки временно недоступны';
  }
}
