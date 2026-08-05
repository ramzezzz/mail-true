/**
 * Известные почтовые службы для мастера сбора почты.
 *
 * Кнопки повторяют mail.ru (research/mailru/08-collector.png): Яндекс, Gmail,
 * Yahoo, Outlook и «Другая почта» для ручной настройки. Для известных служб
 * адреса серверов подставляются сами — вводить их руками пользователь не
 * должен, а угадывать по домену ненадёжно.
 *
 * Автоопределение по домену для остальных ящиков — задача сервера
 * (docs/autoconfig.md), здесь только частые случаи.
 */

import type { CollectorProtocol } from '../api/settingsTypes';

export interface CollectorProvider {
  id: string;
  title: string;
  /** Домены, по которым служба узнаётся из введённого адреса. */
  domains: string[];
  protocol: CollectorProtocol;
  host: string;
  port: number;
  secure: boolean;
  /** Служба требует пароль приложения, а не основной пароль от аккаунта. */
  appPasswordHint?: string;
}

export const COLLECTOR_PROVIDERS: readonly CollectorProvider[] = [
  {
    id: 'yandex',
    title: 'Яндекс',
    domains: ['yandex.ru', 'yandex.com', 'ya.ru'],
    protocol: 'imap',
    host: 'imap.yandex.ru',
    port: 993,
    secure: true,
    appPasswordHint: 'Для Яндекса нужен пароль приложения, а не пароль от аккаунта.',
  },
  {
    id: 'gmail',
    title: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    protocol: 'imap',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    appPasswordHint: 'Для Gmail нужен пароль приложения и включённый доступ по IMAP.',
  },
  {
    id: 'yahoo',
    title: 'Yahoo',
    domains: ['yahoo.com', 'ymail.com'],
    protocol: 'imap',
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    appPasswordHint: 'Для Yahoo нужен пароль приложения.',
  },
  {
    id: 'outlook',
    title: 'Outlook',
    domains: ['outlook.com', 'hotmail.com', 'live.com'],
    protocol: 'imap',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
  },
  {
    id: 'other',
    title: 'Другая почта',
    domains: [],
    protocol: 'imap',
    host: '',
    port: 993,
    secure: true,
  },
];

/** Служба, узнанная по домену адреса, или «Другая почта». */
export function providerForEmail(email: string): CollectorProvider {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const found = COLLECTOR_PROVIDERS.find((p) => p.domains.includes(domain));
  return found ?? COLLECTOR_PROVIDERS[COLLECTOR_PROVIDERS.length - 1]!;
}

/** Порт по умолчанию: у POP3 он другой, и менять его руками не надо. */
export function defaultPort(protocol: CollectorProtocol, secure: boolean): number {
  if (protocol === 'imap') return secure ? 993 : 143;
  return secure ? 995 : 110;
}
