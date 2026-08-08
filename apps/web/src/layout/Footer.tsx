/**
 * Нижняя строка состояния почты.
 *
 * ЧТО ПОДСМОТРЕНО И ЧТО ВЗЯТО.
 *
 *   привычный почтовый интерфейс — строки состояния под списком писем У НЕГО НЕТ. Место в вёрстке
 *     предусмотрено, но схлопнуто: `--vkui--octavius_size_portal-footer_height
 *     --regular: 0px` (эталонные снимки интерфейса), и на снимке
 *     эталонные снимки интерфейса список упирается в край окна. Занятое место
 *     привычный почтовый интерфейс показывает в другом месте — карточкой в «Настройки → Главная»
 *     (эталонные снимки интерфейса): заголовок «Занято 400 МБ из 8 ГБ»,
 *     под ним тонкая полоса-шкала, синяя заливка на сером. Оттуда взяты
 *     и формулировка («Занято X из Y», свои единицы у каждого числа),
 *     и шкала. Но занесены они СЮДА, а не в настройки: число, о котором
 *     узнаёшь, только если пойдёшь его искать, узнаётся обычно в худший
 *     момент — когда почта уже перестала приходить.
 *
 *   Gmail — подвал под списком: слева занятое место со шкалой
 *     («Использовано X ГБ из 15 ГБ»), справа «Last account activity:
 *     N minutes ago». Сама «активность аккаунта» у Gmail про входы в ящик,
 *     а не про свежесть списка, и её мы не показываем — взят ФОРМАТ:
 *     возраст относительным временем вместо отметки часов. «14:52» человек
 *     вычитает из текущего времени в уме, «7 минут назад» — нет.
 *
 *   Thunderbird — статус-бар из пяти зон: переключатель онлайн/офлайн,
 *     текст текущей операции («Done», «Downloading message N of M…») и
 *     панель квоты со шкалой («{percent}% full», пороги показа 75/80/95).
 *     Outlook (классический) — «Items: N», «Unread: N» и состояние связи
 *     («Connected to: Microsoft Exchange», «Trying to connect…», «Working
 *     Offline»); в новом Outlook и OWA строки состояния нет вовсе.
 *     Взято: счётчики папки, непрочитанные и СОСТОЯНИЕ СОЕДИНЕНИЯ.
 *     Последнее — самое ценное: когда сервер не отвечает, письма просто
 *     перестают приходить, и без строки внизу человеку неоткуда узнать,
 *     что дело не в отсутствии писем.
 *
 *   Не взято: ссылки подвала («О компании», «Реклама», «Помощь») — в привычных почтовых интерфейсах
 *     они есть только на страницах настроек, а не в почте; ползунок масштаба
 *     и переключатель вида из Outlook — у нас они живут в панели над списком.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Ни одного показателя, которого нет на сервере.
 * Квота показывается, только когда Dovecot сообщил предел; счётчики — только
 * для настоящей папки; версия — только когда сервер её назвал. Ноль вместо
 * неизвестного не показывается нигде (расчёты — FooterStatus.ts).
 *
 * ТРИ ОГРАНИЧЕНИЯ, ОПРЕДЕЛИВШИЕ УСТРОЙСТВО.
 *
 *   1. Строка не должна прыгать. Высота задана жёстко (28px), а состояние
 *      связи и подпись времени живут в ЛЕВОЙ части с `flex: 1`: сколько бы
 *      ни менялся их текст, счётчики, шкала и версия справа остаются на
 *      своих местах. Числа набраны моноширинными цифрами — «9 писем» и
 *      «11 писем» одинаковой ширины.
 *
 *   2. Ни одного лишнего запроса. Счётчики и квота берутся из запросов,
 *      которые приложение делает и без строки состояния (список папок для
 *      левой колонки, профиль для шапки). Свежесть и состояние связи
 *      вычитываются из кэша запросов — из того, что УЖЕ произошло, а не из
 *      пробы по таймеру. Часы, переписывающие «7 минут назад», на сервер
 *      не ходят вовсе. Единственный собственный запрос — версия, один раз
 *      за вкладку.
 *
 *   3. На телефоне строки нет. Внизу уже стоит навигация (BottomNav, 56px)
 *      и плавающая кнопка написания; вторая полоса отняла бы у списка ещё
 *      28 точек из 844 и упёрлась бы в кнопку. Всё, что строка сообщает,
 *      на телефоне доступно иначе: непрочитанные — значком на «Входящих»,
 *      отказ обновления — сообщением поверх интерфейса. Скрытие сделано
 *      в CSS (`display: none` до 600px), поэтому на узком экране строка не
 *      занимает места и не попадает в дерево доступности.
 */

