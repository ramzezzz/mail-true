/**
 * Microsoft Autodiscover (POX — plain old XML) для Outlook.
 *
 * Outlook шлёт POST с XML-запросом (внутри <EMailAddress>адрес</EMailAddress>)
 * на https://autodiscover.<домен>/autodiscover/autodiscover.xml, причём путь
 * может быть в разном регистре, а некоторые версии/проверки делают GET.
 * Ответ — схема outlook/responseschema/2006a с блоками Protocol.
 */
import type { MailSettings } from './config.js';
import { escapeXml } from './xml.js';

export interface AutodiscoverRequest {
  email: string | null;
  schema: string | null;
}

/**
 * Разбор запроса Outlook. Формат простой, поэтому обходимся без XML-парсера:
 * извлекаем EMailAddress и AcceptableResponseSchema без учёта регистра тегов.
 */
export function parseAutodiscoverRequest(body: string): AutodiscoverRequest {
  const email = /<EMailAddress>\s*([^<]+?)\s*<\/EMailAddress>/i.exec(body)?.[1] ?? null;
  const schema =
    /<AcceptableResponseSchema>\s*([^<]+?)\s*<\/AcceptableResponseSchema>/i.exec(body)?.[1] ??
    null;
  return { email, schema };
}

const RESPONSE_NS = 'http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006';
const OUTLOOK_NS = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a';

interface ProtocolBlock {
  type: 'IMAP' | 'POP3' | 'SMTP';
  server: string;
  port: number;
  /** on = неявный TLS (993/995); для SMTP 587 дополнительно Encryption=TLS (STARTTLS) */
  ssl: 'on' | 'off';
  encryption?: 'TLS' | 'SSL';
  loginName: string;
}

function protocolXml(p: ProtocolBlock): string {
  const lines = [
    `      <Protocol>`,
    `        <Type>${p.type}</Type>`,
    `        <Server>${escapeXml(p.server)}</Server>`,
    `        <Port>${p.port}</Port>`,
    `        <DomainRequired>off</DomainRequired>`,
    `        <LoginName>${escapeXml(p.loginName)}</LoginName>`,
    `        <SPA>off</SPA>`,
    `        <SSL>${p.ssl}</SSL>`,
  ];
  if (p.encryption) lines.push(`        <Encryption>${p.encryption}</Encryption>`);
  lines.push(`        <AuthRequired>on</AuthRequired>`, `      </Protocol>`);
  return lines.join('\n');
}

/** Успешный ответ с настройками IMAP/POP3/SMTP для указанного ящика. */
export function buildAutodiscoverResponse(settings: MailSettings, email: string): string {
  const host = settings.hostname;
  const protocols: ProtocolBlock[] = [
    { type: 'IMAP', server: host, port: settings.imap.sslPort, ssl: 'on', loginName: email },
    { type: 'POP3', server: host, port: settings.pop3.sslPort, ssl: 'on', loginName: email },
    {
      type: 'SMTP',
      server: host,
      port: settings.smtp.startTlsPort,
      ssl: 'on',
      encryption: 'TLS',
      loginName: email,
    },
  ];

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Autodiscover xmlns="${RESPONSE_NS}">`,
    `  <Response xmlns="${OUTLOOK_NS}">`,
    `    <User>`,
    `      <DisplayName>${escapeXml(settings.providerName)}</DisplayName>`,
    `    </User>`,
    `    <Account>`,
    `      <AccountType>email</AccountType>`,
    `      <Action>settings</Action>`,
    ...protocols.map(protocolXml),
    `    </Account>`,
    `  </Response>`,
    `</Autodiscover>`,
    ``,
  ].join('\n');
}

/** Ответ-ошибка по схеме autodiscover (например, когда адрес не передан). */
export function buildAutodiscoverError(errorCode: number, message: string): string {
  const time = new Date().toISOString().slice(11, 19);
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Autodiscover xmlns="${RESPONSE_NS}">`,
    `  <Response>`,
    `    <Error Time="${time}" Id="0">`,
    `      <ErrorCode>${errorCode}</ErrorCode>`,
    `      <Message>${escapeXml(message)}</Message>`,
    `      <DebugData />`,
    `    </Error>`,
    `  </Response>`,
    `</Autodiscover>`,
    ``,
  ].join('\n');
}
