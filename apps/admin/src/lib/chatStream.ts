/**
 * Разговор с помощником: чтение потока ответа.
 *
 * Копия такого же модуля из веб-почты (apps/web/src/ai/chatStream.ts), и
 * это осознанно: панель и почта — отдельные приложения со своими
 * сборками, общего пакета для мелочей у них нет, а тянуть один ради
 * полутора сотен строк без зависимостей — дороже, чем держать две копии.
 * Расходиться им незачем: формат потока задан сервером.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ НЕ EventSource
 * ------------------------------------------------------------------
 * EventSource умеет только GET, а вопрос уходит телом POST: разговор не
 * должен попадать в адресную строку, журналы прокси и историю браузера.
 * Поэтому поток читается вручную из тела ответа — формат тот же
 * (Server-Sent Events), разбор занимает десяток строк.
 *
 * ------------------------------------------------------------------
 * ПРО ОБРЫВ
 * ------------------------------------------------------------------
 * Отмена обязана доходить до сервера: он по закрытию соединения
 * прекращает запрос к сервису ИИ, и за брошенный ответ не платят.
 * Поэтому наружу отдаётся функция прекращения, а не просто промис.
 */

/** Реплика разговора. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** События потока — ровно те, что шлёт сервер. */
export type ChatStreamEvent =
  | { type: 'disclosure'; disclosure: unknown }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: { kind: string; message: string; retryable?: boolean } };

export interface ChatStreamHandlers {
  /** Кусок текста — дописывается к ответу на экране. */
  onDelta(text: string): void;
  /** Ответ закончен целиком. */
  onDone(text: string): void;
  /** Что-то пошло не так: текст уже человеческий. */
  onError(message: string): void;
}

/**
 * Отправляет разговор и читает ответ по мере поступления.
 *
 * `path` — адрес потока: у почты и у панели он свой, всё остальное
 * одинаково.
 */
export function streamChat(
  path: string,
  messages: readonly ChatTurn[],
  handlers: ChatStreamHandlers,
): { stop: () => void } {
  const controller = new AbortController();

  void (async () => {
    let text = '';
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });

      if (!response.ok) {
        /*
         * Отказ приходит обычным JSON, и в нём есть человеческий текст:
         * «помощник выключен», «предел исчерпан». Показать код вместо
         * него значило бы отправить человека гадать.
         */
        let message = 'Помощник сейчас недоступен';
        try {
          const body = (await response.json()) as { message?: string };
          if (typeof body.message === 'string' && body.message !== '') message = body.message;
        } catch {
          /* тело не JSON — оставляем общий текст */
        }
        handlers.onError(message);
        return;
      }

      const body = response.body;
      if (!body) {
        handlers.onError('Ответ пришёл без содержимого');
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        /*
         * Блоки разделены пустой строкой. Последний кусок буфера может
         * быть неполным — он остаётся до следующего чтения, иначе
         * половина слова пропала бы.
         */
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');

          const line = block.split('\n').find((item) => item.startsWith('data:'));
          if (!line) continue;
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(line.slice(5).trim()) as ChatStreamEvent;
          } catch {
            continue;
          }
          if (event.type === 'delta') {
            text += event.text;
            handlers.onDelta(event.text);
          } else if (event.type === 'done') {
            // Сервер присылает собранный текст — берём его, а не свою
            // склейку: она может отличаться, если событие пришло не всё.
            text = event.text || text;
            handlers.onDone(text);
            return;
          } else if (event.type === 'error') {
            handlers.onError(event.error.message);
            return;
          }
        }
      }

      /*
       * Поток кончился без «done». Так бывает при обрыве связи на
       * середине: успевшее прийти — это настоящий ответ модели, и
       * выбрасывать его нельзя, но и молчать об обрыве тоже.
       */
      if (text !== '') handlers.onDone(text);
      else handlers.onError('Ответ оборвался, не начавшись');
    } catch (err) {
      // Отмена — это не ошибка: человек сам нажал «остановить».
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (text !== '') handlers.onDone(text);
        return;
      }
      handlers.onError('Связь с сервером прервалась');
    }
  })();

  return {
    stop: () => {
      controller.abort();
    },
  };
}
