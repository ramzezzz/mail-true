# Фоновые картинки: откуда взяты и на каких условиях

Перечень обязателен к сопровождению: картинки уезжают в поставку продукта,
и через полгода никто не вспомнит, откуда взялась каждая из них, — а
отвечать за них придётся владельцу установки. Любая новая картинка в
`apps/web/public/wallpapers/` обязана появиться и здесь.

## Правила отбора

- Только свободные лицензии, пригодные для коммерческого использования:
  **CC0** и **Public domain**. Ничего «по умолчанию свободного», ничего из
  поиска картинок, ничего без явно названной лицензии.
- Ни одна из лицензий в наборе НЕ требует указания автора в интерфейсе
  (CC0 и PD от него освобождают). Авторы всё равно перечислены — из
  уважения и чтобы след источника не терялся.
- В кадре нет узнаваемых людей, логотипов, торговых марок и произведений
  искусства: это отдельные права поверх лицензии на саму фотографию.
  По этой причине из отобранного выбыли, например, снимок материнской
  платы с логотипом Intel, ноутбук с яблоком, город с вывеской H&M,
  снимок NASA с врисованными подписями и луг с людьми в кадре.
- Каждая картинка обязана оставлять интерфейс читаемым — см. раздел
  «Контраст» ниже.

## Как собран набор

Все файлы приведены к 16:9 обрезкой по центру и 1920×1080, формат webp.
Качество подбиралось ЗАМЕРОМ, а не на глаз: для каждой картинки взято
наименьшее качество, при котором отличие от эталона (q=95) по RMSE
остаётся ниже порога 2.6, с верхней границей веса. Поэтому у мелкой
фактуры (луг, маки) качество ниже — там артефакты не видны, а вес растёт
быстрее всего, — а у гладких градиентов оно не нужно вовсе.

Рядом с каждой картинкой лежит миниатюра `<id>-thumb.webp` (480×270):
страница оформления показывает двадцать плиток, и тянуть ради них
двадцать полноразмерных файлов нельзя.

## Картинки

### Цветы и летний луг

**Луг в горах** — `lupines.webp`

- Что изображено: Wildflowers above Paradise; lupines, lousewort, paintbrush and bistort to name a few. During the summer, subalpine meadows around the mountain burst i…
- Автор: Mount Rainier National Park from Ashford, WA, United States
- Источник: https://commons.wikimedia.org/wiki/File:Wildflower_Meadow_(6997737191).jpg
- Лицензия: Public domain
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=50 (RMSE 7.95), 317 КБ + миниатюра 32 КБ

**Лавандовое поле** — `lavender.webp`

- Что изображено: Lavender field in bloom
- Автор: Robert Brink
- Источник: https://commons.wikimedia.org/wiki/File:Lavender_field_in_bloom.jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.71), 273 КБ + миниатюра 30 КБ

**Маковое поле** — `poppies.webp`

- Что изображено: Poppy field, Oberauroff, evening
- Автор: Gerda Arendt
- Источник: https://commons.wikimedia.org/wiki/File:Poppy_field,_Oberauroff,_evening.jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=40 (RMSE 8.93), 487 КБ + миниатюра 43 КБ

**Подсолнухи** — `sunflowers.webp`

- Что изображено: Image title: Sunflowers in field flower Image from Public domain images website, http://www.public-domain-image.com/full-image/flora-plants-public-dom…
- Автор: Bruce Fritz, U.S. Department of Agriculture
- Источник: https://commons.wikimedia.org/wiki/File:Sunflowers_in_field_flower.jpg
- Лицензия: Public domain
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.94), 245 КБ + миниатюра 18 КБ

### Абстракция

**Плавный градиент** — `gradient.webp`

- Что изображено: Gradient Abstract Background (picture by Vidsplay from Isorepublic)
- Автор: Vidsplay
- Источник: https://commons.wikimedia.org/wiki/File:Gradient_Abstract_Background.jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=80 (RMSE 2.41), 26 КБ + миниатюра 2 КБ

**Геометрия** — `geometry.webp`

