/**
 * Защита установщика до того, как в системе появился первый пароль.
 *
 * ------------------------------------------------------------------
 * ЗАДАЧА
 * ------------------------------------------------------------------
 * Мастер первого запуска работает до создания администратора: спрашивать
 * пароль не у кого. При этом за ним стоит сокет Docker, то есть права root
 * на машине. Открытая страница на публичном порту равнозначна открытому
 * root-доступу для любого, кто первым до неё дотянулся, — а «поднял стек и
 * ушёл на обед» является совершенно обычным сценарием.
 *
 * ------------------------------------------------------------------
 * ЧТО ВЫБРАНО И ПОЧЕМУ ИМЕННО ЭТО
 * ------------------------------------------------------------------
 * Одноразовый ключ, напечатанный в журнал контейнера при старте:
 *
 *     docker compose -f infra/docker-compose.yml logs installer
 *
 * Так делают Portainer (первый вход по ключу из журнала) и Nextcloud
 * (файл с паролем на диске сервера). Смысл один: ПРАВО НАЧАТЬ УСТАНОВКУ
 * даётся тому, у кого уже есть доступ к машине. Такой человек и так может
 * всё — значит ключ не создаёт нового доверия, а только не раздаёт его
 * посторонним.
 *
 * Что рассматривалось и отвергнуто:
 *
 *   • «Первый, кто открыл страницу, тот и хозяин» (как в некоторых мастерах).
 *     Гонка: достаточно сканера портов, который окажется быстрее человека.
 *     Проиграв её, вы об этом даже не узнаете.
 *
 *   • Пароль в переменной окружения. Он остаётся в infra/.env и в
 *     `docker inspect` навсегда, то есть переживает установку — тогда как
 *     смысл ключа в том, что он живёт ровно один сеанс.
 *
 *   • Доступ только с 127.0.0.1. Правильно и слишком строго: сервер обычно
 *     стоит в другом месте, и «зайдите с самой машины» означает «пробросьте
 *     туннель SSH» — то есть отменяет всю затею с браузером. Возможность
 *     оставлена (INSTALLER_BIND=127.0.0.1), но по умолчанию не навязывается.
 *
 * Ключ живёт ТОЛЬКО в памяти процесса: перезапуск контейнера выдаёт новый,
 * а старый перестаёт действовать. На диск он не пишется нигде.
 *
 * ------------------------------------------------------------------
 * ПОДБОР КЛЮЧА
 * ------------------------------------------------------------------
 * 128 случайных бит перебором не берутся, но защита от перебора всё равно
 * нужна: она превращает «мы не знаем, пытался ли кто-нибудь» в запись в
 * журнале. После 10 неудач подряд установщик закрывается на 15 минут и
 * пишет об этом — это видно и человеку, и тому, кто потом разбирается.
 *
 * Сравнение — постоянное по времени: обычное сравнение строк отвечает тем
 * быстрее, чем раньше расходятся байты, и по этой разнице ключ подбирается
 * побайтово. Разница в сотни наносекунд по локальной сети измерима.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface AuthVerdict {
  readonly ok: boolean;
  /** Причина словами — она же уходит в ответ и в журнал. */
  readonly reason: string;
  readonly lockedUntil: number | null;
}

/**
 * Ключ читают глазами из журнала и набирают руками. Поэтому не base64:
 * буквы «I», «l», «O» и цифры «0», «1» в наборе не участвуют, а сам ключ
 * разбит на группы по четыре. Ошибиться при наборе всё ещё можно, но
 * тогда об этом скажет отказ, а не «почему-то не пускает».
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateKey(groups = 6, groupSize = 4): string {
  const total = groups * groupSize;
  const bytes = randomBytes(total * 2);
  let out = '';
  for (let i = 0; i < total; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return (out.match(new RegExp(`.{1,${groupSize}}`, 'g')) ?? [out]).join('-');
}

/** Ключ набирают руками: регистр и лишние пробелы прощаем, остальное — нет. */
export function normalizeKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export class InstallerKey {
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly key: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get value(): string {
    return this.key;
  }

  verify(candidate: string): AuthVerdict {
    const now = this.now();
    if (now < this.lockedUntil) {
      const minutes = Math.ceil((this.lockedUntil - now) / 60_000);
      return {
        ok: false,
        reason:
          `Слишком много неверных ключей подряд. Установщик закрыт ещё на ${minutes} мин. ` +
          'Если это были не вы — до порта установщика кто-то дотягивается снаружи; ' +
          'остановите службу: docker compose -f infra/docker-compose.yml --profile installer down',
        lockedUntil: this.lockedUntil,
      };
    }

    const given = Buffer.from(normalizeKey(candidate), 'utf8');
    const expected = Buffer.from(this.key, 'utf8');
    const same = given.length === expected.length && timingSafeEqual(given, expected);
    if (same) {
      this.failures = 0;
      return { ok: true, reason: '', lockedUntil: null };
    }

    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.failures = 0;
      return {
        ok: false,
        reason: 'Слишком много неверных ключей подряд. Установщик закрыт на 15 минут.',
        lockedUntil: this.lockedUntil,
      };
    }
    return {
      ok: false,
      reason:
        `Ключ не подошёл. Осталось попыток: ${MAX_FAILURES - this.failures}. ` +
        'Ключ печатается при запуске установщика: ' +
        'docker compose -f infra/docker-compose.yml logs installer',
      lockedUntil: null,
    };
  }
}

/** Приглашение в журнал контейнера — единственное место, где ключ виден. */
export function keyBanner(key: string, port: string): string {
  const line = '='.repeat(66);
  return [
    '',
    line,
    '  Mail.True — мастер первого запуска',
    '',
    `  Откройте в браузере:   http://<адрес сервера>:${port}/`,
    `  Ключ доступа:          ${key}`,
    '',
    '  Ключ действует до перезапуска этой службы и нигде не сохраняется.',
    '  Он нужен потому, что администратора ещё не существует: спрашивать',
    '  пароль не у кого, а за установщиком стоит полный доступ к машине.',
    '',
    '  Показать ключ снова:',
    '    docker compose -f infra/docker-compose.yml logs installer',
    line,
    '',
  ].join('\n');
}
