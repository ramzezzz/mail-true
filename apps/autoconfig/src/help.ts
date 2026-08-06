/**
 * Страница помощи для ручной настройки почтовых клиентов:
 * человекочитаемая таблица серверов, портов и шифрования.
 */
import type { MailSettings } from './config.js';
import { escapeHtml } from './xml.js';

export function buildHelpPage(settings: MailSettings): string {
  const e = escapeHtml;
  const host = e(settings.hostname);
  const domain = e(settings.domain);
  const name = e(settings.providerName);
  const rows: Array<[string, string, number, string]> = [
    ['Входящая почта (IMAP, рекомендуется)', host, settings.imap.sslPort, 'SSL/TLS'],
    ['Входящая почта (IMAP)', host, settings.imap.startTlsPort, 'STARTTLS'],
    ['Входящая почта (POP3)', host, settings.pop3.sslPort, 'SSL/TLS'],
    ['Входящая почта (POP3)', host, settings.pop3.startTlsPort, 'STARTTLS'],
    ['Исходящая почта (SMTP, рекомендуется)', host, settings.smtp.startTlsPort, 'STARTTLS'],
    ['Исходящая почта (SMTP)', host, settings.smtp.sslPort, 'SSL/TLS'],
  ];
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — настройка почтовых программ</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f4f5f7; color: #1a1a1a; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  p.lead { color: #555; margin: 0 0 24px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); padding: 20px 24px; margin-bottom: 20px; }
  h2 { font-size: 18px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eceff2; }
  th { color: #777; font-weight: 600; }
  td code, li code { background: #f0f2f5; border-radius: 4px; padding: 1px 6px; font-size: 13px; }
  ul { margin: 8px 0 0; padding-left: 20px; }
  li { margin: 4px 0; }
  a.btn { display: inline-block; background: #005ff9; color: #fff; text-decoration: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; margin-top: 8px; }
  .muted { color: #777; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Настройка почтовых программ ${name}</h1>
  <p class="lead">Современные клиенты (Thunderbird, Outlook, Apple Mail) настраиваются автоматически —
  достаточно ввести адрес <code>имя@${domain}</code> и пароль. Ниже — параметры для ручной настройки.</p>

  <div class="card">
    <h2>Серверы и порты</h2>
    <table>
      <tr><th>Назначение</th><th>Сервер</th><th>Порт</th><th>Шифрование</th></tr>
      ${rows
        .map(
          ([what, h, port, enc]) =>
            `<tr><td>${what}</td><td><code>${h}</code></td><td><code>${port}</code></td><td>${enc}</td></tr>`,
        )
        .join('\n      ')}
    </table>
    <ul>
      <li>Имя пользователя — полный адрес: <code>имя@${domain}</code></li>
      <li>Пароль — тот же, что и для веб-почты</li>
      <li>Аутентификация — обычный пароль; для SMTP аутентификация обязательна</li>
    </ul>
  </div>

  <div class="card">
    <h2>iPhone, iPad и Mac</h2>
    <p class="muted">Скачайте профиль конфигурации — учётная запись появится автоматически
    (подставьте свой адрес в ссылку).</p>
    <a class="btn" href="/mobileconfig?email=user@${domain}">Скачать профиль .mobileconfig</a>
  </div>

  <div class="card">
    <h2>Служебные адреса автонастройки</h2>
    <ul>
      <li>Thunderbird: <code>http://autoconfig.${domain}/mail/config-v1.1.xml</code></li>
      <li>Outlook: <code>https://autodiscover.${domain}/autodiscover/autodiscover.xml</code></li>
      <li>DNS-записи для администратора: <code>/api/dns-records?domain=${domain}</code>,
          проверка публикации: <code>/api/dns-check?domain=${domain}</code></li>
    </ul>
  </div>
</div>
</body>
</html>
`;
}
