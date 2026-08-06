/**
 * Кружок отправителя в списке писем: логотип домена или буква.
 *
 * ------------------------------------------------------------------
 * Что здесь важно и почему
 * ------------------------------------------------------------------
 * 1. Буква — это НОРМА, а не запасной вариант «на случай сбоя». Логотип
 *    появляется, только когда сошлось всё сразу: человек включил настройку,
 *    подлинность отправителя подтверждена сервером, логотип у домена нашёлся
 *    и оказался годной картинкой. Во всех прочих случаях кружок выглядит
 *    ровно так, как выглядел до появления этой возможности.
 *
 * 2. Адрес картинки — ВСЕГДА наш. Компонент не умеет обращаться к чужому
 *    домену и не должен уметь: ссылка на чужой сайт в списке писем — это
 *    маячок, сообщающий отправителю, что письмо сейчас читают, и с какого
 *    адреса (подробности в apps/api/src/logos/routes.ts).
 *
 * 3. Решение «можно ли показать логотип» приняли на сервере. Здесь только
 *    поле `senderLogoDomain` письма: оно не пусто лишь у писем, прошедших
 *    проверку подлинности. Интерфейс это решение не переигрывает.
 */
import { useState } from 'react';
import { useSenderLogo } from './senderLogos';
import styles from './SenderAvatar.module.css';

export interface SenderAvatarProps {
  /** Имя или адрес отправителя — из него берётся буква. */
  name: string;
  /** Адрес отправителя: из него получается цвет кружка. */
  address: string;
  /** Домен, которому разрешён логотип. null — только буква. */
  logoDomain?: string | null | undefined;
  /** Класс кружка от вмещающего списка: размер, форма, шрифт. */
  className?: string | undefined;
  /** Скрыть кружок от чтения с экрана: рядом уже написано имя отправителя. */
  ariaHidden?: boolean;
  /**
   * Красить ли кружок с буквой в цвет, выведенный из адреса.
   *
   * По умолчанию да — так устроены кружки в списке писем и в шапке
   * открытого письма. А в цепочке переписки кружки намеренно СЕРЫЕ, одним
   * цветом из темы: там все письма от одного-двух человек, и разноцветная
   * лесенка выглядела бы пестрее самой переписки. Ставить туда цветной
   * кружок «заодно с логотипами» — это молча переделать чужое оформление.
   */
  tint?: boolean;
}

/** Детерминированный цвет аватара из адреса отправителя. */
export function avatarHue(address: string): number {
  let h = 0;
  for (const ch of address) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Буква в кружке: первая буква имени, а без имени — адреса. */
export function avatarLetter(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export function SenderAvatar({
  name,
  address,
  logoDomain,
  className,
  ariaHidden = true,
  tint = true,
}: SenderAvatarProps) {
  const logo = useSenderLogo(logoDomain);
  /*
   * Картинка приехала, но браузер её не показал (кэш протух, ответ 404 после
   * вытеснения из кэша сервера). Возвращаемся к букве молча: пустой кружок
   * или значок битой картинки в списке писем выглядит поломкой продукта.
   */
  const [broken, setBroken] = useState(false);
  const showLogo = logo.status === 'ready' && !broken;

  return (
    <span
      className={[className, showLogo ? styles.withLogo : null].filter(Boolean).join(' ')}
      style={
        showLogo || !tint ? undefined : { backgroundColor: `hsl(${avatarHue(address)} 60% 55%)` }
      }
      aria-hidden={ariaHidden || undefined}
    >
      {showLogo ? (
        <img
          className={styles.logo}
          src={logo.url}
          // Пустое alt намеренно: имя отправителя написано рядом обычным
          // текстом, и второй раз проговаривать его чтением с экрана — шум.
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <span className={styles.letter}>{avatarLetter(name)}</span>
      )}
    </span>
  );
}
