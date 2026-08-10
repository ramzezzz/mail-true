/** Утилиты работы с текстом писем: сниппеты, декодирование, HTML -> текст. */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&laquo;': '«',
  '&raquo;': '»',
  '&mdash;': '—',
  '&ndash;': '–',
};

/** Грубое преобразование HTML в текст (для сниппетов и text-версии писем). */
export function htmlToText(html: string): string {
  let text = html
    /*
     * Незакрытые <style>/<script>/<head> вырезаются вместе с ХВОСТОМ.
     *
     * Парные замены ниже ловят только целые блоки, а сюда приходит и
     * ОБРЕЗАННЫЙ HTML: сниппет для списка писем качает первые 4 КБ тела
     * (imap/service.ts, fetchSnippet), и блок стилей рассылки в них почти
     * никогда не помещается. Дальше `<style …>` без закрывающего тега
     * снимался как обычный тег, а его содержимое уезжало в список писем
     * и в уведомление о новой почте: вместо начала письма человек читал
     * `body{margin:0;padding:0} .wrapper{width:100%…`.
     *
     * Порядок важен: сначала незакрытые (до конца строки), потом парные —
     * иначе первый же `<style>` съел бы всё письмо целиком.
     */
    .replace(/<style\b[^>]*>(?![\s\S]*?<\/style>)[\s\S]*$/gi, ' ')
    .replace(/<script\b[^>]*>(?![\s\S]*?<\/script>)[\s\S]*$/gi, ' ')
    .replace(/<head\b[^>]*>(?![\s\S]*?<\/head>)[\s\S]*$/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(/&#(\d+);/g, (_m, code: string) => {
    const num = Number(code);
    return Number.isFinite(num) && num > 0 && num < 0x110000 ? String.fromCodePoint(num) : '';
  });
  return text
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Сниппет — первые max символов текста без переносов и лишних пробелов. */
export function makeSnippet(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1).trimEnd() + '…';
}

/** Декодирует Buffer с учётом charset (насколько поддерживает TextDecoder). */
export function decodeBuffer(buf: Buffer, charset: string | undefined): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      /* неизвестная кодировка — используем utf-8 */
    }
  }
  return buf.toString('utf8');
}
