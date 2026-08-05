/**
 * Заглушки разделов из docs/admin-spec.md, до которых очередь ещё не дошла.
 * Навигация к ним настоящая, содержимое — честное описание того,
 * что здесь появится и откуда будут браться данные.
 */
import { PageTitle } from '../app/AdminLayout';
import { Notice, Panel } from '../components/ui';

interface StubSpec {
  title: string;
  subtitle: string;
  planned: string[];
  source: string;
}

const STUBS: Readonly<Record<string, StubSpec>> = {
  flow: {
    title: 'Почтовый поток',
    subtitle: 'Очередь Postfix и журнал доставки',
    planned: [
      'Очередь Postfix: что застряло, почему и сколько было попыток',
      'Протолкнуть письмо из очереди или удалить его',
      'Журнал доставки с поиском по отправителю, получателю, теме и дате',
    ],
    source:
      'Данные будут браться из postqueue -j и разбора журнала Postfix; ' +
      'потребуется доступ API к контейнеру postfix.',
  },
  spam: {
    title: 'Спам',
    subtitle: 'Пороги Rspamd, списки, обучение',
    planned: [
      'Пороги срабатывания и действия (greylist, add header, reject)',
      'Белые и чёрные списки по адресам и доменам',
      'Ручное обучение на примерах писем',
      'Статистика срабатываний правил',
    ],
    source:
      'Данные будет отдавать HTTP-API rspamd на порту 11334 (пароль RSPAMD_PASSWORD), ' +
      'списки — файлы в infra/rspamd/local.d.',
  },
  monitoring: {
    title: 'Наблюдение',
    subtitle: 'Состояние сервисов, место на диске, сертификаты',
    planned: [
      'Занятое и свободное место на диске, размер Maildir по доменам',
      'Число писем и нагрузка',
      'Срок действия TLS-сертификатов',
      'Размер очереди и её динамика',
    ],
    source:
      'Часть сведений уже есть в разделе «Дашборд» (состояние сервисов и счётчики). ' +
      'Остальное потребует сбора метрик с хоста.',
  },
  backups: {
    title: 'Резервные копии',
    subtitle: 'Расписание, выгрузка, восстановление',
    planned: [
      'Расписание копий и их состояние',
      'Выгрузка отдельного ящика и всего сервера',
      'Восстановление из копии',
      'Проверка, что копия читается: копия без проверки восстановления — не копия',
    ],
    source: 'Потребует отдельного сервиса выгрузки и хранилища копий.',
  },
};

export function StubPage({ id }: { id: keyof typeof STUBS | string }) {
  const spec = STUBS[id];
  if (!spec) {
    return (
      <>
        <PageTitle title="Раздел не найден" />
        <Notice tone="error">Такого раздела нет.</Notice>
      </>
    );
  }

  return (
    <>
      <PageTitle title={spec.title} subtitle={spec.subtitle} />
      <Notice tone="info">
        Раздел ещё не сделан. Ниже — что в нём будет, чтобы было видно объём работы.
      </Notice>
      <Panel title="Что здесь появится">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {spec.planned.map((item) => (
            <li key={item} style={{ marginBottom: 4 }}>
              {item}
            </li>
          ))}
        </ul>
        <p style={{ marginBottom: 0, color: 'var(--mt-color-text-secondary)' }}>{spec.source}</p>
      </Panel>
    </>
  );
}
