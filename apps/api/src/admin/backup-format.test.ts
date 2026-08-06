/**
 * Формат резервной копии настроек и план восстановления.
 *
 * Каждая проверка закрывает требование заказчика и падает на коде без
 * backup-format.ts:
 *
 *   1. «Файл копии должен быть переносим между установками; версия
 *      формата внутри обязательна» — номер лежит в файле, копия из другой
 *      версии отвергается ПОНЯТНЫМ текстом, а не читается как получится.
 *   2. «Восстановление обязано показывать, ЧТО именно будет перезаписано» —
 *      план перечисляет объекты поимённо, а не считает их числом.
 *   3. «Не должно молча ломать доступ к базе» — в копии нет ни одной
 *      переменной окружения; см. MT_VOLUME_BOUND_ENV_KEYS в
 *      install/lib/common.sh: пароль Postgres привязан к тому базы.
 *   4. Решение по секретам: хэши паролей внутри есть (иначе копия —
 *      это массовый сброс паролей), ключи, зашифрованные ключом из .env, —
 *      нет (на другой установке они не расшифруются).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestError } from '../errors.js';
import {
  BACKUP_SECTIONS,
  buildRestorePlan,
  buildSettingsBackup,
  countSections,
  parseSettingsBackup,
  SETTINGS_BACKUP_KIND,
  SETTINGS_BACKUP_VERSION,
  type CurrentSnapshot,
  type SettingsBackupFile,
} from './backup-format.js';

/* ------------------------------------------------------------------ */
/* Заготовки                                                            */
/* ------------------------------------------------------------------ */

function sampleBackup(): SettingsBackupFile {
  return buildSettingsBackup({
    source: { hostname: 'mail.staraya.ru', domain: 'staraya.ru' },
    data: {
      domains: [
        {
          name: 'staraya.ru',
          dkimSelector: 'mail',
          dkimPublicKey: 'MIIBIjAN',
          dkimDnsRecord: 'v=DKIM1; k=rsa; p=MIIBIjAN',
          notes: null,
        },
      ],
      mailboxes: [
        {
          email: 'ivan@staraya.ru',
          displayName: 'Иван',
          quotaBytes: 1073741824,
          active: true,
          passwordHash: '{SHA512-CRYPT}$6$соль$хэш',
        },
        {
          email: 'petr@staraya.ru',
          displayName: null,
          quotaBytes: 2147483648,
          active: false,
          passwordHash: '{SHA512-CRYPT}$6$соль2$хэш2',
        },
      ],
      aliases: [{ source: 'info@staraya.ru', destination: 'ivan@staraya.ru', active: true }],
      admins: [
        {
          login: 'osmotr',
          displayName: 'Дежурный',
          role: 'owner',
          active: true,
          passwordHash: 'scrypt$16384$8$1$соль$хэш',
        },
      ],
      userSettings: [
        {
          accountEmail: 'ivan@staraya.ru',
          settings: { account_email: 'ivan@staraya.ru', sender_name: 'Иван', reply_quote: true },
          signatures: [{ name: 'Основная', bodyHtml: '<p>Иван</p>', isDefault: true, position: 0 }],
          filters: [
            {
              name: 'От начальника',
              position: 0,
              enabled: true,
              isAuto: false,
              matchMode: 'all',
              conditions: [{ field: 'from', op: 'contains', value: 'boss@' }],
              actions: { folder: 'Работа' },
            },
          ],
        },
      ],
      ai: [
        {
          domain: 'staraya.ru',
          enabled: true,
          baseUrl: 'https://api.example.org/v1',
          chatPath: '/chat/completions',
          model: 'gpt-4o-mini',
          providerLabel: 'Сервис ИИ',
          isLocal: false,
          maxBodyChars: 8000,
          timeoutMs: 30000,
          maxOutputTokens: 1024,
          apiKeyPresent: true,
        },
      ],
      branding: {
        companyName: 'ООО «Старая»',
        productName: null,
        logo: null,
        logoBase64: null,
      },
    },
    now: new Date('2026-01-15T10:00:00.000Z'),
  });
}

function emptyCurrent(): CurrentSnapshot {
  return {
    domains: [],
    mailboxes: [],
    aliases: [],
    admins: [],
    userSettings: new Map(),
    ai: [],
    brandingLogo: false,
  };
}

function refusal(text: string): string {
  try {
    parseSettingsBackup(text);
  } catch (err) {
    assert.ok(err instanceof BadRequestError, 'отказ обязан быть 400');
    return err.message;
  }
  assert.fail('файл должен был быть отклонён');
}

