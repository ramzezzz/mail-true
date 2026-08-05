/**
 * Хлебные крошки.
 *
 * Со страницы импорта не было видно, как вернуться назад: единственный путь
 * к списку ящиков — кнопка в углу панели. Крошки строятся по адресу, поэтому
 * работают и при заходе по прямой ссылке.
 */
import { describe, expect, it } from 'vitest';
import { breadcrumbsFor } from '../src/lib/breadcrumbs';

describe('breadcrumbsFor', () => {
  it('на «Дашборде» крошек нет — возвращаться некуда', () => {
    expect(breadcrumbsFor('/')).toEqual([]);
  });

  it('на разделе первого уровня ведут к дашборду', () => {
    expect(breadcrumbsFor('/users')).toEqual([
      { title: 'Дашборд', to: '/' },
      { title: 'Пользователи' },
    ]);
  });

  it('со страницы импорта видно, как вернуться к списку ящиков', () => {
    const crumbs = breadcrumbsFor('/users/import');
    expect(crumbs.map((c) => c.title)).toEqual([
      'Дашборд',
      'Пользователи',
      'Импорт ящиков из CSV',
    ]);
    // Именно этого и не было: ссылки на список ящиков не существовало
    expect(crumbs[1]?.to).toBe('/users');
  });

  it('текущая страница — не ссылка, а все прочие — ссылки', () => {
    const crumbs = breadcrumbsFor('/users/import');
    expect(crumbs.at(-1)?.to).toBeUndefined();
    for (const crumb of crumbs.slice(0, -1)) {
      expect(crumb.to).toBeDefined();
    }
  });

  it('ящик пользователя возвращает в список ящиков, а не в корень', () => {
    const crumbs = breadcrumbsFor('/mailbox');
    expect(crumbs.map((c) => c.title)).toEqual(['Дашборд', 'Пользователи', 'Ящик пользователя']);
    expect(crumbs[1]?.to).toBe('/users');
  });

  it('крошки есть во всей админке, а не только на импорте', () => {
    for (const path of ['/aliases', '/domains', '/ai', '/audit', '/flow', '/spam']) {
      const crumbs = breadcrumbsFor(path);
      expect(crumbs.length).toBeGreaterThanOrEqual(2);
      expect(crumbs[0]).toEqual({ title: 'Дашборд', to: '/' });
    }
  });

  it('хвостовой «/», строка запроса и якорь не мешают', () => {
    expect(breadcrumbsFor('/users/')).toEqual(breadcrumbsFor('/users'));
    expect(breadcrumbsFor('/users?page=2')).toEqual(breadcrumbsFor('/users'));
    expect(breadcrumbsFor('/users#top')).toEqual(breadcrumbsFor('/users'));
  });

  it('неизвестный адрес крошек не выдумывает', () => {
    expect(breadcrumbsFor('/nope')).toEqual([]);
  });
});
