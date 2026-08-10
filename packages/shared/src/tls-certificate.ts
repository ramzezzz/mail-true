/**
 * Разбор и проверка TLS-сертификата, который человек приносит сам.
 *
 * ------------------------------------------------------------------
 * ПОЧЕМУ ЭТО ОДИН МОДУЛЬ НА ДВА МЕСТА
 * ------------------------------------------------------------------
 * Свой сертификат ставят дважды: при установке (мастер первого запуска,
 * apps/installer) и потом, когда старый истекает (раздел «Сертификат» в
 * панели, apps/api + apps/admin). Это ОДНО И ТО ЖЕ действие с одними и
 * теми же последствиями, и проверять его двумя разными наборами правил
 * значит однажды пропустить в панели то, что мастер ловил, — и наоборот.
 * Разойтись они успели бы молча: обе стороны продолжали бы работать.
 *
 * Поэтому правила живут здесь, в общем пакете, и обе стороны только
 * показывают их вывод.
 *
 * ------------------------------------------------------------------
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ЭТО
 * ------------------------------------------------------------------
 * Каждая проверка отвечает на «как это ломается на живом сервере»:
 *
 *   формат        — прислали .pfx или DER вместо PEM. Службы не поднимутся
 *                   вовсе, а в журнале будет «PEM_read_bio: no start line»;
 *   ключ к сертификату — самая дорогая ошибка: файлы по отдельности
 *                   выглядят исправными, службы стартуют и перестают
 *                   отвечать по TLS ЦЕЛИКОМ. Почта останавливается;
 *   цепочка       — без промежуточных сертификатов браузер (у него свой
 *                   запас) показывает зелёный замок, а Outlook и Android
 *                   ругаются на «недоверенный узел». Ошибку ищут неделями,
 *                   потому что «у меня всё работает»;
 *   имена         — сертификат на mail.<домен> без admin.<домен> означает
 *                   работающую почту и неоткрывающуюся панель. Поимённо —
 *                   потому что «имена не совпадают» не говорит, какие;
 *   срок          — истёкший отвергается, истекающий называет дату.
 *
 * Проверка НЕ подменяет собой удостоверяющий центр: она отвечает на
 * вопрос «заработает ли это здесь», а не «настоящий ли это сертификат».
 */
import { X509Certificate, createPrivateKey } from 'node:crypto';

export type TlsIssueLevel = 'ok' | 'warn' | 'fail';

export interface TlsIssue {
  readonly id: string;
  readonly level: TlsIssueLevel;
  readonly title: string;
  /** Что именно нашли — словами, с именами и датами. */
  readonly detail: string;
  /** Что с этим делать. Команда или действие, а не «обратитесь к администратору». */
  readonly hint?: string;
}

export interface CertificateInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly commonName: string;
  readonly names: readonly string[];
  readonly validFrom: string;
  readonly validTo: string;
  readonly daysLeft: number;
  readonly serialNumber: string;
  readonly fingerprint256: string;
  readonly selfSigned: boolean;
}

export interface TlsBundleInput {
  /** Сертификат сервера. Допускается файл, где за ним сразу идёт цепочка. */
  readonly certificatePem: string;
  /**
   * Приватный ключ. НЕОБЯЗАТЕЛЕН.
   *
   * Он нужен ровно одной проверке — «ключ и сертификат одна пара». Всё
   * остальное (срок, имена, издатель, цепочка) читается из самого
   * сертификата.
   *
   * Без этого послабления раздел «Сертификат» на штатной установке не
   * показывал НИЧЕГО: ключ лежит с правами 600 и владельцем root (так
   * его кладут и установщик, и продление Let's Encrypt), а сервер
   * приложения работает под другим пользователем. Одна ошибка чтения
   * гасила весь разбор, и вместо срока и имён человек видел
   * «EACCES: permission denied». Заметно это только на настоящем
   * сервере: после замены сертификата ИЗ панели файл создаёт уже сам
   * сервер, и в разработке дефекта не видно.
   */
  readonly privateKeyPem?: string;
  /** Промежуточные сертификаты отдельным файлом, если они пришли так. */
  readonly chainPem?: string;
  /** Имена, которые сертификат обязан покрывать. */
  readonly expectedNames: readonly string[];
  /**
   * Имена, без которых можно жить: их отсутствие — предупреждение,
   * а не отказ. Сюда попадает autodiscover.<домен>: он нужен только Outlook.
   */
  readonly optionalNames?: readonly string[];
  readonly now?: Date;
  /**
   * Subject доверенных корневых удостоверяющих центров этой машины.
   * Пусто — проверку «доверяет ли этому корню мир» не делаем и честно
   * об этом молчим, а не выдумываем ответ.
   */
  readonly trustedRootSubjects?: ReadonlySet<string>;
}

