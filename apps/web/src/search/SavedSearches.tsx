/**
 * Группа «Сохранённые запросы» в левой колонке.
 *
 * Соседствует с папками — там же, где она стоит в привычных почтовых интерфейсах и Thunderbird,
 * потому что человек ищет её именно там. Но папкой не притворяется, и это
 * важнее соседства:
 *
 *   значок лупы, а не папки;
 *   отдельный заголовок группы, а не строка среди папок;
 *   письмо на неё не перетащить (обработчиков переноса здесь нет вовсе);
 *   под именем показана сама строка запроса.
 *
 * Подделка под папку сбивает ровно один раз и надолго: человек тащит на
 * неё письмо, ждёт, что оно туда переедет, — а переезжать некуда, «папки»
 * не существует. Thunderbird на этом и спотыкается.
 *
 * Группы нет вовсе, пока сервер не сказал `available`, и пока ничего не
 * сохранено: пустой заголовок в колонке занимает место и ничего не значит.
 */

import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Button, Modal } from '../components';
import { cx } from '../lib/cx';
import { IconSearch, IconTrash } from '../mail/icons';
import { buildSearchUrl } from './searchParams';
import { EMPTY_SELECTION } from '../lib/searchFacets';
import { useDeleteSavedSearch, useSavedSearches } from './useSavedSearches';
import type { SavedSearch } from './savedSearchesApi';
import styles from './SavedSearches.module.css';

/** Адрес сохранённого запроса — тот же самый, что у обычного поиска. */
export function savedSearchUrl(saved: SavedSearch): string {
  return buildSearchUrl({
    query: saved.query,
    scope: { kind: 'all' },
    includeJunk: saved.includeJunk,
    facets: EMPTY_SELECTION,
  });
}

export function SavedSearches() {
  const { available, items } = useSavedSearches();
  const remove = useDeleteSavedSearch();
  /** Запрос, который собираются убрать: показываем подтверждение. */
  const [pending, setPending] = useState<SavedSearch | null>(null);

  if (!available || items.length === 0) return null;

  return (
    <div className={styles.block}>
      <div className={styles.groupTitle}>Сохранённые запросы</div>
      {items.map((saved) => (
        <div key={saved.id} className={styles.row}>
          <NavLink
            to={savedSearchUrl(saved)}
            className={({ isActive }) => cx(styles.item, isActive && styles.active)}
            /* Подсказка показывает строку целиком: в колонке 232px длинный
               запрос обрезается, а знать, что именно откроется, надо. */
            title={saved.query}
          >
            <span className={styles.itemIcon}>
              <IconSearch size={20} />
            </span>
            <span className={styles.itemText}>
              <span className={styles.itemName}>{saved.name}</span>
              <span className={styles.itemQuery}>{saved.query}</span>
            </span>
          </NavLink>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Убрать сохранённый запрос «${saved.name}»`}
            title="Убрать запрос. Письма не тронутся"
            disabled={remove.isPending}
            /*
             * Спрашиваем подтверждение: корзина стоит вплотную к ссылке
             * открытия в узкой колонке, а правки у сохранённых запросов
             * нет намеренно — промах мышью уносит имя и строку запроса
             * без возврата, набирать заново придётся руками. Удаление
             * шаблона рядом спрашивает так же.
             */
            onClick={() => setPending(saved)}
          >
            <IconTrash size={16} />
          </button>
        </div>
      ))}

      {pending && (
        <Modal
          title={`Убрать запрос «${pending.name}»?`}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button mode="secondary" onClick={() => setPending(null)}>
                Отмена
              </Button>
              <Button
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(pending.id, { onSuccess: () => setPending(null) });
                }}
              >
                Убрать
              </Button>
            </>
          }
        >
          <p>
            Письма не тронутся — исчезнет только сам запрос. Вернуть его нельзя: правки у
            сохранённых запросов нет, набирать придётся заново.
          </p>
          <p className="mt-mono">{pending.query}</p>
        </Modal>
      )}
    </div>
  );
}
