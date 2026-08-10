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

/**
 * Черновики, которые прямо сейчас открываются.
 *
 * Общий на всё приложение, а не на вызов хука: открывать черновик умеют
 * три места (строка в папке, кнопка «Продолжить» на письме, плашка «не
 * отправлено»), и у каждого свой счётчик ожидания. Список нужен один —
 * иначе они друг о друге не знают.
 */
const opening = new Set<number>();

export function useOpenDraft(): OpenDraft {
  const openCompose = useUiStore((s) => s.openCompose);
  const showNotice = useUiStore((s) => s.showNotice);
  const [loading, setLoading] = useState(false);

  const openDraft = useCallback(
    (draftUid: number) => {
      /*
       * ВТОРОЙ ЩЕЛЧОК НЕ ДОЛЖЕН ОТКРЫВАТЬ ВТОРОЕ ОКНО.
       *
       * Черновик открывается ОДИНАРНЫМ щелчком, а запрос небыстрый:
       * сервер попутно раскладывает картинки письма во временное
       * хранилище. На экране при этом не меняется ничего, и человек
       * щёлкает ещё раз.
       *
       * Получал он два окна на один черновик. Оба сохраняются сами, но
       * первое же сохранение заводит новую версию и удаляет прежнюю —
       * второе окно про это не знает и держит мёртвый номер. В папке
       * оказывались два черновика с разными половинами правок, и какой
       * из них новее, по списку не видно.
       */
      if (opening.has(draftUid)) return;
      const already = useUiStore
        .getState()
        .composeWindows.find((w) => w.draft.draftUid === draftUid);
      if (already) {
        // Окно уже есть — разворачиваем его, а не заводим второе
        if (already.minimized) useUiStore.getState().toggleComposeMinimized(already.id);
        return;
      }

      opening.add(draftUid);
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
        .finally(() => {
          opening.delete(draftUid);
          setLoading(false);
        });
    },
    [openCompose, showNotice],
  );

  return { openDraft, loading };
}