/* ------------------------------------------------------------------ */
/* Версия формата                                                       */
/* ------------------------------------------------------------------ */

test('в файле копии есть метка и номер версии формата', () => {
  const file = sampleBackup();
  assert.equal(file.kind, SETTINGS_BACKUP_KIND);
  assert.equal(file.version, SETTINGS_BACKUP_VERSION);
  assert.ok(file.createdAt.startsWith('2026-01-15'));
});

test('копия своей версии читается целиком', () => {
  const file = parseSettingsBackup(JSON.stringify(sampleBackup()));
  assert.equal(file.data.mailboxes.length, 2);
  assert.equal(file.data.userSettings[0]?.filters.length, 1);
  assert.deepEqual(countSections(file), {
    domains: 1,
    mailboxes: 2,
    aliases: 1,
    admins: 1,
    userSettings: 1,
    ai: 1,
    branding: 1,
  });
});

test('копия из БУДУЩЕЙ версии отвергается, а не читается «как получится»', () => {
  const future = { ...sampleBackup(), version: SETTINGS_BACKUP_VERSION + 1 };
  const message = refusal(JSON.stringify(future));
  assert.match(message, /более новой версией/u);
  assert.ok(message.includes(String(SETTINGS_BACKUP_VERSION + 1)));
  assert.match(message, /Обновите/u);
});

test('копия устаревшего формата отвергается с подсказкой, что делать', () => {
  const old = { ...sampleBackup(), version: 0 };
  const message = refusal(JSON.stringify(old));
  assert.match(message, /устаревшем формате/u);
  assert.match(message, /снимите копию заново/u);
});

test('файл без номера версии не восстанавливается вовсе', () => {
  const headless = { ...sampleBackup() } as Record<string, unknown>;
  delete headless.version;
  assert.match(refusal(JSON.stringify(headless)), /нет номера версии/u);
});

test('чужой файл отвергается по метке, а не по случайному полю', () => {
  assert.match(refusal(JSON.stringify({ kind: 'что-то другое' })), /не копия настроек Mail\.True/u);
  assert.match(refusal('не json вовсе'), /не читается как JSON/u);
  assert.match(refusal('"строка"'), /не объект JSON/u);
});

test('битая копия называет поле, из-за которого не читается', () => {
  const broken = sampleBackup() as unknown as { data: { mailboxes: unknown[] } };
  broken.data.mailboxes = [{ email: 'ivan@staraya.ru' }];
  const message = refusal(JSON.stringify(broken));
  assert.match(message, /mailboxes/u);
  assert.match(message, /повреждена/u);
});

/* ------------------------------------------------------------------ */
/* Секреты                                                              */
/* ------------------------------------------------------------------ */

test('хэши паролей в копии ЕСТЬ: иначе восстановление — это сброс паролей всем', () => {
  const file = sampleBackup();
  assert.ok(file.containsSecrets, 'файл обязан честно объявлять, что несёт секреты');
  assert.match(file.data.mailboxes[0]?.passwordHash ?? '', /SHA512-CRYPT/u);
  assert.match(file.data.admins[0]?.passwordHash ?? '', /^scrypt\$/u);
});

test('ключ доступа к сервису ИИ в копию не входит — только признак его наличия', () => {
  const file = sampleBackup();
  const text = JSON.stringify(file);
  assert.equal(file.data.ai[0]?.apiKeyPresent, true);
  assert.doesNotMatch(text, /api_key_enc|apiKeyEnc/u);
});

test('переменных окружения в копии нет ни одной: пароль Postgres привязан к тому базы', () => {
  const text = JSON.stringify(sampleBackup());
  for (const key of ['POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_DB', 'DATABASE_URL']) {
    assert.doesNotMatch(text, new RegExp(key, 'u'), `${key} в копии настроек быть не должно`);
  }
});

test('секрета двухфакторной проверки в копии нет', () => {
  assert.doesNotMatch(JSON.stringify(sampleBackup()), /totp/iu);
});

/* ------------------------------------------------------------------ */
/* План восстановления                                                  */
/* ------------------------------------------------------------------ */

test('на пустой установке всё из копии — «появится», перезаписывать нечего', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.novaya.ru',
  });
  const domains = plan.sections.find((s) => s.id === 'domains');
  assert.deepEqual(domains?.create, ['staraya.ru']);
  assert.deepEqual(domains?.overwrite, []);
  const boxes = plan.sections.find((s) => s.id === 'mailboxes');
  assert.deepEqual(boxes?.create, ['ivan@staraya.ru', 'petr@staraya.ru']);
});

