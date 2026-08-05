/**
 * Пределы длины почтового адреса и отображаемого имени — серверная сторона.
 *
 * Числа и формулировки совпадают с apps/admin/src/lib/mailboxName.ts:
 * интерфейс объясняет ошибку до отправки запроса, сервер — решает.
 *
 *   * локальная часть (до «@») по RFC 5321 — не длиннее 64 ОКТЕТОВ;
 *   * адрес целиком по той же спецификации — не длиннее 320 октетов;
 *   * virtual_users.email — VARCHAR(255), а Postgres считает СИМВОЛЫ,
 *     поэтому это отдельное ограничение, а не то же самое другими словами.
 *
 * Без явной проверки слишком длинный адрес доходил до базы и возвращался
 * человеку как «Некорректные данные запроса» — общей ошибкой проверки,
 * из которой непонятно ни что длинно, ни насколько.
 */

/** Локальная часть адреса — до «@». RFC 5321, октеты. */
export const LOCAL_PART_MAX_BYTES = 64;

/** Адрес целиком. RFC 5321, октеты. */
export const ADDRESS_MAX_BYTES = 320;

/** Адрес целиком: virtual_users.email — VARCHAR(255), символы. */
export const ADDRESS_MAX_CHARS = 255;

/** Отображаемое имя: virtual_users.display_name — VARCHAR(255), символы. */
export const DISPLAY_NAME_MAX_CHARS = 255;

/** Длина в байтах UTF-8 — именно её ограничивает почтовый протокол. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Длина в символах так, как её считает Postgres. */
export function charLength(text: string): number {
  return [...text].length;
}

function bytesHint(text: string): string {
  return byteLength(text) > charLength(text)
    ? ' Кириллическая буква занимает два байта, поэтому символов помещается меньше.'
    : '';
}

/**
 * Причина отказа по длине адреса или null, если длина в порядке.
 * Возвращается готовая фраза: что длинно, каков предел, сколько сейчас.
 */
export function addressLengthProblem(email: string): string | null {
  const address = email.trim();
  if (address === '') return null;

  const at = address.lastIndexOf('@');
  const local = at === -1 ? address : address.slice(0, at);

  const localBytes = byteLength(local);
  if (localBytes > LOCAL_PART_MAX_BYTES) {
    return (
      `Имя ящика (часть до «@») не может быть длиннее ${LOCAL_PART_MAX_BYTES} байт — ` +
      `сейчас ${localBytes}.${bytesHint(local)}`
    );
  }

  const addressBytes = byteLength(address);
  if (addressBytes > ADDRESS_MAX_BYTES) {
    return `Адрес целиком не может быть длиннее ${ADDRESS_MAX_BYTES} байт — сейчас ${addressBytes}.${bytesHint(address)}`;
  }

  const addressChars = charLength(address);
  if (addressChars > ADDRESS_MAX_CHARS) {
    return `Адрес не поместится в хранилище: не длиннее ${ADDRESS_MAX_CHARS} символов — сейчас ${addressChars}.`;
  }

  return null;
}

/**
 * Форма адреса — человеческим языком.
 *
 * Раньше форму проверял zod (`.email()`), и любой непонравившийся адрес
 * возвращался как «Некорректные данные запроса»: ни что не так, ни где.
 * Особенно обидно это было с кириллицей — самая частая опечатка
 * (раскладка не переключилась) выглядела как поломка панели.
 */
export function addressShapeProblem(email: string): string | null {
  const address = email.trim();
  if (address === '') return 'Адрес не заполнен.';

  if (/\s/u.test(address)) return 'В адресе есть пробел — адреса пишутся без пробелов.';

  const parts = address.split('@');
  if (parts.length === 1) {
    return 'В адресе нет знака «@». Адрес выглядит так: имя@домен, например ivan@mail.local.';
  }
  if (parts.length > 2) return 'В адресе больше одного знака «@».';

  const [local = '', domain = ''] = parts;
  if (local === '') return 'В адресе не хватает имени ящика — части до «@».';
  if (domain === '') return 'В адресе не хватает домена — части после «@».';

  // Кириллица (и любая другая не-латиница) — почти всегда незакрытая раскладка
  const foreign = [...address].filter((ch) => ch.charCodeAt(0) > 127);
  if (foreign.length > 0) {
    const shown = [...new Set(foreign)].slice(0, 5).join('');
    return (
      `В адресе есть буквы не латинского алфавита: «${shown}». ` +
      'Почтовый адрес записывается латиницей — похоже, не переключилась раскладка.'
    );
  }

  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)) {
    return 'В имени ящика есть знаки, которые в адресе недопустимы.';
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return 'Точка в имени ящика не может стоять с краю и не может идти подряд.';
  }
  if (!domain.includes('.')) {
    return `В домене «${domain}» нет точки — домен выглядит так: mail.local.`;
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(domain) || domain.startsWith('-') || domain.includes('..')) {
    return `Домен «${domain}» записан неверно.`;
  }

  return null;
}

/** Форма и длина одной проверкой — в том порядке, в каком их читает человек. */
export function addressProblem(email: string): string | null {
  return addressShapeProblem(email) ?? addressLengthProblem(email);
}

/** То же для отображаемого имени: предел в символах, и так и сказано. */
export function displayNameLengthProblem(name: string): string | null {
  const value = name.trim();
  const chars = charLength(value);
  if (chars > DISPLAY_NAME_MAX_CHARS) {
    return `Отображаемое имя не может быть длиннее ${DISPLAY_NAME_MAX_CHARS} символов — сейчас ${chars}.`;
  }
  return null;
}