import { useEffect, useState } from 'react';
import {
  notifyManager,
  useIsFetching,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { useAccount, useFolders, useRefreshMail, useServerVersion } from '../api/queries';
import { cx } from '../lib/cx';
import { IconRefresh } from '../mail/icons';
import {
  SILENCE_MS,
  countsText,
  folderIdFromPath,
  isSilent,
  mailStatus,
  nextTickDelay,
  quotaView,
  resolveLink,
  updatedText,
  type MailStatus,
  type QuerySnapshot,
} from './FooterStatus';
import styles from './Footer.module.css';

/** Мнение браузера о сети. Вне браузера (проверки) считаем, что сеть есть. */
function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/** Снимок кэша запросов — ровно те поля, что нужны расчёту. */
function readCache(client: QueryClient): QuerySnapshot[] {
  return client
    .getQueryCache()
    .getAll()
    .map((query) => ({
      key: query.queryKey,
      dataUpdatedAt: query.state.dataUpdatedAt,
      errorUpdatedAt: query.state.errorUpdatedAt,
      error: query.state.error,
      hasData: query.state.data !== undefined,
      failureCount: query.state.fetchFailureCount,
      failureReason: query.state.fetchFailureReason,
    }));
}

/**
 * Состояние связи и свежесть почтовых данных.
 *
 * Подписка на кэш запросов, а не опрос сервера: см. пункт 2 в шапке файла.
 * Новое состояние ставится, только если оно вправду другое — кэш шумит на
 * каждое изменение любого запроса, и без этой проверки строка перерисовы-
 * валась бы десятками раз на одну прокрутку списка.
 *
 * ПОЧЕМУ ЧЕРЕЗ `notifyManager.batchCalls`, А НЕ ГОЛЫМ СЛУШАТЕЛЕМ.
 *
 * Кэш зовёт своих слушателей СИНХРОННО, прямо из того места, где его
 * изменили (`QueryCache.notify`). А изменяют его в том числе ВО ВРЕМЯ
 * ОТРИСОВКИ: `useQuery`/`useQueries` заводят запись в кэше в теле рендера
 * (`getOptimisticResult` → `QueryCache.build` → событие `added`). Открытие
 * поиска — ровно этот случай: ключи запросов там новые, поиск рисуется
 * соседом строки состояния (AppLayout: `<Outlet/>`, затем `<Footer/>`), и
 * голый слушатель дёргал `setStatus` посреди чужого рендера. React честно
 * ругался: «Cannot update a component (Footer) while rendering a different
 * component». В собранном виде предупреждения нет, но обновление посреди
 * рендера — настоящая ошибка, а не шум разработки: в паре с параллельным
 * режимом React такое обновление может потеряться или прийти дважды.
 *
 * `batchCalls` — то же самое, чем react-query обёртывает подписки всех
 * СВОИХ хуков (см. useBaseQuery): вызов откладывается до конца текущей
 * пачки изменений и уходит отдельной задачей, то есть заведомо вне фазы
 * отрисовки. Заодно десяток событий одной загрузки сливается в один
 * пересчёт — ровно то, ради чего рядом стоит проверка на равенство.
 */
function useMailStatus(): MailStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<MailStatus>(() => mailStatus(readCache(client), isOnline()));

  useEffect(() => {
    const update = (): void => {
      const next = mailStatus(readCache(client), isOnline());
      setStatus((prev) =>
        prev.link === next.link && prev.updatedAt === next.updatedAt ? prev : next,
      );
    };
    update();
    const unsubscribe = client.getQueryCache().subscribe(notifyManager.batchCalls(update));
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      unsubscribe();
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [client]);

  return status;
}

/**
 * Молчит ли сервер: разговор с ним идёт дольше SILENCE_MS и не кончается.
 *
 * Отдельный признак, а не производная от ошибок запросов — потому что
 * ошибки может не быть вовсе (подробности и числа — в FooterStatus.ts,
 * рядом с SILENCE_MS). Будильник заводится ОДИН и только на время
 * разговора: если ответ придёт раньше срока, он снимается и не срабатывает.
 * На сервер этот наблюдатель не ходит.
 *
 * Вынесен наружу ради проверки: поведение во времени (сработать ровно на
 * пороге, погаснуть при ответе) проверяется на самом хуке, а не через
 * внутренности react-query — см. tests/footer.test.tsx.
 */
export function useSilence(busy: boolean): boolean {
  const [since, setSince] = useState<number | null>(null);
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    if (!busy) {
      setSince(null);
      setSilent(false);
      return;
    }
    setSince((prev) => prev ?? Date.now());
  }, [busy]);

  useEffect(() => {
    if (since == null) return;
    const left = Math.max(0, SILENCE_MS - (Date.now() - since));
    const timer = setTimeout(() => setSilent(isSilent(since, Date.now())), left + 50);
    return () => clearTimeout(timer);
  }, [since]);

  return silent;
}

/**
 * Текущее время для подписи «обновлено N назад».
 *
 * Будильник ставится ровно на тот миг, когда подпись СТАНЕТ ДРУГОЙ
 * (`nextTickDelay`), а не «раз в секунду на всякий случай». Пока вкладку
 * не видно, часы стоят: перерисовывать невидимую строку незачем, а при
 * возврате во вкладку время пересчитывается сразу.
 */
