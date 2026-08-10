/**
 * Значки действий в таблицах админки.
 *
 * Рисуются встроенно, а не берутся из фирменного спрайта (brand/icons),
 * по одной причине: спрайт отдаётся с хоста почты, а админка живёт на
 * своём — на странице админки `<use href="/brand/icons/sprite.svg#...">`
 * молча не находит символ и не рисует ничего. Пустой квадрат вместо
 * «Удалить» — не та цена, которую стоит платить за общий файл.
 *
 * Стилистика та же, что у почтовых значков (apps/web/src/mail/icons.tsx):
 * сетка 24×24, штрих 1.8, цвет наследуется через currentColor.
 */
import type { ReactElement } from 'react';

interface IconProps {
  size?: number;
}

/** Значок из набора контуров. */
function stroke(paths: readonly string[], { size = 16 }: IconProps = {}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Карточка ящика: что в нём и сколько занято. */
export const IconCard = (p: IconProps = {}) => stroke(['M3 6h18v12H3z', 'M3 10h18', 'M7 14h5'], p);

/** Шестерёнка — настройки ящика. */
export const IconSettings = (p: IconProps = {}) =>
  stroke(
    [
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
    ],
    p,
  );

/** Стрелка внутрь конверта — вход администратора в чужой ящик. */
export const IconEnterMailbox = (p: IconProps = {}) =>
  stroke(
    [
      'M20 12V7a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 4 7v10a1.5 1.5 0 0 0 1.5 1.5H12',
      'M4.5 7.5 12 12.5l7.5-5',
      'M15 17.5h6',
      'M18 14.5l3 3-3 3',
    ],
    p,
  );

/** Карандаш — изменить запись. */
export const IconPencil = (p: IconProps = {}) =>
  stroke(['M4.5 19.5h4L20 8a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z', 'M15.5 6.5l3 3'], p);

/** Ключ — пароль ящика и ключ DKIM. */
export const IconKey = (p: IconProps = {}) =>
  stroke(
    [
      'M14.5 4.5a5 5 0 1 1-3.6 8.5L4.5 19.4V21H7v-2h2v-2h2l0-1.5 0.9-0.9a5 5 0 0 1 2.6-9.1Z',
      'M16.2 8.3h.01',
    ],
    p,
  );

/** Замок закрыт — заблокировать. */
export const IconLock = (p: IconProps = {}) =>
  stroke(
    [
      'M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
      'M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7',
      'M12 14v2.5',
    ],
    p,
  );

/** Замок открыт — разблокировать. */
export const IconUnlock = (p: IconProps = {}) =>
  stroke(
    [
      'M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
      'M8.5 10.5V7.8a3.5 3.5 0 0 1 6.8-1.2',
      'M12 14v2.5',
    ],
    p,
  );

/** Корзина — удалить. */
export const IconTrash = (p: IconProps = {}) =>
  stroke(
    [
      'M4.5 6.5h15',
      'M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5',
      'M6.5 6.5 7.4 19a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l.9-12.5',
      'M10.5 10v6',
      'M13.5 10v6',
    ],
    p,
  );

/** Щит с галочкой — проверка DNS домена. */
export const IconShieldCheck = (p: IconProps = {}) =>
  stroke(['M12 3 5 5.8v5.4c0 4.4 3 7.4 7 9 4-1.6 7-4.6 7-9V5.8L12 3Z', 'M9 11.8l2.2 2.2 3.8-4'], p);

/** Выключатель — включить/отключить алиас. */
export const IconPower = (p: IconProps = {}) => stroke(['M12 4v8', 'M7.4 6.6a7 7 0 1 0 9.2 0'], p);