- Что изображено: Geometric Abstract Background (picture by Vidsplay from Isorepublic)
- Автор: Vidsplay
- Источник: https://commons.wikimedia.org/wiki/File:Geometric_Abstract_Background.jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=55 (RMSE 1.52), 13 КБ + миниатюра 2 КБ

**Спираль** — `spiral.webp`

- Что изображено: ArtBasel, Basel, Switzerland
- Автор: Samuel Zeller samuelzeller
- Источник: https://commons.wikimedia.org/wiki/File:Abstract_spiral_pattern_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=90 (RMSE 2.17), 272 КБ + миниатюра 13 КБ

**Грани** — `facets.webp`

- Что изображено: Museu de Ciències Naturals de Barcelona, Barcelona, Spain
- Автор: Maxime Le Conte des Floris mlcdf
- Источник: https://commons.wikimedia.org/wiki/File:Facets_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.36), 147 КБ + миниатюра 10 КБ

### Города и дома

**Город у реки** — `riverside.webp`

- Что изображено: Evening, river, lights, city
- Автор: Caroline Jones
- Источник: https://commons.wikimedia.org/wiki/File:Melbourne_skyline_(23985099012).jpg
- Лицензия: Public domain
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.96), 234 КБ + миниатюра 19 КБ

**Огни над водой** — `harbour.webp`

- Что изображено: Osman Rana 2017-03-02
- Автор: Osman Rana osmanrana
- Источник: https://commons.wikimedia.org/wiki/File:Bright_skyline_over_water_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.38), 173 КБ + миниатюра 8 КБ

**Стекло и небо** — `glass.webp`

- Что изображено: In the picture, many modern Skyscrapers (or Buildings)made with glass are shown.
- Автор: Hands off my tags! Michael Gaida
- Источник: https://commons.wikimedia.org/wiki/File:Modern_Skyscrapers_(or_Buildings)made_with_glass.jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=80 (RMSE 3.61), 292 КБ + миниатюра 25 КБ

**Мост в огнях** — `bridge.webp`

- Что изображено: Night view of The Széchenyi Chain Bridge from Buda Castle in Budapest, Hungary
- Автор: Wilfredor
- Источник: https://commons.wikimedia.org/wiki/File:Sz%C3%A9chenyi_Chain_Bridge_in_Budapest_at_night.jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=80 (RMSE 3.51), 271 КБ + миниатюра 19 КБ

### Море и пляж

**Закат на побережье** — `seasunset.webp`

- Что изображено: Leigh-on-Sea, Southend-on-Sea, United Kingdom
- Автор: Joshua Fuller joshuafuller
- Источник: https://commons.wikimedia.org/wiki/File:Leigh-on-Sea_beach_sunset_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.71), 298 КБ + миниатюра 9 КБ

**Прибой** — `surf.webp`

- Что изображено: Balboa Island, Newport Beach, United States
- Автор: Christian Van Bebber cvanbebber
- Источник: https://commons.wikimedia.org/wiki/File:Wave_crashing_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=75 (RMSE 5.11), 311 КБ + миниатюра 23 КБ

**Рифы с орбиты** — `reef.webp`

- Что изображено: Looking down from the International Space Station (ISS), an astronaut captured this view of the northwest coastline of Saudi Arabia, where up to 260 c…
- Автор: Astronaut photograph ISS064-E-6296 was acquired on November 26, 2020, with a Nikon D5 digi…
- Источник: https://commons.wikimedia.org/wiki/File:ISS064-E-6296_(Red_Sea_Rainforests)_lrg.jpg
- Лицензия: Public domain
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=80 (RMSE 4.36), 276 КБ + миниатюра 18 КБ

**Морская гладь** — `seasurface.webp`

- Что изображено: Croatia
- Автор: Lukas Blazek goumbik
- Источник: https://commons.wikimedia.org/wiki/File:Sea_wave_abstract_texture_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=75 (RMSE 4.78), 294 КБ + миниатюра 25 КБ

### Компьютерная тематика

**Строки кода** — `code.webp`

- Что изображено: Markus Spiske 2017-02-14
- Автор: Markus Spiske markusspiske
- Источник: https://commons.wikimedia.org/wiki/File:Code_on_computer_monitor_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 3.25), 297 КБ + миниатюра 18 КБ

