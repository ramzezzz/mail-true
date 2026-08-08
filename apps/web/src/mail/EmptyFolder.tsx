/**
 * Пустая папка.
 *
 * Раньше на месте списка стояла одна строка «В этой папке пока пусто»,
 * прижатая к верху контейнера высотой 838px: экран выглядел не пустым,
 * а недогруженным. в привычных почтовых интерфейсах пустая папка — это экран: иллюстрация и
 * заголовок ровно по центру свободного места.
 *
 * Иллюстрация нарисована кодом (SVG), растровых файлов в репозитории нет.
 * Цвета берутся из токенов темы, поэтому она живёт и в тёмной, и в цветных.
 */

import styles from './EmptyFolder.module.css';

interface FolderCopy {
  title: string;
  hint: string;
}

/** Что написать в пустой папке — зависит от её роли, а не от имени. */
export function emptyFolderCopy(role: string): FolderCopy {
  switch (role) {
    case 'trash':
      return { title: 'Корзина пуста', hint: 'Удалённые письма попадают сюда' };
    case 'spam':
      return { title: 'Спама нет', hint: 'Сюда попадают письма, которые мы сочли нежелательными' };
    case 'drafts':
      return { title: 'Черновиков нет', hint: 'Незаконченные письма сохраняются здесь' };
    case 'sent':
      return { title: 'Отправленных писем нет', hint: 'Здесь будут копии всего, что вы отправите' };
    case 'archive':
      return {
        title: 'В архиве пусто',
        hint: 'Сюда можно убирать письма, которые не нужны в списке',
      };
    case 'snoozed':
      return {
        title: 'Отложенных писем нет',
        hint: 'Письмо, отложенное до срока, ждёт здесь и само вернётся во «Входящие»',
      };
    case 'inbox':
      return { title: 'Писем нет', hint: 'Новые письма появятся здесь' };
    default:
      return { title: 'В этой папке пусто', hint: 'Сюда пока не попало ни одного письма' };
  }
}

/** Иллюстрация: открытый конверт с вылетевшим листом. Сетка 160×120. */
function EmptyIllustration() {
  return (
    <svg
      className={styles.art}
      width="160"
      height="120"
      viewBox="0 0 160 120"
      fill="none"
      aria-hidden="true"
    >
      {/* Лист письма — уезжает вверх из конверта */}
      <rect x="46" y="10" width="68" height="52" rx="6" className={styles.artSheet} />
      <path d="M58 26h44M58 36h44M58 46h28" className={styles.artLines} />

      {/* Корпус конверта */}
      <path
        d="M26 52h108a6 6 0 0 1 6 6v44a6 6 0 0 1-6 6H26a6 6 0 0 1-6-6V58a6 6 0 0 1 6-6Z"
        className={styles.artBody}
      />
      {/* Передняя стенка со сгибами */}
      <path d="M20 60l52 34a14 14 0 0 0 16 0l52-34" className={styles.artFold} />
      <path d="M20 102l44-30M140 102l-44-30" className={styles.artFold} />
    </svg>
  );
}

export function EmptyFolder({ role }: { role: string }) {
  const copy = emptyFolderCopy(role);
  return (
    <div className={styles.root}>
      <EmptyIllustration />
      <p className={styles.title}>{copy.title}</p>
      <p className={styles.hint}>{copy.hint}</p>
    </div>
  );
}
