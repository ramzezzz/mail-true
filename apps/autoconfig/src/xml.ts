/** Экранирование спецсимволов для безопасной подстановки значений в XML. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Экранирование для HTML-страницы помощи. */
export function escapeHtml(value: string): string {
  return escapeXml(value);
}
