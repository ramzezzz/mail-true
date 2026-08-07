/**
 * Свой сертификат в мастере первого запуска.
 *
 * Правила проверки берутся из общего пакета (packages/shared) — те же, что
 * применяет раздел «Сертификат» в панели управления. Здесь только две
 * вещи, которых в общем пакете быть не может: где взять список доверенных
 * корней этой машины и куда положить готовые файлы.
 */
import { readFile, writeFile, access, chmod } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import {
  expectedCertificateNames,
  validateCertificateBundle,
  type TlsValidationResult,
} from '@mail-true/shared/tls-certificate';

/**
 * Доверенные корни контейнера. Нужны, чтобы отличить «не хватает
 * промежуточного сертификата» от «цепочка ведёт к вашему собственному
 * центру» — это разные разговоры с человеком, и путать их нельзя.
 */
let cached: ReadonlySet<string> | null = null;

export async function trustedRootSubjects(): Promise<ReadonlySet<string> | undefined> {
  if (cached !== null) return cached;
  for (const path of ['/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem']) {
    try {
      await access(path);
      const text = await readFile(path, 'utf8');
      const subjects = new Set<string>();
      for (const match of text.matchAll(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      )) {
        try {
          subjects.add(new X509Certificate(match[0]).subject);
        } catch {
          /* один нечитаемый корень не повод отказываться от остальных */
        }
      }
      if (subjects.size > 0) {
        cached = subjects;
        return cached;
      }
    } catch {
      /* пробуем следующий путь */
    }
  }
  return undefined;
}

export interface CustomCertInput {
  readonly certificate: string;
  readonly privateKey: string;
  readonly chain: string;
  readonly domain: string;
  readonly hostname: string;
}

export async function checkCustomCertificate(input: CustomCertInput): Promise<TlsValidationResult> {
  const expected = expectedCertificateNames(input.domain, input.hostname);
  const roots = await trustedRootSubjects();
  return validateCertificateBundle({
    certificatePem: input.certificate,
    privateKeyPem: input.privateKey,
    ...(input.chain.trim() === '' ? {} : { chainPem: input.chain }),
    expectedNames: expected.required,
    optionalNames: expected.optional,
    ...(roots === undefined ? {} : { trustedRootSubjects: roots }),
  });
}

/**
 * Положить проверенный сертификат туда, где его ждут службы.
 *
 * Делается ДО запуска install/install.sh: та видит готовые файлы и не
 * выпускает самоподписанный поверх («сертификат уже есть»). Отметка source
 * говорит и ей, и install/renew-certs.sh, что сертификат здесь чужой и
 * перезаписывать его продлением Let's Encrypt нельзя.
 */
export async function writeCustomCertificate(
  certDir: string,
  result: TlsValidationResult,
  privateKeyPem: string,
): Promise<void> {
  if (!result.ok || result.fullchainPem === '') {
    throw new Error('сертификат не прошёл проверку — записывать нечего');
  }
  await writeFile(`${certDir}/mail.crt`, result.fullchainPem, { mode: 0o644 });
  await writeFile(`${certDir}/mail.key`, `${privateKeyPem.trim()}\n`, { mode: 0o600 });
  await chmod(`${certDir}/mail.crt`, 0o644);
  await chmod(`${certDir}/mail.key`, 0o600);
  await writeFile(`${certDir}/source`, 'custom\n', { mode: 0o644 });
}
