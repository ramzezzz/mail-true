/**
 * Главная страница настроек — плитка карточек-ссылок на разделы,
 * как `/settings` у mail.ru.
 */

import { Link } from 'react-router-dom';
import { useAiState } from '../../api/aiQueries';
import { AI_SETTINGS_PATH, aiVisible } from '../../ai/aiVisibility';
import { IconChevronRight } from '../../mail/icons';
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
    text: 'Имя отправителя и подпись, автоответчик, уведомления, поведение после удаления',
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

export function SettingsHomePage() {
  const { data: aiState } = useAiState();
  const cards = aiVisible(aiState)
    ? [
        ...CARDS,
        {
          to: AI_SETTINGS_PATH,
          title: 'Помощник на основе ИИ',
          text: 'Согласие, набор возможностей и расход средств',
        },
      ]
    : CARDS;

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
