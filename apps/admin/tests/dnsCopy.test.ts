/**
 * Копирование значения записи.
 *
 * Кнопка «Копировать» — половина смысла диалога: значения длинные
 * (ключ DKIM — сотни символов без пробелов), и перепечатывать их руками
 * никто не станет. Ловушка в том, что navigator.clipboard существует
 * только на защищённом происхождении, а админку при установке открывают
 * по http, пока не выпустился сертификат. Без запасного пути кнопка там
 * молча не работала бы.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/pages/DnsDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('копирование значения', () => {
  it('пользуется буфером браузера, когда он доступен', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyText('v=spf1 mx ~all')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('v=spf1 mx ~all');
  });

  it('без защищённого происхождения копирует запасным путём', async () => {
    // Ровно этот случай — админка по http сразу после установки.
    vi.stubGlobal('navigator', {});
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    await expect(copyText('mail.example.ru.')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    // Временное поле не должно остаться на странице.
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('отказ буфера не выдаётся за успех', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false);

    await expect(copyText('что-то')).resolves.toBe(false);
  });
});
