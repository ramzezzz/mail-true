/**
 * Кнопка «применить настройку» — то есть перезапустить ту службу, которая
 * эту настройку читает.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ КОМПОНЕНТ, А НЕ КУСОК СТРАНИЦЫ НАСТРОЕК
 * ------------------------------------------------------------------
 * Перезапуск нужен не только настройкам. Он же нужен после смены
 * сертификата TLS (nginx, postfix, dovecot) и после включения антивируса.
 * Разные экраны — одно и то же действие с одними и теми же последствиями,
 * и второй набор формулировок для «что случится, если остановить
 * Dovecot» однажды разошёлся бы с первым.
 *
 * Поэтому здесь: одна кнопка, один диалог подтверждения, одно ожидание
 * возвращения сервера. Вставляется рядом с чем угодно.
 *
 * ------------------------------------------------------------------
 * ЧЕГО ЗДЕСЬ НЕТ
 * ------------------------------------------------------------------
 * Кнопки «перезапустить всё». Остановка Postfix и остановка nginx —
 * разные события для живых людей, и предлагать их одним нажатием значит
 * скрывать от человека, что именно он сейчас выключит.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api, ApiError } from '../api/client';
import type { RestartAction, RestartTarget, SettingApply } from '../api/types';
import {
  applyButtonLabel,
  applyWarning,
  RECREATE_NOTE,
  startWatch,
  watching,
  watchStep,
  WATCH_INTERVAL_MS,
  type WatchState,
} from '../lib/restart';
import { Badge, Modal, Notice } from './ui';

/** Ключ запроса общий на всю панель: список служб один. */
export const RESTART_QUERY_KEY = ['restart'] as const;

/**
 * Перечень служб и доступность посредника.
 *
 * Спрашивается один раз на всю панель (react-query сам сведёт вызовы к
 * одному запросу). Обновление вручную не нужно: доступность посредника
 * меняется не чаще, чем поднимают стек.
 */
export function useRestartState() {
  return useQuery({
    queryKey: RESTART_QUERY_KEY,
    queryFn: () => api.restartState(),
    staleTime: 30_000,
  });
}

export interface ApplyButtonProps {
  /** Шаги применения настройки — прямо из ServerSetting.applies. */
  applies: readonly SettingApply[];
  /** Есть ли право. Без него кнопка не показывается вовсе. */
  allowed: boolean;
  /** Позвать после удачного применения: обновить список настроек. */
  onApplied?: (() => void) | undefined;
  size?: 's' | 'm' | undefined;
}

/**
 * Кнопки применения: по одной на шаг.
 *
 * Именно по одной, а не «применить всё»: у настройки вроде имени
 * продукта два читателя — служба автонастройки и сервер приложения, — и
 * останавливаются они по-разному и с разной ценой. Человек должен видеть
 * оба действия и решать по каждому.
 */
export function ApplyButtons({
  applies,
  allowed,
  onApplied,
  size = 's',
}: ApplyButtonProps): JSX.Element | null {
  const { data } = useRestartState();
  if (!allowed || applies.length === 0) return null;
  return (
    <>
      {applies.map((apply) => {
        const target = data?.targets.find((t) => t.id === apply.target);
        return (
          <ServiceRestartButton
            key={`${apply.target}:${apply.action}`}
            target={target ?? null}
            targetId={apply.target}
            action={apply.action}
            size={size}
            onApplied={onApplied}
          />
        );
      })}
    </>
  );
}

export interface ServiceRestartButtonProps {
  /** Описание службы. null — список ещё не пришёл или службы в нём нет. */
  target: RestartTarget | null;
  targetId: string;
  action: RestartAction;
  size?: 's' | 'm' | undefined;
  onApplied?: (() => void) | undefined;
}

export function ServiceRestartButton({
  target,
  targetId,
  action,
  size = 's',
  onApplied,
}: ServiceRestartButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!target) {
    return (
      <Button mode="secondary" size={size} disabled>
        {action === 'recreate' ? 'Пересоздать' : 'Перезапустить'}: {targetId}
      </Button>
    );
  }
  return (
    <>
      <Button
        mode="secondary"
        size={size}
        onClick={() => setOpen(true)}
        aria-label={applyButtonLabel(target, action)}
      >
        {applyButtonLabel(target, action)}
      </Button>
      {open && (
        <RestartDialog
          target={target}
          action={action}
          onClose={() => setOpen(false)}
          onApplied={onApplied}
        />
      )}
    </>
  );
}

/**
 * Диалог: честное предупреждение до нажатия, ожидание после.
 *
 * Предупреждение берётся у сервера (RestartTarget), а не пишется здесь:
 * там же оно лежит для журнала аудита, и два набора формулировок для
 * одного и того же события неизбежно разошлись бы.
 */