export interface TlsValidationResult {
  /** Нет ни одного отказа. Предупреждения при этом могут быть. */
  readonly ok: boolean;
  readonly issues: readonly TlsIssue[];
  readonly certificate: CertificateInfo | null;
  readonly chain: readonly CertificateInfo[];
  readonly missingNames: readonly string[];
  /**
   * Что записывать в файл сертификата: лист, а за ним промежуточные — в
   * том порядке, в каком их ждут службы. Пусто, если проверка не прошла.
   */
  readonly fullchainPem: string;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\r\n]+([A-Za-z0-9+/=\s]+?)-----END \1-----/g;

interface PemBlock {
  readonly label: string;
  readonly pem: string;
}

/** Разбить текст на блоки PEM. Мусор между блоками игнорируется. */
export function splitPem(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  PEM_BLOCK.lastIndex = 0;
  let match = PEM_BLOCK.exec(text);
  while (match !== null) {
    blocks.push({ label: match[1] ?? '', pem: match[0] });
    match = PEM_BLOCK.exec(text);
  }
  return blocks;
}

/**
 * Имена, которые обязан покрывать сертификат этого сервера.
 *
 * Их четыре, и каждое отвечает за свою службу — поэтому «сертификат на
 * почту» без остальных ломает ровно то, о чём никто не подумал.
 */
export function expectedCertificateNames(
  domain: string,
  hostname: string,
): { required: string[]; optional: string[] } {
  const required = [hostname, `mail.${domain}`, `admin.${domain}`];
  /*
   * ПРЕДУПРЕЖДЕНИЕ, А НЕ ОТКАЗ.
   *
   * Корневой домен: почта открывается и по нему, но работает и без — по
   * mail.<домен>.
   *
   * autoconfig и autodiscover: без них почтовые программы не заберут
   * настройки сами, и человек введёт адреса руками. Это неудобство, а не
   * неработающая почта.
   *
   * Раньше autoconfig стоял в обязательных, а панель отказывает на любом
   * отказе — то есть рабочий коммерческий сертификат на mail. + admin. +
   * имя сервера поставить через панель было НЕЛЬЗЯ ВООБЩЕ, только
   * копированием файлов по ssh, мимо всех этих проверок. Проверка,
   * которая запрещает рабочую настройку, выталкивает человека мимо себя.
   */
  const optional = [domain, `autoconfig.${domain}`, `autodiscover.${domain}`];
  return {
    required: [...new Set(required.filter((n) => n !== ''))],
    optional: [...new Set(optional.filter((n) => n !== '' && !required.includes(n)))],
  };
}

/** Что перестанет работать без каждого имени — это и есть смысл проверки. */
const NAME_ROLES: ReadonlyArray<{ test: (name: string) => boolean; what: string }> = [
  { test: (n) => n.startsWith('mail.'), what: 'почта в браузере' },
  { test: (n) => n.startsWith('admin.'), what: 'панель управления' },
  {
    test: (n) => n.startsWith('autoconfig.') || n.startsWith('autodiscover.'),
    what: 'автонастройка почтовых программ (Thunderbird, Outlook, Apple Mail)',
  },
];

