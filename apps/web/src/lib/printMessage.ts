/**
 * Подготовка письма к печати.
 *
 * На бумаге не видно, куда ведёт ссылка: подчёркнутый синий текст «здесь»
 * на листе — просто слово «здесь». Почтовые клиенты в таком случае
 * дописывают адрес рядом с текстом; здесь то же самое, но без превращения
 * письма в кашу — адрес дописывается только там, где он что-то добавляет.
 *
 * Разметка тела письма приходит с сервера и вставляется как есть, поэтому
 * решение принимается уже по готовому DOM (см. annotatePrintLinks), а сама
 * проверка вынесена сюда отдельной функцией — её можно проверить тестами.
 */

/** Схемы, у которых печатать адрес незачем или нечего. */
const USELESS_SCHEMES = ['javascript:', 'data:', 'cid:', 'blob:', 'about:'];

/**
 * Приводит адрес к виду, в котором его сравнивают с текстом ссылки:
 * без схемы, без «www.», без хвостовой косой черты, в нижнем регистре.
 */
function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Что дописать рядом с текстом ссылки при печати; `null` — ничего.
 *
 * Не дописываем:
 *   - якоря внутри письма и служебные схемы — на бумаге они бессмысленны;
 *   - `mailto:` и `tel:` — там текстом ссылки почти всегда сам адрес,
 *     а «Иван Петров (mailto:ivan@mail.local)» только мешает читать;
 *   - адрес, который и так виден в тексте ссылки.
 */
export function printableHref(text: string, href: string): string | null {
  const url = href.trim();
  if (!url) return null;

  const lower = url.toLowerCase();
  if (lower.startsWith('#')) return null;
  if (USELESS_SCHEMES.some((scheme) => lower.startsWith(scheme))) return null;
  if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return null;

  const shown = text.replace(/\s+/g, ' ').trim();
  // Ссылка-картинка: текста нет вовсе, и адрес показать больше негде
  if (!shown) return url;

  const target = normalize(url);
  const label = normalize(shown);
  if (!target) return null;
  if (label === target) return null;
  // Текст вида «сайт: example.com/страница» адрес уже содержит
  if (label.includes(target)) return null;

  return url;
}

/** Атрибут, из которого печатное правило берёт адрес ссылки. */
export const PRINT_HREF_ATTR = 'data-mt-print-href';

/**
 * Проставляет адреса ссылок в теле письма для печати.
 *
 * Возвращает число размеченных ссылок — по нему удобно проверять работу
 * и видно, что обход вообще состоялся.
 */
export function annotatePrintLinks(root: HTMLElement | null): number {
  if (!root) return 0;
  let marked = 0;
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    const printable = printableHref(link.textContent ?? '', href);
    if (printable) {
      link.setAttribute(PRINT_HREF_ATTR, printable);
      marked += 1;
    } else {
      link.removeAttribute(PRINT_HREF_ATTR);
    }
  }
  return marked;
}

/** «Имя <адрес>» либо просто адрес — так адресат подписан на листе. */
export function printAddress(a: { name: string | null; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Перечень адресатов одной строкой; пусто — прочерк, а не пустое место. */
export function printAddresses(list: readonly { name: string | null; address: string }[]): string {
  return list.map(printAddress).join(', ') || '—';
}

/** Дата и время получения письма — полностью, без «вчера» и «14:20». */
export function printDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