function RestartDialog({
  target,
  action,
  onClose,
  onApplied,
}: {
  target: RestartTarget;
  action: RestartAction;
  onClose: () => void;
  onApplied?: (() => void) | undefined;
}): JSX.Element {
  const queryClient = useQueryClient();
  const warning = applyWarning(target, action);
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [bootId, setBootId] = useState<string | null>(null);
  const finished = useRef(false);

  const start = useMutation({
    mutationFn: () => api.requestRestart(target.id, action),
    onSuccess: (accepted) => {
      setJobId(accepted.id);
      /*
       * Метка процесса ДО перезапуска. Дальше панель опрашивает сервер и
       * ждёт, когда метка сменится: только это доказывает, что отвечает
       * уже новый процесс, а не тот же самый, который ещё не начал
       * останавливаться.
       */
      setBootId(accepted.self ? accepted.bootId : null);
      setWatch(startWatch(target, action));
    },
  });

  /* Опрос: раз в секунду, пока идёт ожидание. */
  const poll = useCallback(async () => {
    if (jobId === null) return;
    try {
      const job = await api.restartJob(jobId);
      setWatch((prev) => (prev ? watchStep(prev, { type: 'job', job }, bootId) : prev));
    } catch (err) {
      /*
       * Обрыв связи во время перезапуска — НОРМА, а не ошибка, и
       * показывать его как ошибку нельзя: человек решит, что сломал
       * сервер. Отличаем обрыв от осмысленного отказа сервера: ApiError
       * означает, что сервер жив и что-то ответил.
       */
      if (err instanceof ApiError && err.status < 500) {
        setWatch((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                message: 'Не удалось узнать результат',
                detail: err.message,
              }
            : prev,
        );
        return;
      }
      setWatch((prev) => (prev ? watchStep(prev, { type: 'offline' }, bootId) : prev));
    }
  }, [jobId, bootId]);

  useEffect(() => {
    if (!watching(watch)) return undefined;
    const timer = setTimeout(() => void poll(), WATCH_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [watch, poll]);

  /* Успех — обновить всё, что могло измениться от перезапуска. */
  useEffect(() => {
    if (watch?.status !== 'ok' || finished.current) return;
    finished.current = true;
    void queryClient.invalidateQueries();
    onApplied?.();
  }, [watch?.status, queryClient, onApplied]);

  const busy = start.isPending || watching(watch);
  const blocked = warning.blocked !== null;

  return (
    <Modal
      title={warning.title}
      onClose={busy ? () => undefined : onClose}
      footer={
        watch === null ? (
          <>
            <Button mode="secondary" onClick={onClose}>
              Отмена
            </Button>
            <Button disabled={blocked || start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? 'Запускаем…' : warning.title}
            </Button>
          </>
        ) : (
          <Button mode="secondary" disabled={busy} onClick={onClose}>
            {busy ? 'Идёт перезапуск…' : 'Закрыть'}
          </Button>
        )
      }
    >
      {/* ------------------------------------------------------------
          Отказ вместо тишины: посредника нет — говорим это словами и
          печатаем команду для консоли. Кнопка при этом выключена.
         ------------------------------------------------------------ */}
      {blocked && (
        <Notice tone="error">
          <strong>Из панели сейчас нельзя.</strong> {warning.blocked}
          {warning.command !== null && (
            <>
              {' '}
              Выполните на машине сервера: <code className="mt-mono">{warning.command}</code>
            </>
          )}
        </Notice>
      )}

      {start.error !== null && start.error !== undefined && (
        <Notice tone="error">
          {start.error instanceof ApiError ? start.error.message : String(start.error)}
          {warning.command !== null && (
            <>
              {' '}
              Сделать это в консоли: <code className="mt-mono">{warning.command}</code>
            </>
          )}
        </Notice>
      )}

      {watch === null && !blocked && (
        <>
          <Notice tone="error">
            <strong>Что перестанет работать.</strong> {warning.impact}
          </Notice>
          <p>
            <Badge tone="warn">{warning.downtime}</Badge> <span>{warning.safe}</span>
          </p>
          {action === 'recreate' && <Notice tone="info">{RECREATE_NOTE}</Notice>}
          {target.self && (
            <Notice tone="info">
              Панель на несколько секунд потеряет связь с сервером — это ожидаемо. Она вернётся сама
              и покажет, поднялся ли он; входить заново не потребуется.
            </Notice>
          )}
        </>
      )}

      {watch !== null && (
        <>
          <p aria-live="polite">
            <strong>{watch.message}</strong>
          </p>
          {watch.status === 'polling' && (
            <p>
              Прошло секунд: {watch.attempts}. Ожидаемая длительность — {warning.downtime}.
            </p>
          )}
          {watch.status === 'ok' && (
            <Notice tone="success">{watch.detail ?? 'Служба работает.'}</Notice>
          )}
          {(watch.status === 'failed' || watch.status === 'timeout') && (
            <Notice tone="error">
              {watch.detail ?? 'Причина неизвестна.'}
              {warning.command !== null && (
                <>
                  {' '}
                  Повторить в консоли: <code className="mt-mono">{warning.command}</code>
                </>
              )}
            </Notice>
          )}
        </>
      )}
    </Modal>
  );
}
