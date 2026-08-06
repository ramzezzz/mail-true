/**
 * Оформление входа (OEM): свой логотип и подписи на страницах входа.
 *
 * Требование заказчика дословно: «Возможность изменять логотип логин
 * страницы (oem) на свой, из админки, как это есть в керио коннект».
 *
 * Что из этого следует для страницы:
 *
 *  - пределы (формат, размер, точки) названы ДО загрузки, а не только в
 *    тексте отказа: человек не должен узнавать про 512 КБ, уже выбрав
 *    файл на 6 МБ;
 *  - отказ показывается словами сервера — там объяснено, что именно не
 *    так («это не картинка, а сценарий PHP», «4032×3024 — предел
 *    2000×1000»), и придумывать свой текст здесь нельзя;
 *  - «Вернуть стандартный» — отдельная кнопка, а не «загрузите обратно
 *    файл продукта»: своего файла у администратора нет;
 *  - показывается ровно то, что увидят на входе, — тем же логотипом на
 *    той же светлой карточке.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@web/components';
import { DEFAULT_LOGO_SRC } from '@web/lib/branding';
import { api } from '../api/client';
import type { BrandingSettings } from '../api/types';
import { PageTitle } from '../app/AdminLayout';
import { useSession } from '../app/session';
import { ErrorNotice, Field, Notice, Panel } from '../components/ui';
import { formatDateTime } from '../lib/format';

/** Приглушённый текст. Своего класса в стилях админки нет, а трогать
    общий файл стилей ради одной страницы незачем. */
const MUTED = { color: 'var(--mt-admin-muted)' } as const;

/**
 * Размер файла человеку: «288 Б», «312 КБ», «1.2 МБ».
 *
 * Байты — не педантизм: аккуратный логотип из плоских фигур весит меньше
 * килобайта, и округление до «0 КБ» читалось бы как «файл пустой».
 */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

