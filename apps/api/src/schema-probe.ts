/**
 * Повторная проба схемы: секундный сбой базы не должен выключать раздел
 * до перезапуска контейнера.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Проба выполнялась ОДИН раз при сборке маршрутов. Любой отказ, кроме
 * «таблицы нет», — обрыв соединения, Postgres ещё не принимает
 * подключения, — навсегда оставлял раздел выключенным: пункт меню просто
 * исчезал, а причины на экране не было. База поднималась минуту спустя,
 * почта работала, разделов не было, и связать одно с другим человек не
 * мог никак.
 *
 * «Таблицы нет» повторять незачем: миграция сама не появится, и об этом
 * сказано отдельным сообщением.
 */
export async function probeSchemaWithRetry(
  probe: () => Promise<boolean>,
  onReady: () => void,
  onMissing: () => void,
  onError: (err: unknown, willRetry: boolean) => void,
  delaysMs: readonly number[] = [5_000, 15_000, 60_000, 300_000],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (await probe()) {
        onReady();
        return;
      }
      onMissing();
      return;
    } catch (err) {
      const delay = delaysMs[attempt];
      onError(err, delay !== undefined);
      if (delay === undefined) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
    }
  }
}
