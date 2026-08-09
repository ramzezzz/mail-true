/**
 * Ввод почтового адреса: имя ящика отдельно, домен отдельно.
 *
 * ------------------------------------------------------------------
 * ЗАЧЕМ ЭТО ВООБЩЕ
 * ------------------------------------------------------------------
 * Раньше все формы требовали писать адрес целиком — «ivan@mail.local».
 * Домен при этом почти всегда один и известен: он заведён в разделе
 * «Домены», и другого варианта у ящика быть не может. То есть человек
 * набирал руками то, что система знает сама, и ошибался ровно там, где
 * ошибиться проще всего: опечатка в домене создаёт ящик, на который
 * почта не придёт никогда, и заметно это далеко не сразу.
 *
 * Теперь: слева имя, справа домен. Один домен — он просто написан
 * рядом, выбирать нечего. Несколько — список.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПОЛНЫЙ АДРЕС ВСЁ РАВНО ПРИНИМАЕТСЯ
 * ------------------------------------------------------------------
 * Адреса чаще вставляют из письма или таблицы, чем набирают. Вставка
 * «ivan@mail.local» в поле имени не должна превращаться в
 * «ivan@mail.local@mail.local»: если во вставленном есть «@», строка
 * разбирается — имя слева, домен справа, и домен выбирается в списке,
 * когда он там есть.
 */
import { useId, useState, type ReactNode } from 'react';
import styles from './AddressInput.module.css';

export interface AddressInputProps {
  /** Полный адрес: то, что уходит на сервер. */
  value: string;
  onChange: (value: string) => void;
  /** Домены, заведённые в системе. Первый — предлагаемый по умолчанию. */
  domains: readonly string[];
  /** Подсказка в поле имени. */
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Разрешён ли домен вне списка. Для пересылки — да: письмо можно
   * отправлять и на чужой ящик. Для нового ящика — нет: домен должен
   * быть заведён, иначе почта до него не дойдёт.
   */
  allowExternal?: boolean;
  /** Что показать под полем (обычно — причина, по которой адрес не годится). */
  children?: ReactNode;
}

/** Разбор адреса на имя и домен. Второй «@» остаётся в имени — там его и заметят. */
export function splitAddress(value: string): { local: string; domain: string } {
  const at = value.lastIndexOf('@');
  if (at < 0) return { local: value, domain: '' };
  return { local: value.slice(0, at), domain: value.slice(at + 1) };
}

/** Сборка адреса. Пустое имя — пустой адрес: «@mail.local» никому не нужен. */
export function joinAddress(local: string, domain: string): string {
  const clean = local.trim();
  if (clean === '') return '';
  if (domain === '') return clean;
  return `${clean}@${domain}`;
}

export function AddressInput({
  value,
  onChange,
  domains,
  placeholder = 'ivan',
  autoFocus = false,
  allowExternal = false,
  children,
}: AddressInputProps) {
  const listId = useId();
  const { local, domain } = splitAddress(value);
  const fallback = domains[0] ?? '';
  /*
   * Выбранный домен помнится ОТДЕЛЬНО от значения.
   *
   * Полный адрес — единственное, что уходит наружу, и при пустом имени
   * он пуст: «@mail.local» никому не нужен. Но из пустого значения не
   * восстановить домен, и раньше он молча возвращался к первому в
   * списке. Живой сценарий: в системе три домена, человек выбирает
   * второй, потом стирает имя, чтобы набрать другое, — и ящик уезжает в
   * ПЕРВЫЙ домен. Никакого сигнала: поле домена просто показывает
   * другое значение, а смотрит человек в это время на имя.
   *
   * Это ровно та беда, ради которой компонент и заводили: «опечатка в
   * домене создаёт ящик, на который почта не придёт никогда, и заметно
   * это далеко не сразу». Только здесь даже не опечатка, а подмена.
   */
  const [sticky, setSticky] = useState('');
  const current = domain !== '' ? domain : sticky !== '' ? sticky : fallback;
  // Домен, которого нет в списке (внешний адрес пересылки), тоже должен
  // быть виден в выпадающем списке — иначе он молча заменится на первый.
  const options = domains.includes(current) || current === '' ? domains : [...domains, current];

  const setLocal = (raw: string) => {
    if (raw.includes('@')) {
      // Вставили адрес целиком — разбираем, а не приписываем домен второй раз.
      const parsed = splitAddress(raw);
      if (parsed.domain !== '') setSticky(parsed.domain);
      onChange(joinAddress(parsed.local, parsed.domain));
      return;
    }
    onChange(joinAddress(raw, current));
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <input
          className={`mt-input mt-mono ${styles.local}`}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          aria-label="Имя ящика"
        />
        <span className={styles.at}>@</span>
        {options.length > 1 || allowExternal ? (
          <input
            className={`mt-input mt-mono ${styles.domain}`}
            list={listId}
            value={current}
            placeholder={fallback}
            onChange={(e) => {
              const next = e.target.value.trim();
              // Запоминаем ДО сборки адреса: при пустом имени адрес
              // окажется пустым, и восстановить домен будет неоткуда.
              setSticky(next);
              onChange(joinAddress(local, next));
            }}
            aria-label="Домен"
          />
        ) : (
          <span className={`mt-mono ${styles.fixed}`} aria-label="Домен">
            {current === '' ? '—' : current}
          </span>
        )}
        <datalist id={listId}>
          {options.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </div>
      {children}
    </div>
  );
}
