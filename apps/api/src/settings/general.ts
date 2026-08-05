/**
 * Сохранение общих настроек вместе с подписями.
 *
 * Раньше это лежало прямо в обработчике PUT /api/settings/general. Вынесено
 * сюда, когда те же настройки понадобилось править из админки: согласование
 * списка подписей — не три строки, а правило («что пропало — удаляем, что
 * осталось — обновляем, идентификаторы сохраняем»), и второй его экземпляр
 * рано или поздно разошёлся бы с первым. Тогда админка и пользователь
 * сохраняли бы одну и ту же форму по-разному, а выяснилось бы это на
 * слетевшем выборе подписи по умолчанию.
 *
 * Здесь нет ни сессии, ни запроса — только адрес ящика: вызывающий сам
 * решает, чей это ящик и имеет ли он право туда писать.
 */
import type { SettingsDb } from './db.js';
import type { Signature } from './types.js';
import { fromWebGeneral, toWebGeneral, type WebGeneralSettings } from './webdto.js';

/**
 * Записывает настройки и приводит список подписей к переданному.
 *
 * Подписи приходят полным списком — так устроена форма настроек, где их
 * добавляют и удаляют, а сохраняют одной кнопкой. Идентификаторы
 * существующих подписей сохраняются, иначе выбор подписи по умолчанию
 * слетал бы при каждом сохранении.
 */
export async function saveGeneralWithSignatures(
  db: SettingsDb,
  email: string,
  dto: WebGeneralSettings,
): Promise<WebGeneralSettings> {
  await db.saveSettings(email, fromWebGeneral(dto));

  const existing = await db.listSignatures(email);
  const keptIds = new Set<number>();
  for (const item of dto.signatures) {
    const id = Number(item.id);
    const found = Number.isInteger(id) ? existing.find((s) => s.id === id) : undefined;
    const isDefault = dto.defaultSignatureId !== null && item.id === dto.defaultSignatureId;
    if (found) {
      keptIds.add(found.id);
      await db.updateSignature(email, found.id, {
        name: item.name,
        bodyHtml: item.text,
        isDefault,
        position: dto.signatures.indexOf(item),
      });
    } else {
      const after: Signature[] = await db.createSignature(email, {
        name: item.name,
        bodyHtml: item.text,
        isDefault,
      });
      const created = after[after.length - 1];
      if (created) keptIds.add(created.id);
    }
  }
  for (const old of existing) {
    if (!keptIds.has(old.id)) await db.deleteSignature(email, old.id);
  }

  return toWebGeneral(await db.getSettings(email), await db.listSignatures(email));
}
