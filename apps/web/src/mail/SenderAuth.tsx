/**
 * Подлинность отправителя — человеческим языком, а не «spf=none».
 *
 * Было: «SPF: none · DKIM: pass · DMARC: pass». Для того, кто разбирается,
 * это исчерпывающе; для всех остальных — набор незнакомых слов, из которого
 * невозможно понять главное: можно ли верить, что письмо от того, чьё имя
 * стоит в поле «От». А спрашивают об этом ровно в тот момент, когда письмо
 * выглядит подозрительно.
 *
 * Поэтому здесь три уровня подробности сразу:
 *
 *   1. ОБЩИЙ ВЫВОД одной строкой со значком — то, ради чего человек и
 *      открыл эти сведения;
 *   2. три проверки по-русски («подпись письма», а не «DKIM») со своим
 *      значком у каждой;
 *   3. техническое название и сырое значение — мелким, для того, кто
 *      будет разбираться дальше или писать в поддержку.
 *
 * Значок несёт смысл ФОРМОЙ, а не только цветом: галочка, восклицательный
 * знак, крест, тире. Цвет как единственный признак не годится — его не
 * различает часть людей, и он пропадает при печати.
 */
import type { AuthResult } from '@mail-true/shared';
import styles from './SenderAuth.module.css';

/** Во что складывается результат проверки для человека. */
type Verdict = 'ok' | 'warn' | 'bad' | 'skip';

/**
 * Что означает каждое значение.
 *
 *   pass       — проверка пройдена;
 *   fail       — проверка ПРОВАЛЕНА: это не «нет данных», а прямое
 *                несовпадение, то есть письмо, скорее всего, подделано;
 *   softfail   — отправитель сам сказал «такое письмо, вероятно, чужое»;
 *   neutral    — домен намеренно ничего не утверждает;
 *   none       — проверять было нечего: домен не настроил эту проверку;
 *   temperror  — временная ошибка (например, DNS не ответил);
 *   permerror  — постоянная ошибка в настройках домена отправителя.
 */
const VERDICTS: Readonly<Record<AuthResult, Verdict>> = {
  pass: 'ok',
  fail: 'bad',
  softfail: 'warn',
  neutral: 'warn',
  none: 'skip',
  temperror: 'warn',
  permerror: 'warn',
};

const SIGNS: Readonly<Record<Verdict, string>> = {
  ok: '✓',
  warn: '!',
  bad: '✕',
  skip: '–',
};

/** Словесное состояние — оно же попадает в подпись для экранного диктора. */
const STATE_WORD: Readonly<Record<Verdict, string>> = {
  ok: 'пройдена',
  warn: 'под вопросом',
  bad: 'не пройдена',
  skip: 'не проводилась',
};

interface CheckText {
  /** Название по-русски: о чём эта проверка на самом деле. */
  title: string;
  /** Что означает результат — своими словами для каждого исхода. */
  detail: Readonly<Partial<Record<AuthResult, string>>>;
  fallback: string;
}

const CHECKS: Readonly<Record<'spf' | 'dkim' | 'dmarc', CheckText>> = {
  spf: {
    title: 'Сервер отправителя',
    detail: {
      pass: 'письмо пришло с сервера, которому домен разрешил отправку',
      fail: 'домен запрещает отправку с того сервера, откуда пришло письмо',
      softfail: 'домен считает такой сервер сомнительным',
      neutral: 'домен не высказывается об этом сервере',
      none: 'домен не указал, кому разрешено отправлять от его имени',
    },
    fallback: 'проверить не удалось',
  },
  dkim: {
    title: 'Подпись письма',
    detail: {
      pass: 'подпись домена верна — письмо не изменяли в пути',
      fail: 'подпись не сошлась: письмо изменено или подделано',
      none: 'письмо не подписано',
    },
    fallback: 'подпись проверить не удалось',
  },
  dmarc: {
    title: 'Правило домена',
    detail: {
      pass: 'домен подтверждает, что письмо действительно от него',
      fail: 'домен не признаёт это письмо своим',
      none: 'домен не задал правило проверки',
    },
    fallback: 'правило проверить не удалось',
  },
};

/** Техническое имя — для того, кто будет разбираться дальше. */
const TECH: Readonly<Record<'spf' | 'dkim' | 'dmarc', string>> = {
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
};

export interface SenderAuthProps {
  authentication: { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult };
}

/**
 * Общий вывод.
 *
 * Правило то же, по которому сервер решает, показывать ли логотип
 * отправителя (apps/api/src/mail/sender-auth.ts): верить можно, когда
 * сошёлся DMARC или подпись домена. Два места не должны расходиться в
 * оценке одного письма — иначе логотип говорит одно, а сведения другое.
 */
function overall(a: SenderAuthProps['authentication']): { verdict: Verdict; text: string } {
  if (a.dmarc === 'fail' || a.dkim === 'fail' || a.spf === 'fail') {
    return {
      verdict: 'bad',
      text: 'Проверка не пройдена — отправитель, скорее всего, поддельный',
    };
  }
  if (a.dmarc === 'pass' || a.dkim === 'pass') {
    return { verdict: 'ok', text: 'Отправитель подтверждён' };
  }
  return {
    verdict: 'skip',
    text: 'Подтвердить отправителя нечем — домен не настроил проверки',
  };
}

export function SenderAuth({ authentication }: SenderAuthProps) {
  const total = overall(authentication);
  return (
    <div className={styles.root}>
      <p className={cxVerdict(styles['summary'], total.verdict)}>
        <span className={styles.sign} aria-hidden="true">
          {SIGNS[total.verdict]}
        </span>
        <span>{total.text}</span>
      </p>
      <ul className={styles.checks}>
        {(['spf', 'dkim', 'dmarc'] as const).map((key) => {
          const value = authentication[key];
          const verdict = VERDICTS[value];
          const text = CHECKS[key].detail[value] ?? CHECKS[key].fallback;
          return (
            <li key={key} className={cxVerdict(styles['check'], verdict)}>
              <span className={styles.sign} aria-hidden="true">
                {SIGNS[verdict]}
              </span>
              <span className={styles.checkBody}>
                <span className={styles.checkTitle}>
                  {CHECKS[key].title}
                  {/* Слово состояния — для экранного диктора и для печати,
                      где значок и цвет ничего не сообщают. */}
                  <span className={styles.srOnly}> — проверка {STATE_WORD[verdict]}</span>
                </span>
                <span className={styles.checkDetail}>{text}</span>
                <span className={styles.checkTech}>
                  {TECH[key]}: {value}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function cxVerdict(base: string | undefined, verdict: Verdict): string {
  const extra = styles[verdict];
  return [base, extra].filter(Boolean).join(' ');
}
