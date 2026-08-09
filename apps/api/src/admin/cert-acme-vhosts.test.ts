/**
 * Выпуск сертификата обязан проходить для КАЖДОГО имени, которое мы просим.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * В обязательные имена сертификата входит admin.<домен> (см.
 * expectedCertificateNames), а Let's Encrypt проверяет владение каждым
 * именем отдельно: стучится по HTTP на 80-й порт этого имени и ждёт файл
 * из /.well-known/acme-challenge/.
 *
 * Обслуживал такие запросы только почтовый server-блок. Блок панели
 * перехватывает admin.<домен> точным совпадением имени, и проверка
 * уходила в `location /`, то есть в статику панели: certbot вместо
 * своего токена получал index.html. Провал ОДНОГО имени рушит запрос
 * целиком — сертификат не выпускался вовсе, ни для почты, ни для
 * панели. На установке, где всё остальное настроено верно, человек
 * видел невнятный отказ certbot и не имел ни одной подсказки, куда
 * смотреть.
 *
 * Вторая половина той же ловушки — ADMIN_ACCESS_RULES: список сетей,
 * которым разрешена панель. Серверы Let's Encrypt в него не попадают
 * никогда, поэтому даже правильный location без своего allow отвечал бы
 * им 403.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ПРОВЕРЯЕТСЯ ШАБЛОН, А НЕ КОД
 * ------------------------------------------------------------------
 * Ломается это именно в шаблоне и именно молча: конфигурация остаётся
 * синтаксически верной, nginx поднимается, всё работает — кроме выпуска
 * сертификата, о котором узнают через три месяца, когда прежний истечёт.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectedCertificateNames } from '@mail-true/shared/tls-certificate';

/**
 * ВСЕ шаблоны с блоками на 80-м порту, а не один.
 *
 * Раньше читался только `app.conf.template`, и проверка молча уходила в
 * ветку «умолчание `_`»: имя `autoconfig.<домен>` обслуживает СВОЙ блок в
 * соседнем файле, где ACME-локации не было вовсе. Тест зеленел, а выпуск
 * сертификата из панели не проходил никогда — провал одного имени рушит
 * весь запрос certbot.
 */
const TEMPLATE = ['app.conf.template', 'autoconfig.conf.template']
  .map((name) =>
    readFileSync(
      fileURLToPath(new URL(`../../../../infra/nginx/templates/${name}`, import.meta.url)),
      'utf8',
    ),
  )
  .join('\n');

interface VirtualHost {
  serverName: string;
  body: string;
  listens80: boolean;
}

/** Разбирает шаблон на server-блоки — по отступу закрывающей скобки. */
function virtualHosts(text: string): VirtualHost[] {
  const hosts: VirtualHost[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^server\s*\{/.test(lines[i] ?? '')) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j] ?? ''); j += 1) {
      body.push(lines[j] ?? '');
    }
    const text = body.join('\n');
    const name = /^\s*server_name\s+([^;]+);/m.exec(text)?.[1]?.trim() ?? '';
    hosts.push({
      serverName: name,
      body: text,
      listens80: /^\s*listen\s+80\b/m.test(text),
    });
  }
  return hosts;
}

/** Имя из сертификата, подставленное в шаблонные переменные. */
function matchesServerName(pattern: string, name: string): boolean {
  const filled = pattern
    .replace(/\$\{MAIL_DOMAIN\}/g, 'example.test')
    .replace(/\$\{MAIL_HOSTNAME\}/g, 'mx.example.test');
  return filled.split(/\s+/).includes(name);
}

const ACME_LOCATION = /location\s+\/\.well-known\/acme-challenge\/\s*\{([^}]*)\}/;

test('каждое обязательное имя сертификата обслуживает блок с ACME-проверкой', () => {
  const { required } = expectedCertificateNames('example.test', 'mx.example.test');
  const hosts = virtualHosts(TEMPLATE).filter((h) => h.listens80);
  assert.ok(hosts.length > 0, 'в шаблоне не нашлось ни одного блока на 80-м порту');

  for (const name of required) {
    // Точное совпадение имени сильнее умолчания: если такой блок есть,
    // запрос попадёт именно в него, и ACME обязан быть там.
    const exact = hosts.find((h) => matchesServerName(h.serverName, name));
    const host = exact ?? hosts.find((h) => h.serverName.split(/\s+/).includes('_'));
    assert.ok(host, `имя ${name} не обслуживает ни один блок шаблона`);
    assert.match(
      host.body,
      ACME_LOCATION,
      `выпуск сертификата провалится на имени ${name}: блок «${host.serverName}» ` +
        'отдаёт проверку Let’s Encrypt в приложение вместо каталога с токеном',
    );
  }
});

test('ACME в панели открыт всем, несмотря на список разрешённых сетей', () => {
  const admin = virtualHosts(TEMPLATE).find((h) => h.serverName.includes('admin.'));
  assert.ok(admin, 'блок панели не найден');
  assert.ok(
    admin.body.includes('${ADMIN_ACCESS_RULES}'),
    'проверка потеряла смысл: ограничения по сетям в блоке панели больше нет',
  );

  const acme = ACME_LOCATION.exec(admin.body)?.[1] ?? '';
  assert.match(
    acme,
    /^\s*allow\s+all;/m,
    'без своего allow правила панели наследуются внутрь, и Let’s Encrypt получит 403',
  );
});

test('ACME-проверка не уводится редиректом на HTTPS', () => {
  /*
   * Проверка приходит именно на 80-й порт. Отправить её на HTTPS —
   * значит сорвать выпуск на сервере, у которого сертификата ещё нет:
   * ровно в тот момент, когда его и выпускают.
   */
  for (const host of virtualHosts(TEMPLATE).filter((h) => h.listens80)) {
    if (!ACME_LOCATION.test(host.body)) continue;
    // Обход нужен только там, где редирект вообще есть: блоки
    // автонастройки отвечают и по HTTP, и по HTTPS, никого не перекидывая.
    if (!/return\s+301\s+https:/.test(host.body)) continue;
    assert.match(
      host.body,
      /if\s*\(\$uri\s*~\s*\^\/\\\.well-known\/acme-challenge\/\)/,
      `блок «${host.serverName}» уведёт проверку Let’s Encrypt на HTTPS`,
    );
  }
});
