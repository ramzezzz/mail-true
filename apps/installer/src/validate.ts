/**
 * Проверка ответов мастера.
 *
 * Те же правила, что у install/install.sh (is_fqdn, is_email, длина пароля,
 * пароли-заглушки, согласованность подсети и адресов в ней) — но здесь они
 * обязаны сработать РАНЬШЕ, чем что-либо начнёт происходить: в браузере
 * человек нажимает «Далее», а не читает вывод скрипта.
 *
 * Каждый отказ называет причину словами. «Неверное значение поля» — это код,
 * а не причина: он не говорит, что именно неверно и чем это грозит.
 */

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** Грубая проверка доменного имени — та же, что is_fqdn в common.sh. */
export function isFqdn(value: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(
    value,
  );
}

/** Та же проверка адреса, что is_email в common.sh. */
export function isEmail(value: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
}

/**
 * Пароли-заглушки из примеров и документации. Они проходят проверку длины
 * и потому спокойно доезжают до боевого сервера — ровно так уже случалось
 * с install/answers.example.env.
 */
const PLACEHOLDER_PASSWORDS = [
  'смените-этот-пароль',
  'change-me',
  'changeme',
  'change-this-password',
  'password',
  'пароль',
  'mailtrue',
  'admin123456',
  '1234567890',
];

export function isPlaceholderPassword(value: string): boolean {
  const lowered = value.toLowerCase();
  if (PLACEHOLDER_PASSWORDS.includes(lowered)) return true;
  return lowered.startsWith('change-me') || lowered.startsWith('смените');
}

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Подсеть стека и фиксированные адреса в ней меняются ТОЛЬКО вместе.
 * Поменяв одну подсеть, человек получает отказ docker «no configured subnet
 * contains IP address 172.28.0.54», в котором нет ни имени файла, ни имени
 * настройки, — и стек не поднимается вовсе.
 */
export function subnetContains(subnet: string, ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.exec(subnet);
  if (!match) return false;
  return ip.startsWith(`${match[1]}.${match[2]}.`);
}

export function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export interface Answers {
  domain: string;
  hostname: string;
  adminEmail: string;
  adminLogin: string;
  adminPassword: string;
  adminPasswordRepeat: string;
  tls: string;
  leEmail: string;
  /** Свой сертификат: сам сертификат, цепочка и ключ в формате PEM. */
  customCert: string;
  customChain: string;
  customKey: string;
  bindAddress: string;
  clamav: boolean;
  aiEnabled: boolean;
  ports: Record<string, number>;
  subnet: string;
  resolverIp: string;
  dovecotIp: string;
  messageMaxBytes: number;
  uploadMaxBytes: number;
  composeBodyMaxBytes: number;
  defaultQuotaBytes: number;
}

/** Ключи шага «Порты»: имя поля → ключ infra/.env. */
export const PORT_FIELDS: ReadonlyArray<{ key: string; envKey: string; label: string }> = [
  { key: 'smtp', envKey: 'SMTP_PORT', label: 'Приём почты (SMTP)' },
  { key: 'submission', envKey: 'SUBMISSION_PORT', label: 'Отправка, STARTTLS (submission)' },
  { key: 'submissions', envKey: 'SUBMISSIONS_PORT', label: 'Отправка, TLS сразу (submissions)' },
  { key: 'imap', envKey: 'IMAP_PORT', label: 'IMAP + STARTTLS' },
  { key: 'imaps', envKey: 'IMAPS_PORT', label: 'IMAPS' },
  { key: 'pop3', envKey: 'POP3_PORT', label: 'POP3 + STARTTLS' },
  { key: 'pop3s', envKey: 'POP3S_PORT', label: 'POP3S' },
  { key: 'http', envKey: 'NGINX_HTTP_PORT', label: 'Веб, HTTP' },
  { key: 'https', envKey: 'NGINX_HTTPS_PORT', label: 'Веб, HTTPS' },
  { key: 'postgres', envKey: 'POSTGRES_PORT', label: 'Postgres (только 127.0.0.1)' },
  { key: 'redis', envKey: 'REDIS_PORT', label: 'Redis (только 127.0.0.1)' },
  { key: 'autoconfig', envKey: 'AUTOCONFIG_PORT', label: 'Автонастройка (только 127.0.0.1)' },
  { key: 'api', envKey: 'API_PORT', label: 'Сервер приложения (только 127.0.0.1)' },
  { key: 'rspamd', envKey: 'RSPAMD_WEB_PORT', label: 'Веб-интерфейс rspamd (только 127.0.0.1)' },
];

