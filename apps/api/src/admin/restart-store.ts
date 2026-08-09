/**
 * Рабочее состояние перезапусков: что заказали, чем кончилось, когда
 * службу применяли в последний раз.
 *
 * Почему это отдельно от журнала аудита — подробно в шапке миграции
 * infra/postgres/migrations/0001_baseline.sql. Коротко: аудит
 * отвечает человеку через полгода на вопрос «кто это сделал» и не
 * удаляется никогда, а здесь лежит то, что продукту нужно ПРЯМО СЕЙЧАС:
 *
 *   • ответ «поднялась или нет», который приходит уже другому запросу,
 *     а после перезапуска сервера приложения — и вовсе другому процессу;
 *   • время последнего удачного применения службы — единственный честный
 *     способ понять, ждёт ли настройка ЧУЖОГО контейнера применения;
 *   • счётчик стартов процесса, на котором держится защита от петли.
 */
import { isUndefinedTable, type AdminDb } from './db.js';

export type RestartStatus = 'pending' | 'ok' | 'failed';
/** boot — отметка «процесс сервера приложения запустился», её ставит он сам. */
export type RestartRecordAction = 'restart' | 'recreate' | 'boot';

export interface RestartRecord {
  id: string;
  service: string;
  action: RestartRecordAction;
  requestedBy: string | null;
  requestedAt: Date;
  finishedAt: Date | null;
  status: RestartStatus;
  detail: string | null;
}

interface Row {
  id: string;
  service: string;
  action: string;
  requested_by: string | null;
  requested_at: Date;
  finished_at: Date | null;
  status: string;
  detail: string | null;
}

function toRecord(row: Row): RestartRecord {
  return {
    id: String(row.id),
    service: row.service,
    action: row.action as RestartRecordAction,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    status: row.status as RestartStatus,
    detail: row.detail,
  };
}

/**
 * Сколько записей хранить. Это рабочее состояние, а не доказательство:
 * доказательство пишется в аудит и живёт вечно. Тысяча строк — это
 * несколько лет обычной работы и несколько недель, если кто-то повадился
 * жать кнопку; ни то, ни другое не заметно на диске.
 */
const KEEP_ROWS = 1000;

/** Столбцы в одном порядке во всех запросах: их читает один toRecord. */
const COLUMNS = 'id, service, action, requested_by, requested_at, finished_at, status, detail';

export class RestartStore {
  constructor(private readonly db: Pick<AdminDb, 'query'>) {}

  /**
   * Применена ли миграция. Отсутствие таблицы НЕ должно ронять раздел:
   * перезапуск полезен и без журнала, а сказать об этом словами лучше,
   * чем отвечать пятисотой ошибкой на каждое нажатие.
   */
  async schemaReady(): Promise<boolean> {
    try {
      await this.db.query('SELECT 1 FROM service_restarts LIMIT 1');
      return true;
    } catch (err) {
      if (isUndefinedTable(err)) return false;
      throw err;
    }
  }

  /** Заводит запись «идёт» и возвращает её. */
  async begin(
    service: string,
    action: RestartRecordAction,
    requestedBy: string | null,
  ): Promise<RestartRecord> {
    const rows = await this.db.query<Row>(
      `INSERT INTO service_restarts (service, action, requested_by, status)
            VALUES ($1, $2, $3, 'pending')
         RETURNING ${COLUMNS}`,
      [service, action, requestedBy === null ? null : requestedBy.slice(0, 128)],
    );
    const row = rows[0];
    if (!row) throw new Error('Не удалось записать заявку на перезапуск.');
    return toRecord(row);
  }