**Цветной код** — `colorcode.webp`

- Что изображено: Markus Spiske 2017-03-13
- Автор: Markus Spiske markusspiske
- Источник: https://commons.wikimedia.org/wiki/File:Colorful_code_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=75 (RMSE 5.17), 262 КБ + миниатюра 37 КБ

**Железо** — `hardware.webp`

- Что изображено: Copenhagen, Denmark
- Автор: Thomas Kvistholt freeche
- Источник: https://commons.wikimedia.org/wiki/File:Beautiful_technology_(Unsplash).jpg
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=75 (RMSE 4.82), 293 КБ + миниатюра 22 КБ

**Светодиодный экран** — `ledscreen.webp`

- Что изображено: Weißer Mauszeiger auf großem LED-Display mit 7,5 pixel/cm.
- Автор: Bautsch
- Источник: https://commons.wikimedia.org/wiki/File:LED-Display.Mouse-Pointer.P1186819.png
- Лицензия: CC0 — http://creativecommons.org/publicdomain/zero/1.0/deed.en
- Загружено: 2026-08-06
- Подготовка: 1920×1080 webp q=85 (RMSE 2.49), 197 КБ + миниатюра 33 КБ

## Вес набора

Двадцать картинок с миниатюрами — **5.28 МБ**. Ориентир заказчика — не больше 6–8 МБ на весь набор; укладываемся.

## Контраст

Считался не «в среднем по картинке», а по самому тёмному и самому светлому
участку размером со строку списка — там текст пропадает раньше всего.
Учтены оба слоя, лежащие между картинкой и текстом: затемнение темы
(`--mt-wallpaper-dim`, 30%) и полупрозрачная подложка карточки
(`--mt-wallpaper-surface-alpha`, 78%).

| Картинка   | Основной текст | Вторичный | Акцент | Третичный |
| ---------- | -------------- | --------- | ------ | --------- |
| lupines    | 8.75           | 4.83      | 5.36   | 3.20      |
| lavender   | 8.78           | 4.84      | 5.37   | 3.21      |
| poppies    | 8.70           | 4.80      | 5.33   | 3.18      |
| sunflowers | 8.25           | 4.55      | 5.05   | 3.02      |
| gradient   | 8.31           | 4.59      | 5.09   | 3.04      |
| geometry   | 9.80           | 5.41      | 6.00   | 3.59      |
| spiral     | 8.32           | 4.59      | 5.09   | 3.05      |
| facets     | 8.24           | 4.55      | 5.05   | 3.02      |
| riverside  | 8.32           | 4.59      | 5.09   | 3.05      |
| harbour    | 8.36           | 4.61      | 5.12   | 3.06      |
| glass      | 8.27           | 4.56      | 5.06   | 3.02      |
| bridge     | 8.24           | 4.55      | 5.05   | 3.02      |
| seasunset  | 8.59           | 4.74      | 5.26   | 3.14      |
| surf       | 8.51           | 4.69      | 5.21   | 3.11      |
| reef       | 8.58           | 4.74      | 5.25   | 3.14      |
| seasurface | 8.73           | 4.81      | 5.34   | 3.19      |
| code       | 9.09           | 5.01      | 5.56   | 3.33      |
| colorcode  | 9.11           | 5.02      | 5.57   | 3.33      |
| hardware   | 9.09           | 5.02      | 5.57   | 3.33      |
| ledscreen  | 8.24           | 4.55      | 5.05   | 3.02      |

Худшее по набору: основной текст **8.24:1**, вторичный **4.55:1**, акцент **5.05:1**, третичный **3.02:1**. Порог WCAG AA — 4.5:1 для
обычного текста и 3:1 для нетекстовых элементов; третичным покрашены
подсказки и второстепенные значки, к ним применяется вторая граница.

Ни одна картинка не отсеялась по контрасту: подложка гарантирует порог
даже на сплошь чёрной фотографии, а значит и на любой пользовательской
(расчёт — `apps/web/tests/wallpaperSurfaces.test.ts`).
