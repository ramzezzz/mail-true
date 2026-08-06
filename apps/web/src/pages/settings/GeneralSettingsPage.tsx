/**
 * Общие настройки: имя отправителя и подписи, автоответчик, уведомления,
 * цитата в ответе, поведение после удаления письма
 * (перечень — docs/features-mailru.md, «Общие настройки»).
 *
 * Форма работает по схеме «черновик — сохранение»: правки копятся в
 * состоянии и уходят на сервер одной кнопкой. Так же ведёт себя mail.ru,
 * и так дешевле: каждый переключатель не дёргает сеть.
 *
 * Где эти значения на самом деле применяются — в `settings/generalSettings.ts`
 * и его читателях: до недавнего времени страница была единственным местом,
 * которое о них знало, и сохранённое не влияло ни на что.
 */

import { useEffect, useState } from 'react';
import { useGeneralSettings, useSaveGeneralSettings } from '../../api/settingsQueries';
import {
  UNDO_SEND_CHOICES,
  type GeneralSettings,
  type Signature,
} from '../../api/settingsTypes';
import { Button, SelectField, Switch, TextAreaField, TextField } from '../../components';
import { dateInputValue } from '../../settings/generalSettings';
import { IconPlus, IconTrash } from '../../mail/icons';
import {
  SettingsActions,
  SettingsError,
  SettingsHint,
  SettingsRow,
  SettingsSection,
  SettingsSkeleton,
  SettingsTitle,
} from '../../settings/ui';
import styles from './GeneralSettingsPage.module.css';

