/**
 * Проволочная сфера на странице входа.
 *
 * Перенесено из прототипа `login_page/`. Сцена состоит из трёх частей, и
 * разделены они не для красоты:
 *
 *  - ВРАЩАЮЩАЯСЯ сфера: кольца-меридианы и светящиеся шары. Оба семейства
 *    лежат внутри одного наклонённого куба (`rotateX(61deg) rotateY(-16deg)`),
 *    который крутится вокруг своей оси за минуту. Шары живут в плоскостях
 *    колец и обходят их по кругу — оттого и кажется, что они бегут по
 *    проволоке, а не летают сами по себе;
 *  - НЕПОДВИЖНЫЙ слой поверх неё: значки и узел в середине. Раньше значки
 *    крутились вместе со сферой, и приходилось разворачивать каждый обратно,
 *    чтобы они не вставали вверх ногами. Теперь они просто не вращаются:
 *    меньше движущихся элементов и ни одного встречного вращения;
 *  - свечение под сферой (`aura`), которое ничего не делает.
 *
 * Кольца, шары и значки считаются здесь, а не записаны в разметке: их больше
 * трёх десятков, и руками такое в согласии не удержать.
 *
 * Компонент общий для почты и панели управления. Меняются только значки
 * (свойства `icons` и `center`) и цвета — цвета приходят переменными CSS,
 * которые страница ставит на себя (см. admin/pages/login/loginPalette.ts).
 */
import { Fragment } from 'react';
import { pausedAttr, usePageVisible } from './usePageVisible';
import styles from './LoginBackdrop.module.css';

/** Один значок сцены: чем его рисовать и как его звать. */
export interface LoginGlobeIcon {
  /** Ключ для React и для проверок. */
  id: string;
  /** Адрес символа для `<use href>`: файл спрайта или символ на странице. */
  href: string;
}

/** Фирменный спрайт почты. */
const SPRITE = '/brand/icons/sprite.svg';

/**
 * Значки вокруг сферы на входе в почту — то, чем занимается почта: получить,
 * отправить, написать, ответить, найти, вложить, пометить, настроить.
 */
export const MAIL_GLOBE_ICONS: readonly LoginGlobeIcon[] = [
  'folder-inbox',
  'folder-sent',
  'compose',
  'reply',
  'search',
  'attach',
  'label',
  'settings',
].map((name) => ({ id: name, href: `${SPRITE}#icon-${name}` }));

/**
 * Знак в середине сферы — фирменный, а не ещё одна папка.
 *
 * Раньше в середине стоял значок «Входящие»: тот же символ, что и на
 * орбите вокруг, только крупнее. Середина сцены — самое заметное место
 * страницы входа, и занимать его повтором соседнего значка незачем.
 *
 * Здесь адрес ФАЙЛА, а не символа спрайта (в нём нет «#»), и рисуется он
 * картинкой: знак цветной — синий квадрат с белой галочкой, — а символы
 * спрайта одноцветные и красятся currentColor.
 */
export const MAIL_GLOBE_CENTER: LoginGlobeIcon = {
  id: 'brand-mark',
  href: '/brand/mark.svg',
};

/**
 * Колец на каждую ось. Всего их вдвое больше: одно семейство повёрнуто
 * вокруг X, другое вокруг Y, и вместе они читаются как сетка параллелей и
 * меридианов.
 *
 * В прототипе стоит восемь (шестнадцать колец). У нас шесть — двенадцать
 * колец. Причина посчитана, а не выдумана: на живом стенде 1440×900 при
 * замедлении процессора в шесть раз двенадцать колец давали 67.7 кадра в
 * секунду, шестнадцать — 58.7, то есть кадр удлинялся на 2.3 мс (около
 * 0.4 мс на обычной машине). Сама сфера при этом стоит примерно 0.3 мс на
 * кадр — четыре лишних кольца УДВАИВАЛИ её цену. На глаз двенадцать от
 * шестнадцати не отличить: сфера и так читается сплошной сеткой.
 */
const RINGS_PER_AXIS = 6;

/** Сколько светящихся шаров бегает по кольцам. */
const BALLS = 5;

/** Радиус расстановки значков в долях от половины стороны. */
const ORBIT_RADIUS = 45;

export interface LoginGlobeProps {
  /** Значки вокруг сферы. По умолчанию — почтовые. */
  icons?: readonly LoginGlobeIcon[];
  /** Знак в середине. */
  center?: LoginGlobeIcon;
}