function roleOf(name: string): string {
  return NAME_ROLES.find((role) => role.test(name))?.what ?? 'почтовые программы (IMAP и SMTP)';
}

/** Совпадение имени с записью сертификата, включая «*.example.ru». */
export function nameMatches(pattern: string, name: string): boolean {
  const p = pattern.trim().toLowerCase();
  const n = name.trim().toLowerCase();
  if (p === '' || n === '') return false;
  if (p === n) return true;
  if (!p.startsWith('*.')) return false;
  // Подстановка покрывает ровно один уровень: «*.example.ru» подходит для
  // mail.example.ru, но не для a.b.example.ru и не для самого example.ru.
  const suffix = p.slice(1);
  if (!n.endsWith(suffix)) return false;
  return !n.slice(0, n.length - suffix.length).includes('.');
}

function namesOf(cert: X509Certificate): string[] {
  const names: string[] = [];
  const san = cert.subjectAltName ?? '';
  for (const part of san.split(',')) {
    const trimmed = part.trim();
    if (trimmed.toUpperCase().startsWith('DNS:')) names.push(trimmed.slice(4).trim().toLowerCase());
  }
  // Common Name — запасной путь для старых сертификатов вовсе без SAN.
  const cn = /CN=([^\n,]+)/
    .exec(cert.subject ?? '')?.[1]
    ?.trim()
    .toLowerCase();
  if (names.length === 0 && cn !== undefined && cn !== '') names.push(cn);
  return [...new Set(names)];
}

function describe(cert: X509Certificate, now: Date): CertificateInfo {
  const validTo = new Date(cert.validTo);
  const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
  return {
    subject: (cert.subject ?? '').replace(/\n/g, ', '),
    issuer: (cert.issuer ?? '').replace(/\n/g, ', '),
    commonName: /CN=([^\n,]+)/.exec(cert.subject ?? '')?.[1]?.trim() ?? '',
    names: namesOf(cert),
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft,
    serialNumber: cert.serialNumber ?? '',
    fingerprint256: cert.fingerprint256 ?? '',
    selfSigned: cert.subject === cert.issuer,
  };
}

/** Русская дата без времени — её читают, а не разбирают. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

/** Порог «пора продлевать»: тридцати дней хватает, чтобы успеть. */
export const EXPIRY_WARN_DAYS = 30;

/**
 * Похоже ли содержимое на двоичный файл (DER, PKCS#12), а не на текст.
 *
 * Проверяем по кодам символов, а не выражением с диапазоном управляющих
 * байтов: такой диапазон пришлось бы записать управляющими байтами прямо
 * в исходнике, а с ними у нас уже была история (source-hygiene.test.ts).
 */
function looksBinary(text: string): boolean {
  const head = text.slice(0, 4096);
  for (let i = 0; i < head.length; i += 1) {
    const code = head.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32) return true;
  }
  return false;
}

