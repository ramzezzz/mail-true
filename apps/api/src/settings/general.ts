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

  /*
   * Список подписей не прислали вовсе — не трогаем их.
   *
   * Раньше поле имело умолчание «пустой список», и запрос без него
   * стирал ВСЕ подписи ящика, отвечая при этом 200. Рядом, в схеме
   * настроек, три соседних поля намеренно оставлены без умолчаний ровно
   * по этой причине: «форма, которая о поле не знает, не должна молча
   * его гасить». Тексты подписей человек пишет руками, и цена ошибки
   * здесь выше, чем у флажка.
   */
  if (dto.signatures === undefined) {
    return toWebGeneral(await db.getSettings(email), await db.listSignatures(email));
  }

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
        // Место в списке — то, на котором подпись стоит в форме. Без
        // этого новая подпись всегда уезжала в конец, и поднять её
        // наверх было нельзя: сохранение возвращало вниз.
        position: dto.signatures.indexOf(item),
      });
      const created = after[after.length - 1];
      if (created) keptIds.add(created.id);
    }
  }
  /*
   * Удаляем только то, что клиент ВИДЕЛ и не прислал обратно.
   *
   * Правило «чего нет в списке — удаляем» без этого сносило подписи,
   * заведённые после того, как форма загрузилась: вкладка, открытая час
   * назад, сохраняется — и подпись, добавленная за это время из админки
   * или из соседней вкладки, исчезает вместе с написанным текстом.
   * Восстановить его нечем: он остаётся только в журнале аудита.
   *
   * `knownSignatureIds` присылает клиент — это идентификаторы, которые
   * были у него на экране. Не прислал (старая сборка) — работаем
   * по-прежнему: иначе удалить подпись стало бы невозможно.
   */
  const known = dto.knownSignatureIds;
  for (const old of existing) {
    if (keptIds.has(old.id)) continue;
    if (known !== undefined && !known.includes(String(old.id))) continue;
    await db.deleteSignature(email, old.id);
  }

  /*
   * «Без подписи» — явный выбор, а не испорченные данные.
   *
   * ensureOneDefaultSignature внутри каждой правки возвращает флаг
   * первой подписи, если основной не осталось. Это защита от битого
   * состояния, но она же не давала сохранить «Без подписи» НИКОГДА.
   * Снимаем флаг последним шагом — тогда сохраняется именно выбор.
   */
  if (dto.defaultSignatureId === null) await db.clearDefaultSignatureChoice(email);

  return toWebGeneral(await db.getSettings(email), await db.listSignatures(email));
}
