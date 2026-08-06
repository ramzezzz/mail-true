/**
 * Поле адреса с подсказкой.
 *
 * ------------------------------------------------------------------
 * ЧТО ЭТО ЗАМЕНЯЕТ
 * ------------------------------------------------------------------
 * Раньше «Кому», «Копия» и «Скрытая» были обычными строками ввода: адрес
 * набирался руками целиком, каждый раз. Ошибка в одной букве — и письмо
 * уходит не туда или возвращается отказом, а чтобы этого избежать,
 * человек шёл искать старое письмо и копировал адрес оттуда.
 *
 * Поле осталось СТРОКОЙ, а не превратилось в набор «чипов». Это решение,
 * а не экономия: строку понимает всё остальное окно написания — разбор
 * получателей, сохранение черновика, восстановление сохранённого. Замена
 * её на другое представление означала бы переделку всего перечисленного
 * ради вида, а не ради работы.
 *
 * ------------------------------------------------------------------
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО
 * ------------------------------------------------------------------
 * Подстановки при потере фокуса. Ни по Tab, ни по щелчку мимо, ни по
 * закрытию окна подсказка НИЧЕГО не дописывает за человека. Разбор
 * называет это главным риском всего раздела: «испортить можно — отправить
 * не тому», и единственная защита от этого — только явный выбор.
 * Поэтому адрес подставляется лишь по Enter на выделенной строке или по
 * щелчку по ней.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { normalizeAddress } from '@mail-true/shared';
import styles from './RecipientField.module.css';
import { setContactHidden, type ContactSuggestion } from './contactsApi';
import { useContactSuggest } from './useContactSuggest';

export interface RecipientFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Подпись поля для доступности: «Кому», «Копия», «Скрытая». */
  label: string;
  placeholder?: string | undefined;
  /** Класс самой строки ввода — стили задаёт окно написания. */
  className?: string | undefined;
  autoFocus?: boolean | undefined;
}

/** Разделители адресов в строке — те же, что понимает parseAddresses. */
const SEPARATORS = /[,;]/;

/**
 * Что человек набирает ПРЯМО СЕЙЧАС и что уже введено до этого.
 *
 * Подсказывать нужно по последнему, ещё не завершённому адресу, а не по
 * всей строке: иначе после первого же введённого адреса подсказка искала
 * бы по строке «anna@example.com, пет» и не находила ничего.
 */
export function splitRecipients(value: string): { entered: string[]; current: string } {
  const parts = value.split(SEPARATORS);
  const current = parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
  const entered = parts.slice(0, -1);
  return { entered, current };
}

/** Адреса из уже завершённых частей строки — их предлагать повторно нельзя. */
export function enteredAddresses(value: string): string[] {
  const result: string[] = [];
  for (const part of splitRecipients(value).entered) {
    const match = /<([^<>\s]+)>\s*$/.exec(part.trim());
    const address = normalizeAddress(match ? match[1] : part);
    if (address && !result.includes(address)) result.push(address);
  }
  return result;
}

/** Как подсказка выглядит в строке поля после выбора. */
export function formatChosen(item: ContactSuggestion): string {
  return item.name ? `${item.name} <${item.address}>` : item.address;
}

/**
 * Подставляет выбранный адрес вместо того, что человек набирал.
 *
 * Запятая с пробелом дописывается сразу: почти всегда за одним адресом
 * следует другой, а если не следует — лишняя запятая в конце разбором
 * отбрасывается (см. parseAddresses).
 */
export function applyChoice(value: string, item: ContactSuggestion): string {
  const { entered } = splitRecipients(value);
  const head = entered.length > 0 ? `${entered.join(',').trimEnd()}, ` : '';
  return `${head}${formatChosen(item)}, `;
}