export function LoginGlobe({
  icons = MAIL_GLOBE_ICONS,
  center = MAIL_GLOBE_CENTER,
}: LoginGlobeProps = {}) {
  const visible = usePageVisible();

  return (
    <div
      className={styles.stage}
      aria-hidden="true"
      // Пауза ставится на всю сцену разом: остановить каждую анимацию
      // по отдельности из кода значило бы держать ссылки на все элементы.
      data-paused={pausedAttr(visible)}
    >
      <div className={styles.aura} />

      {/* Вращающаяся часть: проволока и шары на ней */}
      <div className={styles.globe}>
        <div className={styles.rings}>
          {Array.from({ length: RINGS_PER_AXIS }, (_, i) => {
            const angle = `${String((i * 180) / RINGS_PER_AXIS)}deg`;
            // Первое кольцо каждого семейства ярче: без него сфера читается
            // как ровный шум, а с ним видно, где у неё «экватор».
            const bright = i === 0 ? ` ${styles.ringBright}` : '';
            return (
              // Именно Fragment, а не общий div: любой промежуточный элемент
              // без preserve-3d расплющил бы кольца в одну плоскость, и
              // сферы не получилось бы вовсе.
              <Fragment key={`ring${String(i)}`}>
                <div
                  className={`${styles.ring}${bright}`}
                  style={{ '--mt-ring-x': angle } as React.CSSProperties}
                />
                <div
                  className={`${styles.ring}${bright}`}
                  style={{ '--mt-ring-y': angle } as React.CSSProperties}
                />
              </Fragment>
            );
          })}
        </div>

        <div className={styles.balls}>
          {Array.from({ length: BALLS }, (_, i) => {
            // Шар кладём в плоскость одного из колец — тогда он бежит ровно
            // по проволоке. Чётные берут семейство X, нечётные — семейство Y.
            const angle = `${String((((i * 2 + 1) % RINGS_PER_AXIS) * 180) / RINGS_PER_AXIS)}deg`;
            const plane = i % 2 === 0 ? '--mt-ring-x' : '--mt-ring-y';
            return (
              <div
                key={`ball${String(i)}`}
                className={styles.ballPlane}
                style={{ [plane]: angle } as React.CSSProperties}
              >
                {/* Отрицательная задержка — это старт с середины круга:
                    шары не выстраиваются в одну точку при загрузке. */}
                <div
                  className={styles.ballOrbit}
                  style={
                    {
                      '--mt-ball-duration': `${String(9 + i * 2.1)}s`,
                      '--mt-ball-delay': `${String(-i * 2.7)}s`,
                    } as React.CSSProperties
                  }
                >
                  <div className={styles.ball} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Неподвижный слой: значки и середина не вращаются со сферой */}
      <div className={styles.fxLayer}>
        <div className={styles.orbit}>
          {icons.map((icon, i) => {
            const angle = ((-90 + i * (360 / icons.length)) * Math.PI) / 180;
            const x = 50 + Math.cos(angle) * ORBIT_RADIUS;
            const y = 50 + Math.sin(angle) * ORBIT_RADIUS;
            return (
              // Увеличение при наведении держит обёртка (переход по transform),
              // а дыхание — кружок внутри (анимация). Порознь потому, что
              // одно свойство не может одновременно вести переход и анимацию:
              // раньше значок при наведении прыгал скачком.
              <div
                key={icon.id}
                className={styles.nodeWrap}
                style={{
                  left: `calc(${String(x)}% - 1.55rem)`,
                  top: `calc(${String(y)}% - 1.55rem)`,
                }}
              >
                <div
                  className={styles.node}
                  style={
                    {
                      // Разная задержка и разная длительность: иначе восемь
                      // значков дышат в такт, и это читается как мигание.
                      '--mt-node-delay': `${String(i * 0.34)}s`,
                      '--mt-node-duration': `${String(2.4 + (i % 3) * 0.4)}s`,
                    } as React.CSSProperties
                  }
                >
                  <span className={styles.nodeIcon}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href={icon.href} />
                    </svg>
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className={`${styles.node} ${styles.nodeCenter}`}>
          {/* Файл — картинкой, символ спрайта — через <use>: у фирменного
              знака свои цвета, и одноцветный currentColor его бы стёр. */}
          {center.href.includes('#') ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href={center.href} />
            </svg>
          ) : (
            <img className={styles.centerImage} src={center.href} alt="" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
