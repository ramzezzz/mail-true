/**
 * Пересоздание службы не имеет права стирать чужие строки из infra/.env.
 *
 * ------------------------------------------------------------------
 * ЧТО БЫЛО
 * ------------------------------------------------------------------
 * Настройка сервера живёт в двух местах: в базе (её пишет панель) и в
 * infra/.env (его правит человек с доступом по SSH — руками или
 * установщиком). База сильнее файла, поэтому «вернуть к умолчанию»
 * обязано убрать строку и из файла. Убирает её посредник, а он бывает
 * недоступен — тогда сброс остаётся сделанным наполовину и его догоняют
 * при ближайшем пересоздании службы.
 *
 * «Что догонять» вычислялось по признаку «значение сейчас берётся из
 * файла, а не из базы». Признак неверный: под него попадает не только
 * забытый след панели, но и ЛЮБАЯ настройка, прописанная в infra/.env
 * руками.
 *
 * Живой сценарий: администратор при установке прописал
 * GEOIP_LOGIN_POLICY=allow и список стран, полгода всё работало — и
 * первое же нажатие «Пересоздать» ради совершенно другой настройки молча
 * стирало обе строки, выключая защиту по стране. Ни предупреждения, ни
 * следа: с точки зрения панели ничего не менялось.
 *
 * Здесь закреплено обратное: трогается ровно то, что панель сама не
 * смогла убрать, и ничего сверх.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRecreateEnv } from './routes/restart.js';
import { ServerSettings } from './server-settings.js';

/** База в памяти: ровно те запросы, что делает ServerSettings. */
class FakeDb {
  settings = new Map<string, string>();
  debt = new Set<string>();

  async query<T>(text: string, values: unknown[] = []): Promise<T[]> {
    if (text.includes('server_settings_env_debt')) {
      const [a, b] = values as [string, unknown];
      if (text.startsWith('INSERT')) {
        this.debt.add(`${b as string}:${a}`);
        return [];
      }
      if (text.startsWith('SELECT')) {
        return [...this.debt]
          .filter((row) => row.startsWith(`${a}:`))
          .map((row) => ({ key: row.slice(a.length + 1) }))
          .sort((x, y) => x.key.localeCompare(y.key)) as unknown as T[];
      }
      if (text.startsWith('DELETE')) {
        for (const key of b as string[]) this.debt.delete(`${a}:${key}`);
        return [];
      }
    }
    if (text.startsWith('SELECT')) {
      return [...this.settings].map(([key, value]) => ({
        key,
        value,
        updated_by: 'osmotr',
        updated_at: new Date(),
      })) as unknown as T[];
    }
    if (text.startsWith('INSERT')) {
      const [key, value] = values as [string, string];
      this.settings.set(key, value);
      return [];
    }
    if (text.startsWith('DELETE')) {
      this.settings.delete((values as [string])[0]);
      return [];
    }
    return [];
  }
}

function build(env: NodeJS.ProcessEnv): { db: FakeDb; settings: ServerSettings } {
  const db = new FakeDb();
  return { db, settings: new ServerSettings({ db, env, cacheMs: 0 }) };
}

test('настройка из infra/.env, которую панель не трогала, переживает пересоздание', async () => {
  /*
   * Ровно тот случай, ради которого всё и переписано: строки прописаны
   * при установке, панель их не касалась, в базе их нет.
   */
  const { settings } = build({
    MAIL_DOMAIN: 'mail.local',
    GEOIP_LOGIN_POLICY: 'allow',
    GEOIP_ALLOWED_COUNTRIES: 'RU,BY',
  });

  const env = await collectRecreateEnv(settings, 'api', 'recreate');

  assert.equal(
    env.__unset,
    undefined,
    'пересоздание не имеет права трогать строки, которых панель не писала',
  );
  assert.equal(Object.keys(env).length, 0, 'записывать в файл тоже нечего: в базе настроек нет');
});

test('сброшенная настройка, которую не удалось убрать, догоняется при пересоздании', async () => {
  const { settings } = build({ MAIL_DOMAIN: 'mail.local', GEOIP_LOGIN_POLICY: 'allow' });

  // Так делает маршрут сброса, когда посредник отказал.
  await settings.oweEnvUnset('GEOIP_LOGIN_POLICY', 'api');

  const env = await collectRecreateEnv(settings, 'api', 'recreate');
  assert.equal(env.__unset, 'GEOIP_LOGIN_POLICY');
});

test('долг гасится и второй раз не приходит', async () => {
  const { settings } = build({ MAIL_DOMAIN: 'mail.local', GEOIP_LOGIN_POLICY: 'allow' });
  await settings.oweEnvUnset('GEOIP_LOGIN_POLICY', 'api');

  await settings.clearEnvUnsetDebt(['GEOIP_LOGIN_POLICY'], 'api');

  const env = await collectRecreateEnv(settings, 'api', 'recreate');
  assert.equal(
    env.__unset,
    undefined,
    'непогашенный долг просил бы убрать строку снова после каждого пересоздания',
  );
});

test('долг числится за своей службой, а не за всеми сразу', async () => {
  /*
   * У посредника список разрешённых ключей свой у каждой службы, и
   * убирать надо ровно там, где разрешено. Общий на всех список означал
   * бы отказ посредника на каждом чужом ключе.
   */
  const { settings } = build({ MAIL_DOMAIN: 'mail.local' });
  await settings.oweEnvUnset('GEOIP_LOGIN_POLICY', 'api');

  assert.deepEqual(await settings.envUnsetDebt('api'), ['GEOIP_LOGIN_POLICY']);
  assert.deepEqual(await settings.envUnsetDebt('nginx'), []);
});

test('заданное в панели по-прежнему уезжает в файл', async () => {
  /*
   * Обратная сторона: пересоздание без этих значений бессмысленно —
   * контейнер поднялся бы с прежним окружением, а человек видел бы
   * сохранённую настройку, которая не работает.
   */
  const { settings } = build({ MAIL_DOMAIN: 'mail.local' });
  await settings.set('GEOIP_LOGIN_POLICY', 'log', 'osmotr');

  const env = await collectRecreateEnv(settings, 'api', 'recreate');
  assert.equal(env.GEOIP_LOGIN_POLICY, 'log');
});

test('обычный перезапуск в файл не лезет вовсе', async () => {
  const { settings } = build({ MAIL_DOMAIN: 'mail.local' });
  await settings.oweEnvUnset('GEOIP_LOGIN_POLICY', 'api');

  assert.deepEqual(await collectRecreateEnv(settings, 'api', 'restart'), {});
});