export function RecipientField(props: RecipientFieldProps): JSX.Element {
  const { value, onChange, label, placeholder, className, autoFocus } = props;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  /** Список закрыт человеком (Escape) — до следующего ввода не открывать. */
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [hiddenLocally, setHiddenLocally] = useState<string[]>([]);

  const { current, exclude } = useMemo(() => {
    const parts = splitRecipients(value);
    return { current: parts.current.trim(), exclude: enteredAddresses(value) };
  }, [value]);

  /*
   * Закрытый Escape'ом список продолжает обновляться в памяти, хотя его и
   * не видно. Так стрелка вниз возвращает его мгновенно: человек, закрывший
   * подсказку и тут же передумавший, не должен ждать нового запроса — он
   * ничего не набирал заново.
   */
  const suggest = useContactSuggest({ query: current, exclude, enabled: focused });

  /*
   * Адрес, только что убранный из подсказок, исчезает из списка сразу.
   * Ждать ответа сервера тут нельзя: человек нажал «убрать», а строка
   * осталась бы на месте — и он нажал бы ещё раз.
   */
  const items = useMemo(
    () => suggest.items.filter((item) => !hiddenLocally.includes(item.address)),
    [suggest.items, hiddenLocally],
  );

  const open = focused && !dismissed && current !== '' && items.length > 0;

  // Выделение всегда стоит на существующей строке: список меняется под
  // курсором по мере набора, и указатель на исчезнувшую строку означал бы
  // Enter «в никуда».
  useEffect(() => {
    setActive((prev) => (prev < items.length ? prev : 0));
  }, [items.length]);

  const choose = useCallback(
    (item: ContactSuggestion) => {
      onChange(applyChoice(value, item));
      setDismissed(false);
      setActive(0);
      inputRef.current?.focus();
    },
    [onChange, value],
  );

  const hide = useCallback((address: string) => {
    setHiddenLocally((prev) => (prev.includes(address) ? prev : [...prev, address]));
    void setContactHidden(address, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Закрыть подсказку, а НЕ окно написания письма. Окно слушает
      // Escape на себе, и без остановки всплытия первое же нажатие
      // закрывало бы недописанное письмо вместе со списком.
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) return;
      event.preventDefault();
      // Список закрыт после Escape — стрелка возвращает его: человек
      // передумал, и заставлять его для этого стирать букву незачем.
      if (dismissed) {
        setDismissed(false);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // По кругу: список короткий, и упираться в его край незачем.
      setActive((prev) => (prev + step + items.length) % items.length);
      return;
    }
    if (event.key === 'Enter') {
      const item = open ? items[active] : undefined;
      if (!item) return;
      // Enter выбирает адрес, а не отправляет письмо: список открыт, и
      // человек целился в него.
      event.preventDefault();
      choose(item);
      return;
    }
    if (event.key === 'Tab') {
      /*
       * Tab — это уход из поля, а не выбор. Ни один адрес при нём НЕ
       * подставляется: подстановка при потере фокуса — это ровно тот
       * случай, когда письмо уходит не тому, и «я же не выбирал» звучит
       * уже после отправки.
       */
      setDismissed(true);
    }
  };

  return (
    <span className={styles.wrap}>
      <input
        ref={inputRef}
        className={className}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setDismissed(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${String(active)}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
      />
      {open && (
        <ul className={styles.list} id={listId} role="listbox" aria-label={`Подсказка: ${label}`}>
          {items.map((item, index) => (
            <li
              key={item.address}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? `${styles.item} ${styles.active}` : styles.item}
              /* Мышь не должна уводить фокус из поля: иначе список
                 закроется раньше, чем щелчок до него дойдёт. */
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
            >
              <span className={styles.text}>
                {item.name && <span className={styles.name}>{item.name}</span>}
                <span className={styles.address}>{item.address}</span>
              </span>
              {item.own && (
                <span className={styles.own} title="Вы писали по этому адресу">
                  вы писали
                </span>
              )}
              <button
                type="button"
                className={styles.remove}
                aria-label={`Убрать ${item.address} из подсказок`}
                title="Убрать из подсказок"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  hide(item.address);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {focused && !dismissed && current !== '' && items.length === 0 && !suggest.complete && (
        /* Честнее, чем «ничего не найдено»: указатель переписки ещё
           разбирается, и через секунду ответ может стать другим. */
        <span className={styles.hint} role="status">
          Собираем адреса из переписки…
        </span>
      )}
    </span>
  );
}
