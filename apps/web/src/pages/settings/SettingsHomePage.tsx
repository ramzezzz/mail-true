/**
 * Главная страница настроек — плитка карточек-ссылок на разделы,
 * как `/settings` у mail.ru.
 */

import { Link } from 'react-router-dom';
import { useAiState } from '../../api/aiQueries';
import { AI_SETTINGS_PATH, aiVisible } from '../../ai/aiVisibility';
import { IconChevronRight } from '../../mail/icons';
import { useDisposable } from '../../settings/disposableQueries';
import { useAccessLog, useExports, useRecovery } from '../../settings/ownerQueries';
import { SettingsTitle } from '../../settings/ui';
import styles from './SettingsHomePage.module.css';

interface Card {
  to: string;
  title: string;
  text: string;
}

const CARDS: Card[] = [
  {
    to: '/settings/general',
    title: 'Общие',
    text: 'Имя отправителя и подпись, автоответчик, поведение после удаления письма',
  },
  {
    to: '/settings/notifications',
    title: 'Уведомления',
    text: 'Всплывающие окна о новых письмах: что показывать, когда молчать и как это работает с закрытой вкладкой',
  },
  {
    to: '/settings/appearance',
    title: 'Оформление',
    text: 'Темы интерфейса — светлые, тёмная и цветные, фоновая картинка своя или из набора',
  },
  {
    to: '/settings/filters',
    title: 'Фильтры',
    text: 'Правила фильтрации и пересылки: раскладывать письма по папкам автоматически',
  },
  {
    to: '/settings/folders',
    title: 'Папки',
    text: 'Создание, переименование и очистка папок, счётчики писем',
  },
  {
    to: '/settings/collector',
    title: 'Почта с других ящиков',
    text: 'Сбор писем с любого сервера по IMAP или POP3',
  },
];

/**
 * Карточки трёх разделов владельца ящика.
 *
 * Показываются по тому же правилу, что и пункты меню: пока сервер не
 * сказал `available`, карточки нет. Ведущая в никуда плитка на главной
 * хуже отсутствующей — на неё нажимают чаще, чем на пункт меню.
 */
const RECOVERY_CARD: Card = {
  to: '/settings/recovery',
  title: 'Восстановление писем',
  text: 'Вернуть письма после очистки корзины и решить, сколько их хранить',
};

const ACCESS_CARD: Card = {
  to: '/settings/access-log',
  title: 'Вход и действия',
  text: 'Кто и откуда заходил в ящик — через браузер, почтовую программу и при отправке',
};

const EXPORT_CARD: Card = {
  to: '/settings/export',
  title: 'Выгрузка ящика',
  text: 'Забрать всю переписку одним архивом: папки каталогами, письма файлами .eml',
};

const DISPOSABLE_CARD: Card = {
  to: '/settings/disposable',
  title: 'Одноразовые адреса',
  text: 'Адрес для сайта вместо основного — выключается одним нажатием, когда пойдёт спам',
};

export function SettingsHomePage() {
  const { data: aiState } = useAiState();
  const access = useAccessLog();
  const exports = useExports();
  const recovery = useRecovery();
  const disposable = useDisposable();

  const owner = [
    ...(recovery.available ? [RECOVERY_CARD] : []),
    ...(disposable.available ? [DISPOSABLE_CARD] : []),
    ...(access.available ? [ACCESS_CARD] : []),
    ...(exports.available ? [EXPORT_CARD] : []),
  ];
  const withOwner = [...CARDS, ...owner];
  const cards = aiVisible(aiState)
    ? [
        ...withOwner,
        {
          to: AI_SETTINGS_PATH,
          title: 'Помощник на основе ИИ',
          text: 'Согласие, набор возможностей и расход средств',
        },
      ]
    : withOwner;

  return (
    <>
      <SettingsTitle>Настройки</SettingsTitle>
      <div className={styles.grid}>
        {cards.map((card) => (
          <Link key={card.to} to={card.to} className={styles.card}>
            <span className={styles.cardTitle}>
              {card.title}
              <span className={styles.cardArrow}>
                <IconChevronRight />
              </span>
            </span>
            <span className={styles.cardText}>{card.text}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
