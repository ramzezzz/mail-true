/**
 * Открытие сохранённого черновика на дописывание.
 *
 * Живёт отдельным хуком, потому что открывать черновик умеют два места:
 * щелчок по строке в папке «Черновики» и кнопка «Продолжить» на странице
 * письма. Собери мы это дважды — рано или поздно одно из двух открывало бы
 * черновик иначе (без вложений, без «Скрытой», с новым UID), и человек
 * получил бы разное поведение от двух жестов с одинаковым смыслом.
 */

import { useCallback, useState } from 'react';
import { api } from '../api';
import { useUiStore } from '../app/store';
import { draftInit } from '../lib/composeFromMessage';
import { actionErrorText } from '../lib/errorText';

export interface OpenDraft {
  /** Открыть окно написания с содержимым черновика по его UID. */
  openDraft(draftUid: number): void;
  /** Черновик уже запрашивается — кнопке пора показать это. */
  loading: boolean;
}

export function useOpenDraft(): OpenDraft {
  const openCompose = useUiStore((s) => s.openCompose);
  const showNotice = useUiStore((s) => s.showNotice);
  const [loading, setLoading] = useState(false);

  const openDraft = useCallback(
    (draftUid: number) => {
      setLoading(true);
      api
        .getDraft(draftUid)
        .then((content) => {
          openCompose(draftInit(content));
        })
        .catch((err: unknown) => {
          // Молчаливое «ничего не произошло» здесь недопустимо: человек
          // нажал на своё письмо и обязан узнать, почему оно не открылось.
          showNotice(actionErrorText('Не удалось открыть черновик', err));
        })
        .finally(() => setLoading(false));
    },
    [openCompose, showNotice],
  );

  return { openDraft, loading };
}