export function GeneralSettingsPage() {
  const { data, isPending, isError } = useGeneralSettings();
  const save = useSaveGeneralSettings();
  const [draft, setDraft] = useState<GeneralSettings | null>(null);

  // Пришли значения с сервера — заводим черновик. Пока идёт сохранение,
  // черновик не перетираем: иначе поле дёрнулось бы под курсором.
  useEffect(() => {
    if (data && draft === null) setDraft(structuredClone(data));
  }, [data, draft]);

  if (isError) {
    return (
      <>
        <SettingsTitle>Общие настройки</SettingsTitle>
        <SettingsError>Не удалось загрузить настройки. Обновите страницу.</SettingsError>
      </>
    );
  }

  if (isPending || draft === null) {
    return (
      <>
        <SettingsTitle>Общие настройки</SettingsTitle>
        <SettingsSkeleton rows={6} />
      </>
    );
  }

  const patch = (next: Partial<GeneralSettings>) => setDraft({ ...draft, ...next });

  const patchSignature = (id: string, text: string) =>
    patch({ signatures: draft.signatures.map((s) => (s.id === id ? { ...s, text } : s)) });

  const patchSignatureName = (id: string, name: string) =>
    patch({ signatures: draft.signatures.map((s) => (s.id === id ? { ...s, name } : s)) });

  const addSignature = () => {
    const signature: Signature = {
      id: `new-${Date.now()}`,
      name: `Подпись ${draft.signatures.length + 1}`,
      text: '',
    };
    patch({ signatures: [...draft.signatures, signature] });
  };

  /**
   * Сохранение с перечиткой черновика из ответа сервера.
   *
   * Новая подпись заводится с придуманным здесь `new-<время>`, а настоящий
   * идентификатор ей выдаёт сервер. Пока черновик оставался прежним, второе
   * нажатие «Сохранить» слало тот же `new-…`: сервер не находил такой
   * подписи, заводил ещё одну, а прежнюю удалял — id рос с каждым нажатием
   * (31 → 32 → 33). Заодно так подхватываются любые нормализации сервера:
   * например, срок автоответчика он возвращает полной датой ISO.
   */
  const saveDraft = () =>
    save.mutate(draft, { onSuccess: (saved) => setDraft(structuredClone(saved)) });

  const removeSignature = (id: string) =>
    patch({
      signatures: draft.signatures.filter((s) => s.id !== id),
      // Удалили подпись по умолчанию — сбрасываем выбор, иначе окно
      // написания сослалось бы на несуществующий идентификатор.
      defaultSignatureId: draft.defaultSignatureId === id ? null : draft.defaultSignatureId,
    });

  return (
    <>
      <SettingsTitle>Общие настройки</SettingsTitle>

      <SettingsSection
        title="Имя отправителя и подпись"
        description="Имя видит получатель в поле «От кого». Подписей может быть несколько — та, что выбрана по умолчанию, подставляется в новое письмо."
      >
        <TextField
          label="Имя отправителя"
          value={draft.senderName}
          onChange={(e) => patch({ senderName: e.target.value })}
        />

        {draft.signatures.map((signature) => (
          <div key={signature.id} className={styles.signature}>
            <SettingsRow>
              <TextField
                label="Название подписи"
                wrapperClassName={styles.signatureName}
                value={signature.name}
                onChange={(e) => patchSignatureName(signature.id, e.target.value)}
              />
              <Button
                mode="tertiary"
                before={<IconTrash />}
                onClick={() => removeSignature(signature.id)}
              >
                Удалить
              </Button>
            </SettingsRow>
            <TextAreaField
              label="Текст подписи"
              value={signature.text}
              rows={3}
              onChange={(e) => patchSignature(signature.id, e.target.value)}
            />
          </div>
        ))}

        <SettingsRow>
          <Button mode="secondary" before={<IconPlus />} onClick={addSignature}>
            Добавить подпись
          </Button>
        </SettingsRow>

        <SelectField
          label="Подпись по умолчанию"
          value={draft.defaultSignatureId ?? ''}
          onChange={(e) => patch({ defaultSignatureId: e.target.value || null })}
        >
          <option value="">Без подписи</option>
          {draft.signatures.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
      </SettingsSection>

      <SettingsSection
        title="Автоответчик"
        description="Пока включён, на каждое входящее письмо один раз уходит ответ с этим текстом."
      >
        <Switch
          label="Включить автоответчик"
          checked={draft.autoReply.enabled}
          onChange={(e) => patch({ autoReply: { ...draft.autoReply, enabled: e.target.checked } })}
        />
        <TextAreaField
          label="Текст автоответа"
          value={draft.autoReply.text}
          disabled={!draft.autoReply.enabled}
          onChange={(e) => patch({ autoReply: { ...draft.autoReply, text: e.target.value } })}
        />
        <SettingsRow>
          <TextField
            label="Действует с"
            type="date"
            wrapperClassName={styles.dateField}
            disabled={!draft.autoReply.enabled}
            value={dateInputValue(draft.autoReply.from)}
            onChange={(e) =>
              patch({ autoReply: { ...draft.autoReply, from: e.target.value || null } })
            }
          />
          <TextField
            label="по"
            type="date"
            wrapperClassName={styles.dateField}
            disabled={!draft.autoReply.enabled}
            value={dateInputValue(draft.autoReply.to)}
            onChange={(e) => patch({ autoReply: { ...draft.autoReply, to: e.target.value || null } })}
          />
        </SettingsRow>
        <SettingsHint>Пустые даты — автоответчик работает бессрочно.</SettingsHint>
      </SettingsSection>

      <SettingsSection title="Уведомления">
        <Switch
          label="Уведомления в браузере"
          description="Всплывающее уведомление о новом письме, когда вкладка свёрнута"
          checked={draft.notifications.browser}
          onChange={(e) =>
            patch({ notifications: { ...draft.notifications, browser: e.target.checked } })
          }
        />
        <Switch
          label="Счётчик во вкладке"
          description="Число непрочитанных в заголовке вкладки браузера"
          checked={draft.notifications.tabCounter}
          onChange={(e) =>
            patch({ notifications: { ...draft.notifications, tabCounter: e.target.checked } })
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Список писем"
        description="Как выглядят строки в списке."
      >
        <Switch
          label="Логотипы отправителей в кружках"
          /* Описание говорит и о выгоде, и о цене. Настройка означает, что
             сервер начнёт обращаться к чужим сайтам, — умалчивать об этом
             в переключателе, который это включает, нельзя. */
          description={
            'Вместо буквы — знак домена, с которого пришло письмо. Логотипы ищет и хранит ' +
            'сервер: ваш браузер к чужим сайтам не обращается, и отправитель не узнаёт, ' +
            'что вы открыли письмо. Логотип показывается только у писем, чья подлинность ' +
            'подтверждена проверкой подписи, — иначе остаётся буква.'
          }
          checked={draft.showSenderLogos}
          onChange={(e) => patch({ showSenderLogos: e.target.checked })}
        />
      </SettingsSection>

      <SettingsSection title="Отправка писем">
        <Switch
          label="Включать содержимое исходного письма в ответ"
          checked={draft.quoteOriginalOnReply}
          onChange={(e) => patch({ quoteOriginalOnReply: e.target.checked })}
        />
        {/*
          Отмена отправки. Список, а не переключатель со сроком: выбирать
          приходится ровно одно из четырёх, и «выключено» — такой же выбор,
          как остальные три.
        */}
        <SelectField
          label="Отменить отправку в течение"
          value={String(draft.undoSendSeconds)}
          onChange={(e) => patch({ undoSendSeconds: Number(e.target.value) })}
        >
          {UNDO_SEND_CHOICES.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds === 0 ? 'не отменять — отправлять сразу' : `${seconds} секунд`}
            </option>
          ))}
        </SelectField>
        {/* Подсказка говорит и о выгоде, и о цене: письмо эти секунды
            действительно НЕ у получателя, и человек должен это знать —
            иначе «отправил и ушёл» однажды окажется неправдой */}
        <SettingsHint>
          Письмо ждёт эти секунды на сервере, а не у получателя, — и уходит,
          даже если закрыть вкладку. Отменить можно только пока идёт отсчёт.
        </SettingsHint>
      </SettingsSection>

      <SettingsSection title="После удаления письма">
        <SelectField
          label="Переходить"
          value={draft.afterDelete}
          onChange={(e) =>
            patch({ afterDelete: e.target.value as GeneralSettings['afterDelete'] })
          }
        >
          <option value="next-message">к следующему письму</option>
          <option value="list">к списку писем</option>
        </SelectField>
      </SettingsSection>

      {/* Раздел вернулся вместе с самой подсказкой адреса. До неё
          переключатель «пополнять контакты» жил в контракте настроек, но
          не менял ровно ничего, и показывать его было нельзя: обещание без
          обеспечения хуже отсутствия обещания. Теперь он управляет тем, что
          написано на нём, — см. apps/api/src/contacts/. */}
      <SettingsSection
        title="Адресная книга"
        description="Откуда берутся подсказки в поле «Кому»."
      >
        <Switch
          label="Пополнять контакты из полученных писем"
          /* Описание говорит и о выгоде, и о цене — как у логотипов
             отправителей. Речь о списке тех, кто пишет человеку, и
             умалчивать об этом в переключателе, который это включает,
             нельзя. Про отправленные сказано отдельно: они собираются
             всегда, и человек должен понимать, что выключение не сделает
             подсказку пустой. */
          description={
            'Адреса отправителей входящих писем попадают в подсказки поля «Кому». ' +
            'Список хранится на сервере, привязан к вашему ящику и удаляется вместе с ним. ' +
            'Адреса, которым вы писали сами, собираются в любом случае — их вы выбрали сами. ' +
            'Лишний адрес можно убрать из подсказок прямо в списке, крестиком.'
          }
          checked={draft.autoCollectContacts}
          onChange={(e) => patch({ autoCollectContacts: e.target.checked })}
        />
      </SettingsSection>

      <SettingsActions>
        <Button disabled={save.isPending} onClick={saveDraft}>
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        <Button
          mode="secondary"
          disabled={save.isPending || !data}
          onClick={() => data && setDraft(structuredClone(data))}
        >
          Отменить
        </Button>
        {save.isSuccess && !save.isPending && <SettingsHint>Настройки сохранены</SettingsHint>}
        {save.isError && <SettingsError>Не удалось сохранить. Попробуйте ещё раз.</SettingsError>}
      </SettingsActions>
    </>
  );
}
