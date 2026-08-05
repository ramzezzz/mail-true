/**
 * Маршруты админки. Пока сессия не загружена — спиннер; без сессии —
 * страница входа. Доступность разделов дублирует серверные права,
 * но настоящая проверка всё равно на сервере.
 */
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AdminLayout, CenteredSpinner } from './AdminLayout';
import { useSession } from './session';
import { LoginPage } from '../pages/LoginPage';
import { OverviewPage } from '../pages/OverviewPage';
import { UsersPage } from '../pages/UsersPage';
import { ImportPage } from '../pages/ImportPage';
import { AliasesPage } from '../pages/AliasesPage';
import { DomainsPage } from '../pages/DomainsPage';
import { AiPage } from '../pages/AiPage';
import { AuditPage } from '../pages/AuditPage';
import { MailboxPage } from '../pages/MailboxPage';
import { FlowPage } from '../pages/FlowPage';
import { LogsPage } from '../pages/LogsPage';
import { StubPage } from '../pages/StubPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AdminLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'users/import', element: <ImportPage /> },
      { path: 'aliases', element: <AliasesPage /> },
      { path: 'domains', element: <DomainsPage /> },
      { path: 'ai', element: <AiPage /> },
      { path: 'mailbox', element: <MailboxPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'flow', element: <FlowPage /> },
      { path: 'logs', element: <LogsPage /> },
      { path: 'spam', element: <StubPage id="spam" /> },
      { path: 'monitoring', element: <StubPage id="monitoring" /> },
      { path: 'backups', element: <StubPage id="backups" /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function AppRoutes() {
  const { session, loading } = useSession();
  if (loading) return <CenteredSpinner />;
  if (!session) return <LoginPage />;
  return <RouterProvider router={router} />;
}
