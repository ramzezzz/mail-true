/**
 * Mozilla Autoconfig — формат clientConfig версии 1.1.
 * Его запрашивают Thunderbird, K-9 Mail, FairEmail, Evolution и другие.
 *
 * Формат строгий: порядок элементов внутри *Server фиксирован
 * (hostname, port, socketType, username, authentication); при любой ошибке
 * клиент молча отбрасывает ответ. Плейсхолдер %EMAILADDRESS% клиент
 * подставляет сам.
 */
import type { MailSettings } from './config.js';
import { escapeXml } from './xml.js';

interface ServerBlock {
  kind: 'incomingServer' | 'outgoingServer';
  type: 'imap' | 'pop3' | 'smtp';
  hostname: string;
  port: number;
  socketType: 'SSL' | 'STARTTLS' | 'plain';
}

function serverXml(s: ServerBlock): string {
  return [
    `    <${s.kind} type="${s.type}">`,
    `      <hostname>${escapeXml(s.hostname)}</hostname>`,
    `      <port>${s.port}</port>`,
    `      <socketType>${s.socketType}</socketType>`,
    `      <username>%EMAILADDRESS%</username>`,
    `      <authentication>password-cleartext</authentication>`,
    `    </${s.kind}>`,
  ].join('\n');
}

/**
 * Формирует XML clientConfig.
 *
 * ------------------------------------------------------------------
 * ПРО ВТОРОЙ <domain>
 * ------------------------------------------------------------------
 * Домен из запрошенного адреса добавлялся вторым элементом БЕЗ ВСЯКОЙ
 * проверки — то есть на вопрос «а ты обслуживаешь example.org?» сервер
 * отвечал «да», ничего об этом домене не зная. Выдача утверждала то,
 * чего не знает, и почтовая программа настраивалась на наш сервер для
 * чужого домена.
 *
 * Подтверждаем только то, что подтверждено владельцем домена: к нам
 * обратились ПО ЭТОМУ ДОМЕНУ (autoconfig.его-домен ведёт сюда, значит
 * запись в DNS сделал он сам). Это и есть законный случай алиасного
 * домена, ради которого второй элемент и появился.
 */
export function buildClientConfigXml(
  settings: MailSettings,
  emailAddress?: string,
  /** Домен, по которому к нам пришли: из имени узла в запросе. */
  askedVia?: string,
): string {
  const host = settings.hostname;
  const domains = [settings.domain];
  const requestedDomain = emailAddress?.split('@')[1]?.trim().toLowerCase();
  const confirmed = askedVia?.trim().toLowerCase();
  if (
    requestedDomain &&
    requestedDomain !== settings.domain.toLowerCase() &&
    requestedDomain === confirmed
  ) {
    domains.push(requestedDomain);
  }

  const servers: ServerBlock[] = [
    // Порядок = приоритет для клиента: сначала IMAP по SSL.
    {
      kind: 'incomingServer',
      type: 'imap',
      hostname: host,
      port: settings.imap.sslPort,
      socketType: 'SSL',
    },
    {
      kind: 'incomingServer',
      type: 'imap',
      hostname: host,
      port: settings.imap.startTlsPort,
      socketType: 'STARTTLS',
    },
    {
      kind: 'incomingServer',
      type: 'pop3',
      hostname: host,
      port: settings.pop3.sslPort,
      socketType: 'SSL',
    },
    {
      kind: 'incomingServer',
      type: 'pop3',
      hostname: host,
      port: settings.pop3.startTlsPort,
      socketType: 'STARTTLS',
    },
    // Исходящая почта. Первый outgoingServer клиент берёт как основной,
    // поэтому порядок менять нельзя: 587 + STARTTLS работает везде и
    // остаётся выбором по умолчанию. Порт 465 идёт вторым — он нужен тем
    // клиентам, которые «TLS сразу» предпочитают или умеют только его.
    // Раньше 465 не назывался вовсе, хотя Postfix его слушает
    // (infra/postfix/conf/master.cf).
    {
      kind: 'outgoingServer',
      type: 'smtp',
      hostname: host,
      port: settings.smtp.startTlsPort,
      socketType: 'STARTTLS',
    },
    {
      kind: 'outgoingServer',
      type: 'smtp',
      hostname: host,
      port: settings.smtp.sslPort,
      socketType: 'SSL',
    },
  ];

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<clientConfig version="1.1">`,
    `  <emailProvider id="${escapeXml(settings.domain)}">`,
    ...domains.map((d) => `    <domain>${escapeXml(d)}</domain>`),
    `    <displayName>${escapeXml(settings.providerName)}</displayName>`,
    `    <displayShortName>${escapeXml(settings.providerShortName)}</displayShortName>`,
    ...servers.map(serverXml),
    `  </emailProvider>`,
    `</clientConfig>`,
    ``,
  ].join('\n');
}
