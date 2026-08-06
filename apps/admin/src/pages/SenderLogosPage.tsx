/**
 * Логотипы доменов отправителей: что нашлось само, что задано вручную,
 * чему логотип запрещён.
 *
 * Требование заказчика дословно: «плюс нужна опция для ручной загрузки
 * и назначения своего лого в кружок для домена».
 *
 * Что из этого следует для страницы:
 *
 *  - СНАЧАЛА СПИСОК. Без него администратор не знает, где вообще есть что
 *    настраивать: доменов в почте сотни, и гадать имена наизусть он не
 *    должен. В списке сразу видно и состояние, и откуда взялась картинка.
 *  - ЧЕТЫРЕ СОСТОЯНИЯ, А НЕ ДВА. «Нашлось само» и «задано вручную» — разные
 *    вещи, и «запрещено» — тоже: запрет не удаляет загруженную картинку,
 *    а удаление картинки не снимает запрет. Это два независимых решения,
 *    и в интерфейсе они двумя кнопками и остаются.
 *  - «Убрать свою» возвращает домен к НАЙДЕННОЙ картинке, а не к пустоте.
 *    Кнопка так и подписана, иначе её принимали бы за «выключить логотип».
 *  - Пределы файла названы ДО выбора файла, а текст отказа приходит с
 *    сервера: там объяснено, что именно не так («это не картинка, а сценарий
 *    PHP», «в SVG найден тег script»), и свой обобщённый текст был бы
 *    хуже во всех случаях.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { api } from '../api/client';
import type { SenderLogoRow } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { Badge, ErrorNotice, Field, Notice, Pager, Panel, Toolbar } from '../components/ui';
import { formatDateTime } from '../lib/format';

const PAGE_SIZE = 25;

const MUTED = { color: 'var(--mt-admin-muted)' } as const;

/** Как называется состояние домена по-человечески. */
function stateLabel(row: SenderLogoRow): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (row.state) {
    case 'blocked':
      return { text: 'запрещён', tone: 'warn' };
    case 'manual':
      return { text: 'своя картинка', tone: 'ok' };
    case 'auto':
      return {
        // Источник называется прямо: «откуда это взялось» — первый вопрос
        // администратора, когда логотип оказался не тем.
        text:
          row.autoSource === 'bimi'
            ? 'найден по BIMI'
            : row.autoSource === 'ai'
              ? 'найден по подсказке ИИ'
              : 'найден по значку сайта',
        tone: 'ok',
      };
    default:
      return { text: 'не найден', tone: 'muted' };
  }
}

