/**
 * Проволочный глобус на входе в панель управления.
 *
 * Сфера собрана из плоских колец, повёрнутых в трёх измерениях: меридианы
 * и параллели. Растровой картинки нет вовсе — всё рисует браузер.
 *
 * Отличие от глобуса почты не только в цвете: по орбите летают предметы
 * работы администратора — ящики, пользователи, домены, ключи, состояние
 * служб, журнал, копии, квоты, правила, — а не действия с письмом.
 *
 * Кольца и узлы считаются здесь, а не записаны в разметке: их два с лишним
 * десятка, и руками такое в согласии не удержать.
 */
import { ADMIN_CENTER_ICON, ADMIN_ORBIT_ICONS, ICON_PREFIX } from './adminIcons';
import styles from './LoginBackdrop.module.css';

/** Меридианы: вертикальные кольца, равномерно повёрнутые вокруг оси. */
const MERIDIANS = 7;

/** Параллели: горизонтальные кольца, поднятые вдоль оси и сжатые к полюсам. */
const PARALLELS = [-55, -28, 0, 28, 55];

/** Радиус расстановки значков в долях от половины стороны. */
const ORBIT_RADIUS = 44;

export function LoginGlobe() {
  return (
    // Набор значков (AdminIconSprite) вставляет страница входа: глобус на
    // телефоне скрыт целиком, а значок марки на карточке нужен всегда.
    <div className={styles.stage} aria-hidden="true">
      <div className={styles.aura} />
      <div className={styles.globe}>
        <div className={styles.rings}>
          {Array.from({ length: MERIDIANS }, (_, i) => (
            <div
              key={`m${String(i)}`}
              className={`${styles.ring} ${i === 0 ? styles.ringBright : ''}`}
              style={
                {
                  '--mt-ring-x': '80deg',
                  '--mt-ring-y': `${String((i * 180) / MERIDIANS)}deg`,
                } as React.CSSProperties
              }
            />
          ))}
          {PARALLELS.map((deg) => {
            // Кольцо тем меньше, чем ближе к полюсу, и поднято по оси на синус.
            const scale = Math.cos((deg * Math.PI) / 180);
            const lift = Math.sin((deg * Math.PI) / 180) * 17;
            return (
              <div
                key={`p${String(deg)}`}
                className={`${styles.ring} ${deg === 0 ? styles.ringBright : ''}`}
                style={{
                  width: `${String(scale * 100)}%`,
                  height: `${String(scale * 100)}%`,
                  left: `${String((1 - scale) * 50)}%`,
                  top: `${String((1 - scale) * 50)}%`,
                  transform: `translateZ(${String(lift)}rem) rotateX(90deg)`,
                }}
              />
            );
          })}
        </div>

        <div className={`${styles.node} ${styles.nodeCenter}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href={`#${ICON_PREFIX}${ADMIN_CENTER_ICON.id}`} />
          </svg>
        </div>

        <div className={styles.orbit}>
          {ADMIN_ORBIT_ICONS.map((icon, i) => {
            const angle = ((-90 + i * (360 / ADMIN_ORBIT_ICONS.length)) * Math.PI) / 180;
            const x = 50 + Math.cos(angle) * ORBIT_RADIUS;
            const y = 50 + Math.sin(angle) * ORBIT_RADIUS;
            return (
              <div
                key={icon.id}
                className={styles.node}
                style={{ left: `calc(${String(x)}% - 1.55rem)`, top: `calc(${String(y)}% - 1.55rem)` }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href={`#${ICON_PREFIX}${icon.id}`} />
                </svg>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
