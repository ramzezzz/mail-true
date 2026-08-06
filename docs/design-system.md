# Дизайн-система интерфейса (снято с e.mail.ru)

Источник: живой интерфейс `e.mail.ru`, снято 2026-08-05 с аккаунта `ramzezzz@mail.ru`.
Сырые выгрузки лежат в `research/mailru/`:

| Файл                     | Что внутри                                                         |
| ------------------------ | ------------------------------------------------------------------ |
| `design-tokens-raw.json` | Все CSS-переменные с `:root` — 3341 строка, VKUI + слой `octavius` |
| `extracted-rules.css`    | 867 реальных CSS-правил интерфейса, включая `:hover` / `_active`   |
| `row-anatomy.json`       | Геометрия строки списка писем и всех её потомков                   |
| `01-inbox.png`           | Скриншот входящих                                                  |

## Основа

Интерфейс собран на дизайн-системе **VKUI** с надстройкой мейла — префикс токенов
`--vkui--octavius_*`. Портальные элементы (шапка) используют префикс `--ph-*`.
Из этого следует главный архитектурный вывод для нашей реализации: **все цвета берём
только из CSS-переменных**, потому что темы оформления переопределяют именно их.
Компоненты не должны знать конкретных цветов.

### Шрифты

```
--ph-font-family:        VKSansDisplay, MailSans, Helvetica, Arial, sans-serif
--vkui--font_family_base: apple-system, system-ui, "Helvetica Neue", Arial, sans-serif
```

Список писем при этом рисуется старым стеком `Arial, Tahoma, Verdana, sans-serif` —
наследие, которое воспроизводить не нужно. Берём `VKSansDisplay/MailSans` с падением
на системные шрифты.

Типографическая шкала (из токенов VKUI):

| Роль        | Размер | Интерлиньяж | Насыщенность |
| ----------- | ------ | ----------- | ------------ |
| `caption2`  | 11px   | 14px        | 400          |
| `caption1`  | 12px   | 16px        | 400          |
| `subhead`   | 14px   | 18px        | 400          |
| `paragraph` | 15px   | 20px        | 400          |
| `headline2` | 15px   | 20px        | 500          |
| `headline1` | 16px   | 20px        | 500          |
| `h2`        | 20px   | 26px        | 500          |
| `h1`        | 24px   | 28px        | 500          |

### Базовые цвета светлой темы

```
--vkui--color_text_primary          #2C2D2E   основной текст
--vkui--color_text_secondary        #87898F   вторичный текст
--vkui--color_text_tertiary         #AAADB3
--vkui--color_text_subhead          #797A80
--vkui--color_background            #FFFFFF
--vkui--color_background_secondary  #F0F1F3
--vkui--color_background_tertiary   #F6F7F8
--vkui--color_background_accent     #0077FF   фирменный синий
--vkui--color_accent_red            #ED330A
--vkui--color_background_positive   #0DC268   зелёный «надёжный отправитель»
--vkui--color_accent_secondary      #FF9E00   оранжевый (рассылки)
--vkui--color_separator_primary     #DADCE0
--vkui--octavius_color_icon_unread  #0077FF   точка непрочитанного
```

Отдельно: цвет вторичного текста в списке писем — `#93969B`
(`rgb(147, 150, 155)`), он немного темнее общего `--color_text_secondary`.

### Радиусы, тени, анимация

```
--vkui--size_border_radius--regular   8px
--vkui--size_card_border_radius       16px
--vkui--elevation1                    0 2px 6px rgba(0,16,61,.08), 0 1px 2px rgba(0,16,61,.08)
--vkui--animation_easing_default      cubic-bezier(0.3, 0.3, 0.5, 1)
--vkui--animation_duration_s          0.1s
```

Шкала отступов VKUI кратна 4px: `--vkui--x1: 4px`, `x3: 12px`, `x5: 20px`, `x12: 48px`.

## Каркас страницы

```
┌─ шапка (портал) ───────────────────────────────── высота 62px ─┐
├──────────────┬──────────────────────────────────┬──────────────┤
│ левая        │ список писем / просмотр письма   │ правая       │
│ колонка      │                                  │ колонка      │
│ 232px        │ resizable                        │ (реклама —   │
│              │                                  │  не делаем)  │
└──────────────┴──────────────────────────────────┴──────────────┘
```

Классы-ориентиры: `.layout__column_left` (232px), `.sidebar-folders`,
`.sidebar__full_fixed`, `.nav-folders`, `.nav_expanded`.

## Левое меню

Внешняя колонка 232px, внутренний `nav` — 200px, то есть по 16px полей с каждой стороны.

Кнопка **«Написать письмо»**: 164×36 в позиции `16,62`, шрифт 15px/36px, вес 500,
семейство VKSansDisplay. Рядом — отдельная кнопка-стрелка выпадающего меню
(класс `compose-button_with-dropdown`, меню `.compose-dropdown`).

Пункт папки:

```
размер           200×36
радиус           8px
поля             0 8px          (вложенная папка: 0 8px 0 28px)
шрифт            15px / 20px, вес 400
шаг по вертикали 37px           (36px высота + 1px зазор)
фон обычный      прозрачный
фон активного    var(--vkui--octavius_color_sidebar_item_background_alpha--active)
```

