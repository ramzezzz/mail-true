/**
 * Замена TLS-сертификата: что остаётся на диске, если она сорвалась.
 *
 * Проверяется не разбор PEM (он в packages/shared) и не маршрут целиком, а
 * единственное место, где ошибка стоит всей почты сразу: раскладка файлов
 * в каталог, за которым следят nginx, Postfix и Dovecot. Они перечитывают
 * его в течение десяти секунд (infra/nginx/watch-certs.sh), поэтому
 * несходящаяся пара «новый ключ + старый сертификат» — это остановка TLS
 * у всех трёх разом, то есть и почта, и панель.
 *
 * На старом коде обе проверки падают: раскладка шла четырьмя записями
 * подряд без единого отката.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installCertificateFiles } from './routes/tls.js';

const OLD_CERT = '-----BEGIN CERTIFICATE-----\nСТАРЫЙ-СЕРТИФИКАТ\n-----END CERTIFICATE-----\n';
const OLD_KEY = '-----BEGIN PRIVATE KEY-----\nСТАРЫЙ-КЛЮЧ\n-----END PRIVATE KEY-----\n';
const NEW_CERT = '-----BEGIN CERTIFICATE-----\nНОВЫЙ-СЕРТИФИКАТ\n-----END CERTIFICATE-----';
const NEW_KEY = '-----BEGIN PRIVATE KEY-----\nНОВЫЙ-КЛЮЧ\n-----END PRIVATE KEY-----';

/**
 * Каталог сертификатов со старой парой и отметкой источника.
 *
 * `blockCert` ставит на место сертификата КАТАЛОГ: переименовать файл
 * поверх каталога не даёт ни одна система, и это единственный способ
 * изобразить отказ ровно на втором переименовании, ничего не подменяя
 * в самом коде.
 */
async function certDir(
  options: { blockCert?: boolean } = {},
): Promise<{ certPath: string; keyPath: string; sourcePath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-certs-'));
  const paths = {
    certPath: path.join(dir, 'mail.crt'),
    keyPath: path.join(dir, 'mail.key'),
    sourcePath: path.join(dir, 'source'),
  };
  if (options.blockCert === true) {
    await mkdir(paths.certPath, { recursive: true });
    await writeFile(path.join(paths.certPath, 'zanyato'), 'не файл');
  } else {
    await writeFile(paths.certPath, OLD_CERT);
  }
  await writeFile(paths.keyPath, OLD_KEY);
  await writeFile(paths.sourcePath, 'letsencrypt\n');
  return paths;
}

test('удачная замена ставит пару и отмечает сертификат своим', async () => {
  const paths = await certDir();
  const outcome = await installCertificateFiles(paths, {
    fullchainPem: NEW_CERT,
    privateKeyPem: NEW_KEY,
  });

  assert.equal(outcome.ok, true, outcome.problem);
  assert.equal(await readFile(paths.certPath, 'utf8'), NEW_CERT);
  assert.equal((await readFile(paths.keyPath, 'utf8')).trim(), NEW_KEY);
  // Без этой отметки автопродление (cert-renewal.ts судит именно по файлу
  // source) затёрло бы только что поставленный свой сертификат.
  assert.equal((await readFile(paths.sourcePath, 'utf8')).trim(), 'custom');
  // Временные файлы после себя не оставляем: службы следят за каталогом.
  assert.equal(existsSync(`${paths.certPath}.new`), false);
  assert.equal(existsSync(`${paths.keyPath}.new`), false);
});

test('сорвавшаяся замена не оставляет ключ от одного сертификата, а сертификат от другого', async () => {
  /*
   * Ровно тот порядок, что был в коде: сперва переименовывался ключ,
   * потом сертификат. Отказ второго переименования оставлял на диске
   * НОВЫЙ ключ рядом со СТАРЫМ сертификатом — пару, которой ни одна
   * служба не поднимется, — а откатить было нечем: старый ключ уже
   * перезаписан. Ответ при этом гласил «Не удалось записать сертификат»,
   * то есть «ничего не произошло», и человек шёл проверять права
   * каталога вместо того, чтобы поднимать почту.
   *
   * Отказ записи сертификата изображается каталогом на его месте:
   * переименовать файл поверх каталога не даёт ни одна система.
   */
  const paths = await certDir({ blockCert: true });

  const outcome = await installCertificateFiles(paths, {
    fullchainPem: NEW_CERT,
    privateKeyPem: NEW_KEY,
  });

  assert.equal(outcome.ok, false, 'отказ обязан быть отказом');
  // Главное: ключ остался ПРЕЖНИМ и сходится со старым сертификатом.
  assert.equal(await readFile(paths.keyPath, 'utf8'), OLD_KEY, 'старый ключ перезаписан навсегда');
  // И отметка источника вернулась: иначе автопродление решило бы, что
  // сертификат свой, и перестало бы продлевать настоящий.
  assert.equal((await readFile(paths.sourcePath, 'utf8')).trim(), 'letsencrypt');
  assert.equal(existsSync(`${paths.keyPath}.new`), false, 'обрывки замены не должны пережить её');
  // И ответ говорит правду о состоянии диска, а не «ничего не произошло».
  assert.match(outcome.problem, /возвращены на место/iu);
});
