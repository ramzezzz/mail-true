/**
 * Тесты базовых компонентов через renderToStaticMarkup (без DOM-окружения):
 * проверяем структуру разметки, атрибуты и доступность.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../src/components/Button/Button';
import { Checkbox } from '../src/components/Checkbox/Checkbox';
import { IconButton } from '../src/components/IconButton/IconButton';
import { Spinner } from '../src/components/Spinner/Spinner';
import { Tooltip } from '../src/components/Tooltip/Tooltip';

describe('Button', () => {
  it('рендерит текст и по умолчанию type="button"', () => {
    const html = renderToStaticMarkup(<Button>Написать письмо</Button>);
    expect(html).toContain('Написать письмо');
    expect(html).toContain('type="button"');
  });

  it('пробрасывает disabled и произвольные атрибуты', () => {
    const html = renderToStaticMarkup(
      <Button disabled data-testid="send">
        Отправить
      </Button>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('data-testid="send"');
  });

  it('рендерит иконку до текста', () => {
    const html = renderToStaticMarkup(<Button before={<svg data-icon="pen" />}>Текст</Button>);
    expect(html.indexOf('data-icon="pen"')).toBeLessThan(html.indexOf('Текст'));
  });
});

describe('IconButton', () => {
  it('обязательная подпись становится aria-label и title', () => {
    const html = renderToStaticMarkup(
      <IconButton label="Удалить">
        <svg />
      </IconButton>,
    );
    expect(html).toContain('aria-label="Удалить"');
    expect(html).toContain('title="Удалить"');
  });
});

describe('Checkbox', () => {
  it('это настоящий input[type=checkbox] с подписью', () => {
    const html = renderToStaticMarkup(<Checkbox label="Только непрочитанные" defaultChecked />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('Только непрочитанные');
  });
});

describe('Tooltip', () => {
  it('рендерит содержимое и текст с role="tooltip"', () => {
    const html = renderToStaticMarkup(
      <Tooltip text="Отметить прочитанным">
        <button type="button">x</button>
      </Tooltip>,
    );
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('Отметить прочитанным');
  });
});

describe('Spinner', () => {
  it('доступен как progressbar и масштабируется', () => {
    const html = renderToStaticMarkup(<Spinner size={48} label="Загрузка списка" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Загрузка списка"');
    expect(html).toContain('width="48"');
  });
});