export function validateCertificateBundle(input: TlsBundleInput): TlsValidationResult {
  const now = input.now ?? new Date();
  const issues: TlsIssue[] = [];
  const fail = (id: string, title: string, detail: string, hint?: string): void => {
    issues.push(
      hint === undefined
        ? { id, level: 'fail', title, detail }
        : { id, level: 'fail', title, detail, hint },
    );
  };
  const warn = (id: string, title: string, detail: string, hint?: string): void => {
    issues.push(
      hint === undefined
        ? { id, level: 'warn', title, detail }
        : { id, level: 'warn', title, detail, hint },
    );
  };
  const ok = (id: string, title: string, detail: string): void => {
    issues.push({ id, level: 'ok', title, detail });
  };

  const empty: TlsValidationResult = {
    ok: false,
    issues,
    certificate: null,
    chain: [],
    missingNames: [],
    fullchainPem: '',
  };

  // --- 1. Формат ----------------------------------------------------
  //
  // Файлы разбираются ПОРОЗНЬ, и это важно: сертификат сервера обязан быть
  // первым блоком именно файла сертификата. Разбери мы оба файла одной
  // кучей, и мусор вместо сертификата остался бы незамеченным — листом
  // молча стал бы первый промежуточный из цепочки, а службы поднялись бы
  // с сертификатом удостоверяющего центра вместо своего.
  const isCert = (b: PemBlock): boolean =>
    b.label.includes('CERTIFICATE') && !b.label.includes('REQUEST');
  const leafBlocks = splitPem(input.certificatePem).filter(isCert);
  const chainBlocks = splitPem(input.chainPem ?? '').filter(isCert);
  const certBlocks = [...leafBlocks, ...chainBlocks];

  if (leafBlocks.length === 0) {
    const binary = looksBinary(input.certificatePem);
    fail(
      'format',
      'Это не PEM',
      binary
        ? 'Файл сертификата двоичный — похоже на DER или PKCS#12 (.pfx, .p12). ' +
            'Службы такой файл не прочитают вовсе и не поднимутся.'
        : 'В файле сертификата нет ни одного блока «-----BEGIN CERTIFICATE-----».',
      'Перевести в PEM:\n' +
        '  из .pfx:  openssl pkcs12 -in cert.pfx -clcerts -nokeys -out cert.pem\n' +
        '            openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem\n' +
        '  из DER:   openssl x509 -inform der -in cert.der -out cert.pem',
    );
    return empty;
  }

  const parsed: X509Certificate[] = [];
  for (const block of certBlocks) {
    try {
      parsed.push(new X509Certificate(block.pem));
    } catch (err) {
      fail(
        'parse',
        'Сертификат не разбирается',
        `Один из блоков файла не является сертификатом X.509: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }

  const leaf = parsed[0];
  if (leaf === undefined) return empty;
  const leafInfo = describe(leaf, now);

  // --- 2. Ключ подходит к сертификату -------------------------------
  /*
   * Ключа может не быть вовсе — тогда пару сверить нечем, и это
   * ПРЕДУПРЕЖДЕНИЕ, а не отказ: остальное о сертификате мы знаем и
   * показать обязаны.
   */
  const keyPem = input.privateKeyPem;
  if (keyPem === undefined) {
    warn(
      'key-unavailable',
      'Пару «ключ и сертификат» проверить нечем',
      'Приватный ключ недоступен для чтения — обычно так и должно быть: его кладут с правами ' +
        'только для владельца. Всё остальное в сертификате проверено.',
    );
  }
  const keyBlocks =
    keyPem === undefined ? [] : splitPem(keyPem).filter((b) => b.label.includes('PRIVATE KEY'));
  if (keyPem !== undefined && keyBlocks.length === 0) {
    fail(
      'key-format',
      'Это не приватный ключ в PEM',
      looksBinary(keyPem ?? '')
        ? 'Файл ключа двоичный — похоже на DER или PKCS#12.'
        : 'В файле ключа нет блока «-----BEGIN PRIVATE KEY-----» (или RSA/EC PRIVATE KEY).',
      'Если ключ внутри .pfx:  openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem',
    );
    return { ...empty, certificate: leafInfo };
  }

  let keyOk = false;
  try {
    // Ключа нет — пару не сверяем вовсе, предупреждение уже записано выше.
    if (keyPem === undefined) keyOk = true;
    else {
      const key = createPrivateKey(keyBlocks[0]?.pem ?? '');
      keyOk = leaf.checkPrivateKey(key);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(
      'key-read',
      'Ключ не читается',
      /bad decrypt|passphrase|encrypt/i.test(message)
        ? 'Ключ зашифрован паролем. Службы читают его при старте и спросить пароль не у кого.'
        : `Не удалось разобрать приватный ключ: ${message}`,
      'Снять пароль с ключа:  openssl rsa -in key.pem -out key-open.pem',
    );
    return { ...empty, certificate: leafInfo };
  }

  if (!keyOk) {
    fail(
      'key-mismatch',
      'Ключ не подходит к сертификату',
      'Открытый ключ в сертификате и этот приватный ключ — разная пара. По отдельности оба ' +
        'файла выглядят исправными, поэтому ошибку замечают уже после применения.',
      'Так бывает, когда сертификат перевыпустили с новым запросом, а ключ взяли от прошлого ' +
        'раза. Сверить пару самому:\n' +
        '  openssl x509 -noout -modulus -in cert.pem | openssl sha256\n' +
        '  openssl rsa  -noout -modulus -in key.pem  | openssl sha256\n' +
        'Суммы обязаны совпасть. Применять такую пару нельзя: почта и панель перестанут ' +
        'отвечать по TLS целиком.',
    );
    return { ...empty, certificate: leafInfo };
  }
  if (keyPem !== undefined) ok('key-match', 'Ключ подходит к сертификату', 'Пара сходится.');

  // --- 3. Срок ------------------------------------------------------
  const startsAt = new Date(leafInfo.validFrom);
  if (startsAt.getTime() > now.getTime()) {
    fail(
      'not-yet-valid',
      'Сертификат ещё не действует',
      `Он вступает в силу ${formatDate(leafInfo.validFrom)}. До этой даты клиенты будут ` +
        'считать его недействительным.',
    );
  } else if (leafInfo.daysLeft < 0) {
    fail(
      'expired',
      'Срок сертификата истёк',
      `Он закончился ${formatDate(leafInfo.validTo)} — ${Math.abs(leafInfo.daysLeft)} дн. назад.`,
      'Истёкший сертификат отвергают все: и браузеры, и почтовые программы, и чужие ' +
        'почтовые серверы. Возьмите у удостоверяющего центра свежий.',
    );
  } else if (leafInfo.daysLeft <= EXPIRY_WARN_DAYS) {
    warn(
      'expiring',
      'Сертификат скоро истечёт',
      `Действует до ${formatDate(leafInfo.validTo)} — осталось ${leafInfo.daysLeft} дн.`,
      'Поставить его можно, но продление придётся делать почти сразу.',
    );
  } else {
    ok(
      'validity',
      'Срок в порядке',
      `Действует до ${formatDate(leafInfo.validTo)} — это ещё ${leafInfo.daysLeft} дн.`,
    );
  }

  // --- 4. Имена -----------------------------------------------------
  const covers = (name: string): boolean => leafInfo.names.some((p) => nameMatches(p, name));
  const missingRequired = input.expectedNames.filter((name) => !covers(name));
  const missingOptional = (input.optionalNames ?? []).filter((name) => !covers(name));

  if (missingRequired.length === 0) {
    ok('names', 'Имена покрыты', `Сертификат выдан на: ${leafInfo.names.join(', ')}.`);
  } else {
    fail(
      'names',
      'Сертификат покрывает не все имена сервера',
      `В сертификате: ${leafInfo.names.join(', ')}.\nНе хватает:\n` +
        missingRequired
          .map((name) => `  • ${name} — перестанет открываться ${roleOf(name)}`)
          .join('\n'),
      'Попросите удостоверяющий центр перевыпустить сертификат со всеми этими именами ' +
        '(SAN) либо возьмите подстановочный: *.<домен> покрывает их разом.',
    );
  }
  if (missingOptional.length > 0) {
    warn(
      'names-optional',
      'Часть имён не покрыта',
      `Нет ${missingOptional.join(', ')}. Без них: ` +
        missingOptional.map((n) => roleOf(n)).join('; ') +
        ' — будет работать не для всех клиентов.',
      'Это не отказ: почта и панель откроются по остальным именам.',
    );
  }

  // --- 5. Цепочка ---------------------------------------------------
  const chain: CertificateInfo[] = [];
  const fullchain: string[] = [certBlocks[0]?.pem ?? ''];

  if (leafInfo.selfSigned) {
    warn(
      'chain-selfsigned',
      'Сертификат самоподписанный',
      'Он выдан сам себе — удостоверяющего центра за ним нет.',
      'Работать почта будет, но браузер будет ругаться на каждом входе, а Outlook ' +
        'откажется настраиваться автоматически.',
    );
  } else {
    // Идём вверх по цепочке ТОЛЬКО по тем сертификатам, что принесли:
    // это ровно то, что получат клиенты, — больше им взять неоткуда.
    const pool = parsed.slice(1);
    const used = new Set<number>();
    let current = leaf;
    let currentInfo = leafInfo;
    let complete = false;
    let privateRoot: CertificateInfo | null = null;

    for (let step = 0; step < 8; step += 1) {
      if (
        input.trustedRootSubjects !== undefined &&
        input.trustedRootSubjects.has(current.issuer ?? '')
      ) {
        complete = true;
        break;
      }
      const index = pool.findIndex((candidate, i) => {
        if (used.has(i)) return false;
        if (candidate.subject !== current.issuer) return false;
        try {
          return current.verify(candidate.publicKey);
        } catch {
          return false;
        }
      });
      if (index < 0) break;
      used.add(index);
      const issuerCert = pool[index];
      if (issuerCert === undefined) break;
      const issuerInfo = describe(issuerCert, now);
      chain.push(issuerInfo);
      fullchain.push(certBlocks[parsed.indexOf(issuerCert)]?.pem ?? '');
      if (issuerInfo.selfSigned) {
        privateRoot = issuerInfo;
        complete = true;
        break;
      }
      current = issuerCert;
      currentInfo = issuerInfo;
    }

    if (chain.length === 0 && !complete) {
      fail(
        'chain-missing',
        'Цепочки нет: не приложены промежуточные сертификаты',
        `Сертификат выдан «${leafInfo.issuer}», но самого этого сертификата в файле нет.`,
        'Это самая частая ошибка при установке сертификата вручную — и самая обманчивая: ' +
          'браузер держит промежуточные у себя и покажет зелёный замок, а Outlook, почта ' +
          'Android и чужие почтовые серверы скажут «недоверенный узел». Удостоверяющий ' +
          'центр отдаёт их файлом вроде chain.pem, intermediate.crt или bundle.crt — ' +
          'приложите его.',
      );
    } else if (privateRoot !== null) {
      const rootTrusted =
        input.trustedRootSubjects !== undefined &&
        input.trustedRootSubjects.has(privateRoot.subject);
      if (!rootTrusted) {
        warn(
          'chain-private-root',
          'Цепочка замкнута на собственный корневой центр',
          `Она ведёт к «${privateRoot.commonName || privateRoot.subject}», а этого центра нет ` +
            'в списке общедоверенных.',
          'Так и должно быть у корпоративного центра сертификации. Но клиенты, которым его ' +
            'корневой сертификат не раздали, будут видеть предупреждение — раздайте его ' +
            'вместе с настройками почты.',
        );
      } else {
        ok('chain', 'Цепочка полная', `Ведёт к доверенному корню «${privateRoot.commonName}».`);
      }
    } else if (complete) {
      ok(
        'chain',
        'Цепочка полная',
        chain.length === 0
          ? `Выдан напрямую доверенным центром «${leafInfo.issuer}».`
          : `Приложено промежуточных сертификатов: ${chain.length}; выше — доверенный центр.`,
      );
    } else {
      warn(
        'chain-incomplete',
        'Цепочка обрывается',
        `Верхний из приложенных сертификатов выдан «${currentInfo.issuer}», и этого центра ` +
          'нет ни в файле, ни в списке доверенных на этой машине.',
        'Если это ваш внутренний удостоверяющий центр — так и должно быть. Если сертификат ' +
          'коммерческий, у него не хватает ещё одного промежуточного: спросите его у центра.',
      );
    }
  }

  const failed = issues.some((issue) => issue.level === 'fail');
  return {
    ok: !failed,
    issues,
    certificate: leafInfo,
    chain,
    missingNames: [...missingRequired, ...missingOptional],
    fullchainPem: failed ? '' : `${fullchain.filter((p) => p !== '').join('\n')}\n`,
  };
}