export function BrandingPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [company, setCompany] = useState('');
  const [product, setProduct] = useState('');

  const branding = useQuery({ queryKey: ['branding'], queryFn: () => api.branding() });

  // Поля подписей — управляемые, но их начальное значение приходит с
  // сервера. Заполняем один раз по приходу, иначе набранное затиралось бы
  // при каждом обновлении запроса.
  const loaded = branding.data;
  useEffect(() => {
    if (!loaded) return;
    setCompany(loaded.companyName ?? '');
    setProduct(loaded.productName ?? '');
  }, [loaded?.companyName, loaded?.productName]); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = (state: BrandingSettings, message: string): void => {
    queryClient.setQueryData(['branding'], state);
    setFlash(message);
  };

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadLogo(file),
    onSuccess: (state) => settle(state, 'Логотип загружен. Он уже виден на обеих страницах входа.'),
  });

  const reset = useMutation({
    mutationFn: () => api.resetLogo(),
    onSuccess: (state) => settle(state, 'Возвращён стандартный логотип продукта.'),
  });

  const saveTexts = useMutation({
    mutationFn: () =>
      api.saveBrandingTexts({
        companyName: company.trim() === '' ? null : company.trim(),
        productName: product.trim() === '' ? null : product.trim(),
      }),
    onSuccess: (state) => settle(state, 'Подписи сохранены.'),
  });

  const limits = branding.data?.limits;
  const logo = branding.data?.logo ?? null;
  const writable = can('branding.write');
  const busy = upload.isPending || reset.isPending || saveTexts.isPending;

  return (
    <>
      <PageTitle
        title="Оформление входа"
        subtitle="Свой логотип и название на страницах входа в почту и в панель управления"
      />

      {flash && <Notice tone="success">{flash}</Notice>}
      {/* Текст отказа приходит с сервера и объясняет, что именно не так.
          Свой обобщённый текст здесь был бы враньём. */}
      <ErrorNotice
        error={branding.error ?? upload.error ?? reset.error ?? saveTexts.error}
      />

      <Panel title="Логотип">
        <p style={MUTED}>
          Логотип показывается на странице входа в почту и на странице входа в эту панель.
          Он хранится на сервере отдельным файлом и переживает перезапуск и обновление
          продукта, а также попадает в резервную копию настроек.
        </p>

        {/* Предпросмотр ровно на том фоне, что и на входе: карточка входа
            белая в обоих приложениях, и тёмный логотип на ней теряется. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1.25rem',
            margin: '1rem 0',
            padding: '1.1rem 1.35rem',
            background: '#ffffff',
            border: '1px solid rgba(15, 23, 32, 0.12)',
            borderRadius: 12,
          }}
        >
          <img
            src={logo?.url ?? DEFAULT_LOGO_SRC}
            alt={logo ? 'Свой логотип' : 'Стандартный логотип Mail.True'}
            style={{ height: '2rem', width: 'auto', maxWidth: 280, objectFit: 'contain' }}
          />
          <div style={{ ...MUTED, fontSize: '0.85rem' }}>
            {logo ? (
              <>
                Свой логотип: {logo.width}×{logo.height} точек, {humanSize(logo.size)},{' '}
                {logo.mime}
                <br />
                Загружен {formatDateTime(logo.updatedAt)}
              </>
            ) : (
              'Сейчас стоит стандартный логотип продукта'
            )}
          </div>
        </div>

        {limits && (
          <p style={{ ...MUTED, fontSize: '0.85rem' }}>
            Принимаются {limits.formats.join(', ')} размером до {limits.maxBytesText}, от{' '}
            {limits.minWidth}×{limits.minHeight} до {limits.maxWidth}×{limits.maxHeight} точек.
            Файл проверяется по содержимому: расширение и тип, присланные браузером, значения
            не имеют. SVG со скриптами и внешними ссылками не принимается — такой файл
            выполнялся бы в браузере у всех, кто открывает страницу входа.
          </p>
        )}

        {writable ? (
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '0.9rem' }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Значение поля сбрасываем всегда: иначе повторный выбор
                // того же файла после отказа не вызовет события вовсе.
                e.target.value = '';
                if (file) {
                  setFlash(null);
                  upload.mutate(file);
                }
              }}
            />
            <Button size="s" disabled={busy} onClick={() => fileRef.current?.click()}>
              {upload.isPending ? 'Загружаем…' : 'Загрузить свой логотип'}
            </Button>
            <Button
              mode="secondary"
              size="s"
              disabled={busy || logo === null}
              onClick={() => {
                setFlash(null);
                reset.mutate();
              }}
            >
              Вернуть стандартный
            </Button>
          </div>
        ) : (
          <Notice tone="info">
            Менять оформление входа может только администратор с полным доступом.
          </Notice>
        )}
      </Panel>

      <Panel title="Подписи">
        <p style={MUTED}>
          Название компании показывается рядом с логотипом на входе. Название сервиса заменяет
          «Mail.True» в подписях страницы входа в панель.
        </p>
        <Field
          label="Название компании"
          hint={limits ? `Не длиннее ${limits.nameMax} знаков. Пусто — не показывать.` : undefined}
        >
          <input
            className="mt-input"
            style={{ maxWidth: 420 }}
            value={company}
            disabled={!writable}
            onChange={(e) => setCompany(e.target.value)}
          />
        </Field>
        <Field label="Название сервиса" hint="Пусто — оставить «Mail.True».">
          <input
            className="mt-input"
            style={{ maxWidth: 420 }}
            value={product}
            disabled={!writable}
            onChange={(e) => setProduct(e.target.value)}
          />
        </Field>
        {writable && (
          <Button
            size="s"
            disabled={busy}
            onClick={() => {
              setFlash(null);
              saveTexts.mutate();
            }}
          >
            Сохранить подписи
          </Button>
        )}
      </Panel>
    </>
  );
}
