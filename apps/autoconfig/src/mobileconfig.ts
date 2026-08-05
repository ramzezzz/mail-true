/**
 * Профиль конфигурации Apple (.mobileconfig) — XML plist с полезной нагрузкой
 * com.apple.mail.managed. Пользователь открывает файл на iPhone/Mac,
 * подтверждает установку и получает готовую учётную запись почты.
 *
 * UUID должны быть стабильными для одного и того же ящика, иначе повторная
 * установка создаст дубликат профиля — выводим их детерминированно из адреса.
 */
import { createHash } from 'node:crypto';
import type { MailSettings } from './config.js';
import { escapeXml } from './xml.js';

/** Детерминированный UUID (по мотивам v5) из произвольной строки. */
export function stableUuid(input: string): string {
  const h = createHash('sha1').update(`mail-true-autoconfig:${input}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    // версия 5, вариант RFC 4122
    '5' + h.slice(13, 16),
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + h.slice(18, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Идентификатор в обратной DNS-нотации: mail.local -> local.mail */
function reverseDomain(domain: string): string {
  return domain.split('.').reverse().join('.');
}

export function buildMobileConfig(settings: MailSettings, email: string): string {
  const rd = reverseDomain(settings.domain);
  const accountName = email.split('@')[0] ?? email;
  const e = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>EmailAccountDescription</key>
      <string>${e(settings.providerName)}</string>
      <key>EmailAccountName</key>
      <string>${e(accountName)}</string>
      <key>EmailAccountType</key>
      <string>EmailTypeIMAP</string>
      <key>EmailAddress</key>
      <string>${e(email)}</string>
      <key>IncomingMailServerAuthentication</key>
      <string>EmailAuthPassword</string>
      <key>IncomingMailServerHostName</key>
      <string>${e(settings.hostname)}</string>
      <key>IncomingMailServerPortNumber</key>
      <integer>${settings.imap.sslPort}</integer>
      <key>IncomingMailServerUseSSL</key>
      <true/>
      <key>IncomingMailServerUsername</key>
      <string>${e(email)}</string>
      <key>OutgoingMailServerAuthentication</key>
      <string>EmailAuthPassword</string>
      <key>OutgoingMailServerHostName</key>
      <string>${e(settings.hostname)}</string>
      <key>OutgoingMailServerPortNumber</key>
      <integer>${settings.smtp.startTlsPort}</integer>
      <key>OutgoingMailServerUseSSL</key>
      <true/>
      <key>OutgoingMailServerUsername</key>
      <string>${e(email)}</string>
      <key>OutgoingPasswordSameAsIncomingPassword</key>
      <true/>
      <key>PayloadDescription</key>
      <string>Учётная запись почты ${e(settings.providerName)}</string>
      <key>PayloadDisplayName</key>
      <string>${e(settings.providerName)} — ${e(email)}</string>
      <key>PayloadIdentifier</key>
      <string>${e(rd)}.mailprofile.${stableUuid(`payload:${email}`)}</string>
      <key>PayloadType</key>
      <string>com.apple.mail.managed</string>
      <key>PayloadUUID</key>
      <string>${stableUuid(`payload:${email}`)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PreventAppSheet</key>
      <false/>
      <key>PreventMove</key>
      <false/>
      <key>SMIMEEnabled</key>
      <false/>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Настройки почты ${e(settings.providerName)} для ${e(email)}</string>
  <key>PayloadDisplayName</key>
  <string>${e(settings.providerName)} (${e(email)})</string>
  <key>PayloadIdentifier</key>
  <!-- Идентификатор профиля обязан быть СВОИМ у каждого ящика: iOS и macOS
       считают профили с одинаковым PayloadIdentifier одним и тем же и
       ЗАМЕНЯЮТ ранее установленный. С константой здесь установка профиля
       для второго ящика того же сервера сносила первый вместо добавления. -->
  <string>${e(rd)}.mailprofile.${stableUuid(`profile:${email}`)}</string>
  <key>PayloadOrganization</key>
  <string>${e(settings.providerName)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${stableUuid(`profile:${email}`)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
