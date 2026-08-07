export * from './appearance.js';
export * from './contacts.js';
export * from './mail.js';
export * from './mailbox-limits.js';
export * from './search.js';
export * from './import-template.js';
export * from './signature-template.js';

/*
 * tls-certificate.js здесь НЕ переэкспортируется намеренно.
 *
 * Этот пакет попадает и в браузерные сборки (apps/web, apps/admin), а разбор
 * сертификата опирается на node:crypto. Один экспорт из этого файла — и
 * сборка почты падает с «X509Certificate is not exported by
 * __vite-browser-external»: разбирается ВЕСЬ ствол, а не то, что кто-то
 * импортировал. Поймано живым прогоном.
 *
 * Кому он нужен (сервер приложения и веб-установщик), тот берёт его
 * отдельным путём:  import … from '@mail-true/shared/tls-certificate'
 */
