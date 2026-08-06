/**
 * Справка по горячим клавишам — окно по нажатию «?».
 *
 * Содержимое берётся из HOTKEY_HELP рядом с самим разбором клавиш, а не
 * переписывается здесь: справка, живущая отдельно от поведения, расходится
 * с ним на первой же новой клавише.
 *
 * Клавиши показаны как клавиши (<kbd>), а не как текст в кавычках: так
 * видно, что нажимать вместе, а что подряд.
 */

import { Modal } from '../components';
import { HOTKEY_HELP } from '../lib/hotkeys';
import styles from './HotkeysHelp.module.css';

export function HotkeysHelp({ onClose }: { onClose(): void }) {
  return (
    <Modal title="Горячие клавиши" onClose={onClose} className={styles.card}>
      <div className={styles.columns}>
        {HOTKEY_HELP.map((section) => (
          <section key={section.title} className={styles.section}>
            <h3 className={styles.sectionTitle}>{section.title}</h3>
            <dl className={styles.list}>
              {section.items.map((item) => (
                <div key={item.action} className={styles.row}>
                  <dt className={styles.keys}>
                    {item.keys.map((key, index) => (
                      <span key={key}>
                        {/* Плюс только там, где клавиши жмут вместе: «↑ + ↓»
                            обещало бы сочетание, которого не существует. */}
                        {index > 0 && item.combo !== false && (
                          <span className={styles.plus}>+</span>
                        )}
                        {index > 0 && item.combo === false && ' '}
                        <kbd className={styles.key}>{key}</kbd>
                      </span>
                    ))}
                  </dt>
                  <dd className={styles.action}>{item.action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className={styles.note}>
        Буквенная клавиша определяется по своему месту на клавиатуре, поэтому
        работает и в русской раскладке. Пока курсор стоит в поле ввода, клавиши
        принадлежат полю.
      </p>
    </Modal>
  );
}