test('план называет ПОИМЁННО то, что перезапишется', () => {
  const current = emptyCurrent();
  current.domains = ['staraya.ru'];
  current.mailboxes = ['ivan@staraya.ru'];
  current.aliases = ['info@staraya.ru → ivan@staraya.ru'];

  const plan = buildRestorePlan(sampleBackup(), current, {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  const boxes = plan.sections.find((s) => s.id === 'mailboxes');
  assert.deepEqual(
    boxes?.overwrite,
    ['ivan@staraya.ru'],
    'имя перезаписываемого ящика обязано быть видно',
  );
  assert.deepEqual(boxes?.create, ['petr@staraya.ru']);
  const aliases = plan.sections.find((s) => s.id === 'aliases');
  assert.deepEqual(aliases?.overwrite, ['info@staraya.ru → ivan@staraya.ru']);
});

test('перезапись ящиков предупреждает про смену пароля — это не мелочь', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  const boxes = plan.sections.find((s) => s.id === 'mailboxes');
  assert.ok(boxes?.warnings.some((w) => /сменится пароль/u.test(w)));
});

test('то, чего в копии нет, считается «не тронуто» — восстановление не удаляет', () => {
  const current = emptyCurrent();
  current.mailboxes = ['ivan@staraya.ru', 'novyi@staraya.ru', 'eshe@staraya.ru'];
  const plan = buildRestorePlan(sampleBackup(), current, {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  const boxes = plan.sections.find((s) => s.id === 'mailboxes');
  assert.equal(boxes?.untouched, 2, 'два ящика, заведённых после копии, обязаны остаться');
  assert.ok(plan.warnings.some((w) => /ничего не удаляет/u.test(w)));
});

test('план предупреждает, если в копии есть учётка того, кто восстанавливает', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'osmotr',
    hostname: 'mail.staraya.ru',
  });
  const admins = plan.sections.find((s) => s.id === 'admins');
  assert.ok(
    admins?.warnings.some((w) => /Ваш пароль и роль будут заменены/u.test(w)),
    'потерять доступ к панели восстановлением копии нельзя молча',
  );
});

test('план говорит про доступ к базе прямым текстом', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  assert.ok(
    plan.warnings.some((w) => /infra\/\.env/u.test(w) && /Postgres/u.test(w)),
    'человек должен видеть, что параметры базы не трогаются',
  );
});

test('перенос на другой сервер отмечается предупреждением, но не запрещается', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.novaya.ru',
  });
  assert.ok(plan.warnings.some((w) => /mail\.staraya\.ru/u.test(w) && /mail\.novaya\.ru/u.test(w)));
});

test('замена правил ящика показана числами «было → станет»', () => {
  const current = emptyCurrent();
  current.userSettings.set('ivan@staraya.ru', { filters: 3, signatures: 2 });
  const plan = buildRestorePlan(sampleBackup(), current, {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  const settings = plan.sections.find((s) => s.id === 'userSettings');
  assert.ok(settings?.overwrite[0]?.includes('правил 3 → 1'));
  assert.ok(settings?.overwrite[0]?.includes('подписей 2 → 1'));
  assert.ok(settings?.warnings.some((w) => /заменяются целиком/u.test(w)));
});

test('ключ ИИ отдельно предупреждается: его в копии нет и он не восстановится', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  const ai = plan.sections.find((s) => s.id === 'ai');
  assert.ok(ai?.warnings.some((w) => /ключ нужно ввести заново/u.test(w)));
});

test('домены, которых нет нигде, называются в предупреждении', () => {
  const file = sampleBackup();
  file.data.mailboxes.push({
    email: 'kto@drugoy.ru',
    displayName: null,
    quotaBytes: 0,
    active: true,
    passwordHash: '{SHA512-CRYPT}$6$x$y',
  });
  const plan = buildRestorePlan(file, emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  assert.ok(plan.warnings.some((w) => /drugoy\.ru/u.test(w)));
});

test('выбранные разделы ограничивают план, остальные в него не попадают', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
    sections: ['branding'],
  });
  assert.deepEqual(
    plan.sections.map((s) => s.id),
    ['branding'],
  );
});

test('у каждого раздела есть название по-русски — план читает человек', () => {
  const plan = buildRestorePlan(sampleBackup(), emptyCurrent(), {
    currentAdminLogin: 'admin',
    hostname: 'mail.staraya.ru',
  });
  assert.equal(plan.sections.length, BACKUP_SECTIONS.length);
  for (const section of plan.sections) {
    assert.ok(section.title.length > 0);
    assert.match(section.title, /[а-яА-Я]/u);
  }
});
