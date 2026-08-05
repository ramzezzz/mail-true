/**
 * Маршруты повторяют адресацию mail.ru:
 *   /login                     — вход в ящик;
 *   /<folderId>/               — список писем папки (системные — по имени,
 *                                пользовательские — по числовому id);
 *   /<folderId>/<messageId>    — просмотр письма;
 *   /compose                   — новое письмо (пока страница-заглушка);
 *   /search/?q_query=<запрос>  — поиск с фасетными фильтрами;
 *   /settings/*                — настройки, СВОЙ каркас (светлая тема,
 *                                карточки, простая шапка).
 *
 * Порядок важен: постоянные адреса объявлены ДО `:folderId`, иначе
 * шаблон папки проглотит их как имя папки.
 *
 * Всё, кроме входа, закрыто проверкой сессии: без неё пользователь видел
 * пустой список и невнятную ошибку вместо просьбы войти.
 */

import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';
import { MailNotifications } from './MailNotifications';
import { SessionProvider, useSession } from './session';
import { AppLayout } from '../layout/AppLayout';
import { Spinner } from '../components';
import { AiSettingsPage } from '../pages/AiSettingsPage';
import { ComposePage } from '../pages/ComposePage';
import { FolderPage } from '../pages/FolderPage';
import { LoginPage } from '../pages/LoginPage';
import { MessagePage } from '../pages/MessagePage';
import { SearchPage } from '../pages/SearchPage';
import { CollectorPage } from '../pages/settings/CollectorPage';
import { FiltersPage } from '../pages/settings/FiltersPage';
import { FoldersPage } from '../pages/settings/FoldersPage';
import { GeneralSettingsPage } from '../pages/settings/GeneralSettingsPage';
import { SettingsHomePage } from '../pages/settings/SettingsHomePage';
import { SettingsLayout } from '../settings/SettingsLayout';

export const LOGIN_PATH = '/login';

/** Пока сессия не загружена — спиннер; без сессии — экран входа. */
function SessionGate() {
  const { session, loading } = useSession();
  const location = useLocation();
  const atLogin = location.pathname === LOGIN_PATH;

  if (loading) {
    return (
      <div className="mt-center-screen">
        <Spinner size={28} />
      </div>
    );
  }
  if (!session) return atLogin ? <Outlet /> : <Navigate to={LOGIN_PATH} replace />;
  if (atLogin) return <Navigate to="/inbox/" replace />;
  return (
    <>
      {/* Уведомления о новой почте и счётчик во вкладке — на всех страницах
          вошедшего пользователя, включая настройки: у настроек свой каркас,
          и внутри AppLayout счётчик пропадал бы, стоило туда зайти */}
      <MailNotifications />
      <Outlet />
    </>
  );
}

/** Корень дерева: провайдер сессии живёт внутри роутера, чтобы видеть адрес. */
function Root() {
  return (
    <SessionProvider>
      <SessionGate />
    </SessionProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: LOGIN_PATH.slice(1), element: <LoginPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <SettingsHomePage /> },
          { path: 'general', element: <GeneralSettingsPage /> },
          { path: 'filters', element: <FiltersPage /> },
          { path: 'folders', element: <FoldersPage /> },
          { path: 'collector', element: <CollectorPage /> },
          { path: 'ai', element: <AiSettingsPage /> },
        ],
      },
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <Navigate to="/inbox/" replace /> },
          { path: 'compose', element: <ComposePage /> },
          { path: 'search', element: <SearchPage /> },
          { path: ':folderId', element: <FolderPage /> },
          { path: ':folderId/:messageId', element: <MessagePage /> },
        ],
      },
    ],
  },
]);
