/**
 * Проволочный глобус на странице входа.
 *
 * Перенесено из прототипа `login_page/`. Сфера собрана из плоских колец,
 * повёрнутых в трёх измерениях: шесть меридианов и пять параллелей. Вокруг
 * по окружности расставлены значки — у нас это значки почты из фирменного
 * спрайта, а не сетевого оборудования, как было в прототипе.
 *
 * Кольца и узлы считаются здесь, а не записаны в разметке: их два десятка,
 * и руками такое держать в согласии невозможно.
 */
import styles from './LoginBackdrop.module.css';

const SPRITE = '/brand/icons/sprite.svg';

/** Меридианы: вертикальные кольца, равномерно повёрнутые вокруг оси. */
const MERIDIANS = 6;

/** Параллели: горизонтальные кольца, поднятые вдоль оси и сжатые к полюсам. */
const PARALLELS = [-55, -28, 0, 28, 55];

/**
 * Значки вокруг глобуса — то, чем занимается почта: получить, отправить,
 * написать, ответить, найти, вложить, пометить, настроить.
 */
const ORBIT_ICONS = [
  'folder-inbox',
  'folder-sent',
  'compose',
  'reply',
  'search',
  'attach',
  'label',
  'settings',
] as const;

/** Радиус расстановки значков в долях от половины стороны. */
const ORBIT_RADIUS = 44;

export function LoginGlobe() {
  return (
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

        {/* Светящийся узел в центре — марка Mail.True */}
        <div className={`${styles.node} ${styles.nodeCenter}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href={`${SPRITE}#icon-folder-inbox`} />
          </svg>
        </div>

        <div className={styles.orbit}>
          {ORBIT_ICONS.map((name, i) => {
            const angle = ((-90 + i * (360 / ORBIT_ICONS.length)) * Math.PI) / 180;
            const x = 50 + Math.cos(angle) * ORBIT_RADIUS;
            const y = 50 + Math.sin(angle) * ORBIT_RADIUS;
            return (
              <div
                key={name}
                className={styles.node}
                style={{ left: `calc(${String(x)}% - 1.55rem)`, top: `calc(${String(y)}% - 1.55rem)` }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href={`${SPRITE}#icon-${name}`} />
                </svg>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