export const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  smtp: 25,
  submission: 587,
  submissions: 465,
  imap: 143,
  imaps: 993,
  pop3: 110,
  pop3s: 995,
  http: 80,
  https: 443,
  postgres: 5432,
  redis: 6379,
  autoconfig: 8025,
  api: 3000,
  rspamd: 11334,
};

const MIN_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

export function validateAnswers(answers: Answers): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string): void => {
    errors.push({ field, message });
  };

  // Пустое поле и заполненное неверно — разные разговоры. «„“ не похоже на
  // доменное имя» человек читает как поломку установщика, а не как просьбу
  // что-то ввести, — и он прав.
  if (answers.domain === '') {
    add('domain', 'Без почтового домена сервер не сможет ни принимать, ни отправлять письма.');
  } else if (!isFqdn(answers.domain)) {
    add(
      'domain',
      `«${answers.domain}» не похоже на доменное имя. Это то, что стоит после @ в адресах: ` +
        'например example.ru. Ошибка здесь означает, что письма будут уходить от несуществующего ' +
        'домена и их отобьют все крупные почтовые службы.',
    );
  }
  if (answers.hostname === '') {
    add('hostname', 'Имя сервера нужно задать: без него нечего писать в сертификат и в HELO.');
  } else if (!isFqdn(answers.hostname)) {
    add(
      'hostname',
      `«${answers.hostname}» не похоже на доменное имя. Имя сервера попадает в HELO и в ` +
        'сертификат; чужие серверы сверяют его с обратной записью PTR.',
    );
  }

  if (answers.adminEmail === '') {
    add('adminEmail', 'Без адреса администратора некому будет войти в почту и в панель.');
  } else if (!isEmail(answers.adminEmail)) {
    add('adminEmail', `«${answers.adminEmail}» не похоже на почтовый адрес.`);
  } else if (answers.adminEmail.split('@')[1] !== answers.domain) {
    add(
      'adminEmail',
      `Адрес администратора должен быть в вашем домене: имя@${answers.domain}. ` +
        'Ящик заводится на этом сервере, а чужой домен он обслуживать не может.',
    );
  }

  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(answers.adminLogin)) {
    add(
      'adminLogin',
      'Логин в админке: от 2 до 64 символов, латиница, цифры, точка, дефис и подчёркивание.',
    );
  }

  if (answers.adminPassword === '') {
    add('adminPassword', 'Пароль нужно придумать: без него не войти ни в почту, ни в панель.');
  } else if (answers.adminPassword.length < 10) {
    add(
      'adminPassword',
      'Пароль короче 10 символов. Этим паролем открываются и ящик администратора, ' +
        'и панель управления всем сервером.',
    );
  } else if (isPlaceholderPassword(answers.adminPassword)) {
    add(
      'adminPassword',
      'Это пароль-заглушка из примеров. Он известен всем, кто читал документацию, ' +
        'и уже уезжал на боевые серверы. Придумайте свой.',
    );
  }
  if (answers.adminPassword !== answers.adminPasswordRepeat) {
    add('adminPasswordRepeat', 'Пароли не совпали.');
  }

  if (answers.tls !== 'letsencrypt' && answers.tls !== 'selfsigned' && answers.tls !== 'custom') {
    add('tls', 'Выберите: Let’s Encrypt, свой сертификат или самоподписанный.');
  }
  if (answers.tls === 'custom') {
    // Глубокий разбор — общий для мастера и панели (packages/shared),
    // и делается он на сервере: там же, где сертификат будет применён.
    // Здесь только «поле не заполнено», чтобы не гонять пустое на разбор.
    if (answers.customCert.trim() === '') {
      add('customCert', 'Без файла сертификата ставить нечего.');
    }
    if (answers.customKey.trim() === '') {
      add(
        'customKey',
        'Без приватного ключа сертификат бесполезен: службы не смогут им пользоваться.',
      );
    }
  }
  if (answers.tls === 'letsencrypt' && !isEmail(answers.leEmail)) {
    add(
      'leEmail',
      'Let’s Encrypt присылает на этот адрес предупреждение, если сертификат вот-вот истечёт. ' +
        'Адрес должен быть настоящим и читаемым — почта на этом же сервере для этого не годится: ' +
        'если истёк сертификат, письмо вы можете и не получить.',
    );
  }

  if (answers.bindAddress !== '0.0.0.0' && !isIpv4(answers.bindAddress)) {
    add(
      'bindAddress',
      'Адрес публикации портов: 0.0.0.0 (на всех адресах машины) или конкретный IPv4.',
    );
  }

  const seen = new Map<number, string>();
  for (const field of PORT_FIELDS) {
    const value = answers.ports[field.key];
    if (!isValidPort(value)) {
      add(`port.${field.key}`, `«${field.label}»: номер порта должен быть числом от 1 до 65535.`);
      continue;
    }
    const other = seen.get(value);
    if (other !== undefined) {
      add(
        `port.${field.key}`,
        `Порт ${value} назначен дважды: «${other}» и «${field.label}». Стек не поднимется — ` +
          'docker откажет «port is already allocated».',
      );
    } else {
      seen.set(value, field.label);
    }
  }

  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(answers.subnet)) {
    add('subnet', 'Подсеть стека задаётся в виде 172.28.0.0/16.');
  } else {
    for (const [field, ip, what] of [
      ['resolverIp', answers.resolverIp, 'своего DNS-резольвера'],
      ['dovecotIp', answers.dovecotIp, 'Dovecot'],
    ] as const) {
      if (!isIpv4(ip)) {
        add(field, `Адрес ${what} должен быть IPv4.`);
      } else if (!subnetContains(answers.subnet, ip)) {
        add(
          field,
          `Адрес ${what} (${ip}) не входит в подсеть ${answers.subnet}. Подсеть и адреса ` +
            'внутри неё меняются только вместе, иначе docker откажет «no configured subnet ' +
            `contains IP address ${ip}» и стек не поднимется вовсе.`,
        );
      }
    }
    if (answers.resolverIp === answers.dovecotIp) {
      add('dovecotIp', 'У резольвера и у Dovecot не может быть одного адреса.');
    }
  }

  const sizes: ReadonlyArray<[keyof Answers & string, number, string]> = [
    ['messageMaxBytes', answers.messageMaxBytes, 'Предельный размер письма'],
    ['uploadMaxBytes', answers.uploadMaxBytes, 'Предельный размер вложения'],
    ['composeBodyMaxBytes', answers.composeBodyMaxBytes, 'Предел тела запроса при написании'],
  ];
  for (const [field, value, label] of sizes) {
    if (!Number.isInteger(value) || value < MIN_MESSAGE_BYTES || value > MAX_MESSAGE_BYTES) {
      add(field, `${label}: от 1 МиБ до 512 МиБ.`);
    }
  }
  if (
    Number.isInteger(answers.messageMaxBytes) &&
    Number.isInteger(answers.uploadMaxBytes) &&
    answers.uploadMaxBytes > answers.messageMaxBytes
  ) {
    add(
      'uploadMaxBytes',
      'Вложение не может быть больше письма: интерфейс принял бы файл, а собственный же ' +
        'Postfix отбил бы готовое письмо — человек получил бы отбойник на то, что у него ' +
        'только что приняли.',
    );
  }
  if (!Number.isInteger(answers.defaultQuotaBytes) || answers.defaultQuotaBytes < 1024 * 1024) {
    add('defaultQuotaBytes', 'Квота ящика по умолчанию: не меньше 1 МиБ.');
  }

  return errors;
}
