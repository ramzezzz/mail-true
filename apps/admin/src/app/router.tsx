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
import { UserSettingsPage } from '../pages/UserSettingsPage';
import { SignatureBulkPage } from '../pages/SignatureBulkPage';
import { AliasesPage } from '../pages/AliasesPage';
import { DomainsPage } from '../pages/DomainsPage';
import { AiPage } from '../pages/AiPage';
import { AuditPage } from '../pages/AuditPage';
import { MailboxPage } from '../pages/MailboxPage';
import { FlowPage } from '../pages/FlowPage';
import { LogsPage } from '../pages/LogsPage';
import { BrandingPage } from '../pages/BrandingPage';
import { SenderLogosPage } from '../pages/SenderLogosPage';
import { BackupPage } from '../pages/BackupPage';
import { MigratePage } from '../pages/MigratePage';
import { UpdatesPage } from '../pages/UpdatesPage';
import { DomainChangePage } from '../pages/DomainChangePage';
import { SpamPage } from '../pages/SpamPage';
import { MonitoringPage } from '../pages/MonitoringPage';
import { ServerSettingsPage } from '../pages/ServerSettingsPage';
import { TlsPage } from '../pages/TlsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AdminLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'users/import', element: <ImportPage /> },
      // Подписи по шаблону объявлены ДО 'users/:id/settings' и с более
      // конкретным путём: иначе «signatures» приняли бы за номер ящика.
      { path: 'users/signatures', element: <SignatureBulkPage /> },
      { path: 'users/:id/settings', element: <UserSettingsPage /> },
      { path: 'aliases', element: <AliasesPage /> },
      { path: 'domains', element: <DomainsPage /> },
      { path: 'ai', element: <AiPage /> },
      { path: 'mailbox', element: <MailboxPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'flow', element: <FlowPage /> },
      { path: 'logs', element: <LogsPage /> },
      // Оформление входа (OEM) и резервные копии настроек: заглушками
      // эти разделы больше не являются.
      { path: 'branding', element: <BrandingPage /> },
      // Логотипы доменов отправителей: что видно в кружке рядом с письмом
      { path: 'sender-logos', element: <SenderLogosPage /> },
      { path: 'backups', element: <BackupPage /> },
      // Перенос почты с чужого сервера (Kerio Connect и прочие)
      { path: 'migrate', element: <MigratePage /> },
      { path: 'updates', element: <UpdatesPage /> },
      // Смена основного домена сервера: план и выполнение
      { path: 'domain-change', element: <DomainChangePage /> },
      // Антиспам и исправность сервера. Заглушками эти разделы больше
      // не являются: за ними стоят контроллер rspamd и живые пробы служб.
      { path: 'spam', element: <SpamPage /> },
      { path: 'monitoring', element: <MonitoringPage /> },
      // Настройки сервера: то, что раньше правили в infra/.env руками
      { path: 'server-settings', element: <ServerSettingsPage /> },
      // Сертификат: какой TLS стоит сейчас и замена его на свой
      { path: 'tls', element: <TlsPage /> },
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