  /** Закрывает запись итогом. Повторный вызов по закрытой ничего не меняет. */
  async finish(id: string, status: 'ok' | 'failed', detail: string | null): Promise<void> {
    await this.db.query(
      `UPDATE service_restarts
          SET status = $2, detail = $3, finished_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id, status, detail === null ? null : detail.slice(0, 8000)],
    );
  }

  async byId(id: string): Promise<RestartRecord | null> {
    const rows = await this.db.query<Row>(`SELECT ${COLUMNS} FROM service_restarts WHERE id = $1`, [
      id,
    ]);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /** Последние записи — лента «что происходило» в панели. */
  async recent(limit = 20): Promise<RestartRecord[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM service_restarts
        WHERE action <> 'boot'
        ORDER BY requested_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Когда каждую службу применяли удачно в последний раз.
   *
   * Ради этого запроса таблица и существует. Для настройки ЧУЖОГО
   * контейнера «применена или нет» нельзя вычислить сравнением с
   * окружением своего процесса: значение читает autoconfig или unbound.
   * Единственный честный признак — это время против времени правки
   * настройки в server_settings.
   */
  async lastApplied(): Promise<Map<string, Date>> {
    const rows = await this.db.query<{ service: string; last: Date }>(
      /*
       * Отметки о старте (action = 'boot') сюда НЕ идут, и это не мелочь.
       *
       * Их пишет сам процесс при каждом запуске — после обновления, после
       * падения, после `docker compose up`, после чего угодно, что поднял
       * контейнер. Пока они считались применением, картина была такая:
       * человек сохранил настройку группы recreate, панель честно
       * показала «ждёт применения» — а следующий же запуск api гасил этот
       * признак. Ничего при этом не применялось: окружение контейнера
       * задаётся при его СОЗДАНИИ, и перезапуск процесса его не меняет.
       *
       * Итог был хуже, чем просто неверная надпись: человек видел
       * «применено», уходил — и работал со старым значением, будучи
       * уверенным в обратном. Ровно то, ради предотвращения чего эта
       * таблица и заведена.
       *
       * Обратная ошибка (пересоздали из консоли, а панель всё ещё пишет
       * «ждёт») безобидна и здесь выбрана намеренно — тем же правилом,
       * что и «не применяли ни разу — значит ждёт».
       */
      `SELECT service, max(requested_at) AS last
         FROM service_restarts
        WHERE status = 'ok' AND action <> 'boot'
        GROUP BY service`,
    );
    return new Map(rows.map((r) => [r.service, r.last]));
  }

  /**
   * Сколько раз сервер приложения стартовал за последние N минут.
   *
   * Это и есть защита от петли. Настройка, из-за которой процесс падает
   * на старте, превращала бы кнопку «перезапустить» в бесконечный круг:
   * поднялся, упал, демон поднял снова. Считаем отметки о старте — и,
   * если их слишком много, отказываемся перезапускаться ещё раз, объясняя
   * почему.
   */
  async bootsSince(minutes: number): Promise<number> {
    const rows = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM service_restarts
        WHERE action = 'boot'
          AND requested_at > now() - ($1 || ' minutes')::interval`,
      [String(minutes)],
    );
    return Number(rows[0]?.count ?? '0');
  }

  /**
   * Отметка «процесс запустился» и закрытие заявки, которую он же и
   * выполнил. Заявка закрывается ЗДЕСЬ, а не там, где её завели, потому
   * что там процесса уже нет: он сам себя и остановил.
   */
  async markBoot(): Promise<RestartRecord | null> {
    await this.db.query(
      `INSERT INTO service_restarts (service, action, status, finished_at, detail)
            VALUES ('api', 'boot', 'ok', now(), 'Процесс сервера приложения запустился')`,
    );
    /*
     * Заявка, которую закрывает этот старт: последняя незакрытая по своей
     * же службе. Ограничение по времени обязательно — иначе процесс,
     * поднявшийся через неделю после брошенной заявки, отчитался бы, что
     * успешно выполнил её.
     */
    const rows = await this.db.query<Row>(
      `UPDATE service_restarts
          SET status = 'ok', finished_at = now(),
              detail = 'Сервер приложения поднялся'
        WHERE id = (
                SELECT id FROM service_restarts
                 WHERE service = 'api' AND action <> 'boot' AND status = 'pending'
                   AND requested_at > now() - interval '15 minutes'
                 ORDER BY requested_at DESC
                 LIMIT 1)
      RETURNING ${COLUMNS}`,
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Заявки, которые никто уже не закроет.
   *
   * Такое бывает ровно в одном случае: процесс завели, он ушёл на
   * перезапуск и не поднялся — либо поднялся так поздно, что срок
   * закрытия вышел. Оставить их в состоянии «идёт» нельзя: панель ждала
   * бы ответа вечно.
   */
  async expireStale(minutes: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE service_restarts
          SET status = 'failed', finished_at = now(),
              detail = 'Ответа не дождались: служба не сообщила о себе за отведённое время. '
                    || 'Посмотрите журнал контейнера.'
        WHERE status = 'pending'
          AND requested_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
      [String(minutes)],
    );
    return rows.length;
  }

  /** Уборка: держим последние KEEP_ROWS записей. */
  async trim(): Promise<void> {
    await this.db.query(
      `DELETE FROM service_restarts
        WHERE id < (SELECT min(id) FROM (
                      SELECT id FROM service_restarts ORDER BY id DESC LIMIT $1
                    ) AS keep)`,
      [KEEP_ROWS],
    );
  }
}