export function SenderLogosPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  /** Домен, для которого сейчас открыт выбор файла. */
  const uploadFor = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ['sender-logos', search, offset],
    // Пустой поиск не передаётся вовсе, а не как `undefined`: строгий режим
    // типов различает «поля нет» и «поле есть, но пустое».
    queryFn: () =>
      api.senderLogos({ ...(search ? { q: search } : {}), limit: PAGE_SIZE, offset }),
  });

  const refresh = (message: string): void => {
    void queryClient.invalidateQueries({ queryKey: ['sender-logos'] });
    setFlash(message);
  };

  const upload = useMutation({
    mutationFn: ({ domain, file }: { domain: string; file: File }) =>
      api.uploadSenderLogo(domain, file),
    onSuccess: (state) =>
      refresh(`Для домена ${state.domain} назначена своя картинка — она сильнее найденной.`),
  });

  const reset = useMutation({
    mutationFn: (domain: string) => api.resetSenderLogo(domain),
    onSuccess: (state) =>
      refresh(
        state.state === 'auto'
          ? `Своя картинка убрана: ${state.domain} снова показывает найденную автоматически.`
          : `Своя картинка убрана. У домена ${state.domain} логотипа сейчас нет — в кружке буква.`,
      ),
  });

  const block = useMutation({
    mutationFn: ({ domain, blocked }: { domain: string; blocked: boolean }) =>
      api.setSenderLogoBlocked(domain, blocked),
    onSuccess: (state) =>
      refresh(
        state.state === 'blocked'
          ? `Домену ${state.domain} логотип запрещён — в кружке остаётся буква. Загруженная картинка сохранена.`
          : `Запрет с домена ${state.domain} снят.`,
      ),
  });

  const writable = can('branding.write');
  const busy = upload.isPending || reset.isPending || block.isPending;
  const limits = list.data?.limits;

  const pickFile = (domain: string): void => {
    uploadFor.current = domain;
    fileRef.current?.click();
  };

  return (
    <>
      <PageTitle
        title="Логотипы доменов"
        subtitle="Что показывается в кружке рядом с письмом вместо буквы отправителя"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      {/* Текст отказа — серверный: он называет причину и предел. */}
      <ErrorNotice error={list.error ?? upload.error ?? reset.error ?? block.error} />

      <Panel title="Как это работает">
        <p style={MUTED}>
          Логотип домена сервер ищет сам: сначала в записи BIMI, которую владелец домена
          публикует в DNS специально для почты, затем по значку сайта. Картинки забирает
          и хранит сервер — браузеры пользователей к чужим сайтам не обращаются.
          Логотип показывается только у писем, чья подлинность подтверждена проверкой
          DKIM/DMARC: рядом с поддельным отправителем он опаснее, чем его отсутствие.
        </p>
        <p style={MUTED}>
          Здесь можно вмешаться. Порядок такой: <b>запрет</b> сильнее всего,{' '}
          <b>своя картинка</b> сильнее найденной, найденная действует, когда нет ни того,
          ни другого. Свои картинки хранятся в базе и попадают в резервную копию.
        </p>
        {limits && (
          <p style={MUTED}>
            Файл: PNG, JPEG, WEBP, GIF или SVG, не больше {limits.maxBytesText}, от{' '}
            {limits.minWidth}×{limits.minHeight} до {limits.maxWidth}×{limits.maxHeight} точек.
          </p>
        )}
      </Panel>

      <Panel title="Домены">
        <Toolbar>
          <Field label="Поиск по домену">
            <input
              value={search}
              placeholder="example.com"
              onChange={(e) => {
                setSearch(e.target.value.trim().toLowerCase());
                setOffset(0);
              }}
            />
          </Field>
        </Toolbar>

        {/* Один общий выбор файла на всю таблицу: домен запоминается в
            ссылке перед открытием окна. Пятьдесят скрытых <input> в
            строках — это пятьдесят лишних узлов ради одного нажатия. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            const domain = uploadFor.current;
            // Значение сбрасываем всегда: без этого повторный выбор ТОГО ЖЕ
            // файла не вызывает события, и кнопка кажется сломанной.
            e.target.value = '';
            if (file && domain) upload.mutate({ domain, file });
          }}
        />

        {list.isPending && <p style={MUTED}>Загрузка…</p>}
        {list.data && list.data.items.length === 0 && (
          <p style={MUTED}>
            {search
              ? 'Ничего не найдено.'
              : 'Пока пусто. Домены появляются здесь после того, как с них придут письма и ' +
                'сервер попробует найти логотип.'}
          </p>
        )}

        {list.data && list.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th style={{ width: 56 }}>Логотип</th>
                <th>Домен</th>
                <th>Состояние</th>
                <th>Изменено</th>
                <th style={{ width: 260 }} />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((row) => {
                const label = stateLabel(row);
                return (
                  <tr key={row.domain}>
                    <td>
                      {row.version ? (
                        /* Предпросмотр в том же круге и с той же подложкой,
                           что в почте: администратор должен видеть ровно то,
                           что увидит пользователь, а не картинку на клетчатом
                           фоне редактора. */
                        <span
                          style={{
                            display: 'inline-flex',
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            background: '#fff',
                            boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 8%)',
                            overflow: 'hidden',
                          }}
                        >
                          <img
                            src={api.senderLogoImageUrl(row.domain, row.version)}
                            alt=""
                            width={32}
                            height={32}
                            style={{ width: '100%', height: '100%', padding: '14%', objectFit: 'contain', boxSizing: 'border-box' }}
                          />
                        </span>
                      ) : (
                        <span style={MUTED}>—</span>
                      )}
                    </td>
                    <td>{row.domain}</td>
                    <td>
                      <Badge tone={label.tone === 'muted' ? 'muted' : label.tone}>
                        {label.text}
                      </Badge>
                      {row.state === 'blocked' && row.hasManual && (
                        <span style={{ ...MUTED, marginLeft: 8 }}>своя картинка сохранена</span>
                      )}
                      {row.width !== null && row.state !== 'blocked' && (
                        <span style={{ ...MUTED, marginLeft: 8 }}>
                          {row.width}×{row.height}
                        </span>
                      )}
                    </td>
                    <td style={MUTED}>
                      {row.updatedAt ? (
                        <>
                          {formatDateTime(row.updatedAt)}
                          {row.updatedBy && <> · {row.updatedBy}</>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {writable && (
                        <Toolbar>
                          <Button
                            mode="secondary"
                            size="s"
                            disabled={busy}
                            onClick={() => pickFile(row.domain)}
                          >
                            {row.hasManual ? 'Заменить свою' : 'Загрузить свою'}
                          </Button>
                          {row.hasManual && (
                            <Button
                              mode="secondary"
                              size="s"
                              disabled={busy}
                              title="Домен вернётся к логотипу, найденному автоматически"
                              onClick={() => reset.mutate(row.domain)}
                            >
                              Убрать свою
                            </Button>
                          )}
                          <Button
                            mode="secondary"
                            size="s"
                            disabled={busy}
                            title={
                              row.state === 'blocked'
                                ? 'Разрешить логотип этому домену'
                                : 'Не показывать логотип этому домену — останется буква. Загруженная картинка сохранится.'
                            }
                            onClick={() =>
                              block.mutate({
                                domain: row.domain,
                                blocked: row.state !== 'blocked',
                              })
                            }
                          >
                            {row.state === 'blocked' ? 'Разрешить' : 'Запретить'}
                          </Button>
                        </Toolbar>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {list.data && (
          <Pager
            total={list.data.total}
            limit={list.data.limit}
            offset={list.data.offset}
            onChange={setOffset}
          />
        )}

        {!writable && (
          <p style={MUTED}>
            Изменять логотипы доменов может тот, кому доверено оформление входа
            (право «branding.write»).
          </p>
        )}
      </Panel>
    </>
  );
}