function useNow(updatedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (updatedAt == null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = (): void => {
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined' && document.hidden) return;
      const current = Date.now();
      setNow(current);
      timer = setTimeout(arm, nextTickDelay(Math.max(0, current - updatedAt)));
    };

    // Первый завод — без перерисовки: подпись только что отрисована верной
    const started = Date.now();
    timer = setTimeout(arm, nextTickDelay(Math.max(0, started - updatedAt)));

    if (typeof document === 'undefined') return () => clearTimeout(timer);
    document.addEventListener('visibilitychange', arm);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [updatedAt]);

  return now;
}

/** Слова состояния связи. Цвет никогда не единственный признак. */
const LINK_TEXT = {
  offline: 'Нет сети',
  unreachable: 'Сервер не отвечает',
} as const;

export function Footer() {
  const location = useLocation();
  const { data: folders } = useFolders();
  const { data: account } = useAccount();
  const { data: version } = useServerVersion();
  const refresh = useRefreshMail();
  const status = useMailStatus();
  const now = useNow(status.updatedAt);

  // Идёт ли прямо сейчас разговор с сервером о почте
  const fetchingFolders = useIsFetching({ queryKey: ['folders'] });
  const fetchingMessages = useIsFetching({ queryKey: ['messages'] });
  const busy = fetchingFolders + fetchingMessages > 0;
  const silent = useSilence(busy);

  const folderId = folderIdFromPath(location.pathname);
  const counts = countsText(folderId ? folders?.find((f) => f.id === folderId) : undefined);
  const quota = account ? quotaView(account.quotaUsedBytes, account.quotaLimitBytes) : null;

  /*
   * Что написано слева.
   *
   * «Обновление…» показывается ТОЛЬКО при живой связи. Когда связи нет,
   * запрос может висеть «идущим» сколь угодно долго (проверено на стенде:
   * двадцать четыре секунды и дальше), и слово «Обновление…» в этот момент
   * — обещание, которого никто не выполнит. Вместо него человеку нужнее
   * возраст того, что он видит на экране: «Сервер не отвечает, обновлено
   * 4 минуты назад» отвечает сразу и на «что случилось», и на «насколько
   * устарело то, что я читаю».
   */
  const link = resolveLink(status.link, silent);
  const linkProblem = link === 'ok' ? null : LINK_TEXT[link];
  const age = status.updatedAt != null ? updatedText(status.updatedAt, now) : null;
  const freshness = linkProblem ? age : busy ? 'Обновление…' : age;

  return (
    <footer className={styles.footer} aria-label="Состояние почты">
      <div className={styles.left}>
        {/*
          Отказ связи — единственное, о чём строка сообщает вслух: подпись
          времени меняется каждую минуту, и объявлять её значило бы
          превратить чтение с экрана в пытку.
        */}
        <span className={styles.link} aria-live="polite">
          {linkProblem && (
            <>
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.linkText}>{linkProblem}</span>
            </>
          )}
        </span>

        {freshness && <span className={styles.fresh}>{freshness}</span>}

        {/*
          Кнопка НЕ отключается на время запроса. Найдено на живом стенде:
          пока сервер приложения лежал, react-query повторял запросы
          с растущей паузой, `isFetching` не опускался в ноль десятками
          секунд — и единственная кнопка «попробовать ещё раз» оказывалась
          недоступна ровно тогда, когда она и нужна. Повторное нажатие
          безвредно: react-query не заводит второй запрос поверх идущего.
        */}
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          aria-busy={busy}
          title="Перечитать письма и счётчики папок"
        >
          <span className={cx(styles.refreshIcon, busy && styles.spinning)} aria-hidden="true">
            <IconRefresh size={14} />
          </span>
          Обновить
        </button>
      </div>

      {/* Счётчики текущей папки. Нет папки (поиск, написание) — нет и счёта */}
      {counts && <span className={styles.counts}>{counts}</span>}

      {/* Занятое место: только когда сервер сообщил предел квоты */}
      {quota && (
        <span className={styles.quota} title={quota.text}>
          <span
            className={styles.meter}
            role="progressbar"
            aria-label="Занято места в ящике"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(quota.fraction * 100)}
            aria-valuetext={quota.text}
          >
            <span
              className={cx(styles.meterFill, quota.nearlyFull && styles.meterFull)}
              style={{ width: `${(quota.fraction * 100).toFixed(1)}%` }}
            />
          </span>
          <span className={styles.quotaText}>{quota.text}</span>
        </span>
      )}

      {/* Версия — мелким, для поддержки. Не знаем — не пишем */}
      {version?.version && (
        <span className={styles.version} title="Версия сервера приложения">
          v{version.version}
        </span>
      )}
    </footer>
  );
}
