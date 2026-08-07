/**
 * Журнал установки для показа в браузере.
 *
 * install/install.sh печатает ход работы человеку, а не машине: там есть
 * строки, которые переписывают сами себя возвратом каретки («ждём
 * готовности: postgres redis …»). Отданные в браузер как есть, они
 * превращаются в кашу из десятков одинаковых строк.
 *
 * Поэтому «\r» разбирается так же, как его понимает терминал: всё, что
 * напечатано после возврата каретки, ЗАМЕНЯЕТ текущую строку, а не
 * добавляется к ней. Тогда в браузере видно ровно то же, что в консоли.
 */

/*
 * Управляющие последовательности цвета. install.sh печатает их, только
 * когда пишет в терминал, а установщик запускает её без терминала — но
 * полагаться на это нельзя: одна цветная строка испортила бы весь журнал.
 *
 * Выражение собирается из строки намеренно: символ ESC внутри литерала
 * регулярного выражения — это управляющий байт прямо в исходнике, а с
 * управляющими байтами в исходниках у нас уже была история.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export class LogBuffer {
  private readonly lines: string[] = [];
  /** Незавершённая последняя строка (без перевода строки). */
  private pending = '';

  append(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = '';
    const parts = text.split('\n');
    const last = parts.pop() ?? '';
    for (const part of parts) {
      this.pushLine(part);
    }
    // Хвост без перевода строки: он ещё может быть дописан следующей порцией,
    // но показать его нужно уже сейчас — это и есть индикатор ожидания.
    this.pending = last;
  }

  private pushLine(raw: string): void {
    // Возврат каретки: показываем только последний вариант строки.
    const segments = raw.split('\r');
    const visible = segments[segments.length - 1] ?? '';
    if (visible.trim() === '' && segments.length > 1) return;
    this.lines.push(visible.replace(ANSI, ''));
  }

  /** Строки, начиная с указанной. Последняя может быть незавершённой. */
  since(from: number): { lines: string[]; next: number } {
    const start = Math.max(0, Math.min(from, this.lines.length));
    const lines = this.lines.slice(start);
    const next = this.lines.length;
    const tail = this.pending.split('\r').pop() ?? '';
    if (tail.trim() !== '') lines.push(tail.replace(ANSI, ''));
    return { lines, next };
  }

  get length(): number {
    return this.lines.length;
  }

  /** Последние строки — для короткого объяснения отказа. */
  tail(count: number): string[] {
    return this.lines.slice(Math.max(0, this.lines.length - count));
  }
}