Порядок и адреса папок в реальном ящике:

| Папка             | URL             | Примечание                           |
| ----------------- | --------------- | ------------------------------------ |
| Входящие          | `/inbox/`       | со счётчиком непрочитанных           |
| ├ Социальные сети | `/social/`      | автокатегория, вложенный уровень     |
| ├ Рассылки        | `/newsletters/` | автокатегория                        |
| ├ Новости         | `/news/`        | автокатегория                        |
| └ Чеки            | `/receipts/`    | автокатегория                        |
| Важное            | `/1/`           | пользовательская папка — числовой id |
| Отправленные      | `/sent/`        |                                      |
| Черновики         | `/drafts/`      |                                      |
| Спам              | `/spam/`        |                                      |
| Корзина           | `/trash/`       |                                      |
| Новая папка       | —               | пункт-действие внизу списка          |

Системные папки адресуются именем, пользовательские — числовым идентификатором.
Автокатегории (Социальные сети, Рассылки, Новости, Чеки) — это не IMAP-папки,
а вложенные представления внутри «Входящих».

## Строка списка писем

Разметка (класс `llc` — letter list cell; `llc-t` — вариант для цепочки):

```html
<a
  class="llc llc_normal llc_new"
  href="/inbox/1:7f4f55c352495e7b:0/"
  data-id="…"
  style="height:48px; position:absolute; top:32px; width:100%"
>
  <div class="llc__background"></div>
  <div class="llc__read-status">…точка непрочитанного…</div>
  <div class="llc__avatar">
    <button class="ll-av">
      <span class="ll-av__checkbox">…чекбокс, показывается при наведении…</span>
      <div class="ll-av__img-container">
        <span class="ll-av__img" style="background-image:url(…)"></span>
        <span class="ll-av__reliable-icon">…зелёный щит…</span>
      </div>
    </button>
  </div>
  <div class="llc__container">
    <div class="llc__content">
      <div class="llc__item llc__item_correspondent">…отправитель…</div>
      <div class="llc__item llc__item_flag">…флажок «важное»…</div>
      <div class="llc__item llc__item_title">
        <span class="llc__subject">…тема…</span>
        <span class="llc__snippet">…начало текста…</span>
      </div>
      <div class="llc__secondary-data">…значки вложений, категорий…</div>
      <div class="llc__item llc__item_date">…дата…</div>
    </div>
  </div>
</a>
```

Метрики (обычный режим):

| Элемент                    | Значение                                                      |
| -------------------------- | ------------------------------------------------------------- |
| Высота строки              | 48px (компактный режим `_pony-mode`: 40px, шрифт 13px)        |
| Колонка непрочитанного     | 32px (в новой вёрстке 28px)                                   |
| Аватар                     | 32×32, `margin-right: 12px`                                   |
| Отступ колонок             | `padding-right: 8px`, у последней — 0                         |
| Отправитель                | `width: 22%; min-width: 22%`                                  |
| Флажок «важное»            | `width: 24px; min-width: 24px`                                |
| Тема + текст               | `flex: 1 1 0`, цвет `#93969B`                                 |
| Отступ текста от темы      | `margin-left: 12px`                                           |
| Значок вложения (пустой)   | `width: 40px`                                                 |
| Дата                       | `width: 44px`, 13px, вправо, `#93969B`, `white-space: nowrap` |
| Внутренние поля контейнера | `0 12px`, у контента `padding-right: 20px`                    |

Состояния:

```css
/* непрочитанное — жирный текст */
.llc-t__item_unread,
.llc-t__subject_unread {
  font-weight: 700;
}

/* наведение */
.llc_new-selection:hover {
  --octavius_list_letter_background: var(--vkui--octavius_color_list_letter_background--hover);
}

/* выбранная строка */
.llc_new-selection.llc:focus {
  --octavius_list_letter_background: var(--vkui--octavius_color_list_letter_background--active);
}

/* надёжный отправитель / официальное письмо — зелёная подложка */
.llc_new-selection.llc_official,
.llc_new-selection.llc_reliable {
  --octavius_list_letter_background: var(--vkui--octavius_color_list_background_positive_alpha);
}
```

Скругление выделенной группы: у выбранных строк радиус 12px, причём
`_firstSelected` скругляет только верх, `_lastSelected` — только низ, так что
подряд идущие выбранные письма выглядят одной карточкой.

Список **виртуализирован** (`ReactVirtualized__List`): строки позиционируются
абсолютно, контейнер задаёт общую высоту. У нас эту роль берёт `@tanstack/react-virtual`.

Разделители между строками — отдельный элемент `.delimeter`, который при наведении
на строку растягивается на всю ширину (`left: 0; right: 0`), а у соседней строки
снизу гасится. Это даёт эффект «разделитель исчезает вокруг наведённой строки».

## Что ещё предстоит снять

- [ ] Шапка портала: логотип, навигация проектов, поиск, дата, аватар
- [ ] Панель действий над списком и её поведение при выделении писем
- [ ] Просмотр письма: шапка, действия, вложения, цепочка
- [ ] Окно написания письма во всех состояниях
- [ ] Настройки: полный перечень разделов и параметров
- [ ] Поиск: подсказки, фильтры, операторы
- [ ] Значки писем: вложение, категория, флаг, метки
- [ ] Контекстное меню письма
