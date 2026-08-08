/**
 * Сборка руководства в PDF.
 *
 * Главное решение: текст глав берётся из НАСТОЯЩИХ документов проекта
 * (`docs/install.md`, `docs/migration.md`, `docs/autoconfig.md`), а не пишется
 * в руководстве заново. Второй экземпляр тех же инструкций разошёлся бы с
 * первым при первой же правке — и человек, читающий PDF, получил бы шаги от
 * прошлой версии продукта. Ровно этот класс расхождений (описание живёт
 * отдельно от того, что оно описывает) уже стоил нам девяти дефектов.
 *
 * Своё у руководства только то, чего в документах нет по существу: титул,
 * вводная глава и обзор интерфейса со снимками экрана.
 *
 * PDF печатается обычным Chrome. Шрифты и картинки вшиваются в HTML целиком,
 * чтобы файл собирался без сети и открывался одинаково везде.
 *
 * Запуск:  node docs/manual/build.mjs
 * Итог:    docs/Mail.True — руководство.pdf
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { marked } from 'marked';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '..');
const ROOT = resolve(DOCS, '..');
const BRAND = join(ROOT, 'apps/web/public/brand');

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const OUT_PDF = join(DOCS, 'Mail.True — руководство.pdf');
const OUT_HTML = join(HERE, 'build', 'manual.html');

/* ---------------------------------------------------------------- */
/* Главы                                                             */
/* ---------------------------------------------------------------- */

/*
 * Порядок глав задаётся здесь, а не номерами файлов: числа в именах внутри
 * `src/` — это порядок появления главы в проекте, и переименовывать четыре
 * файла ради каждой вставленной в середину главы значило бы каждый раз
 * трогать то, что не менялось.
 */
const CHAPTERS = [
  { file: join(HERE, 'src/01-o-produkte.md'), title: 'О продукте' },
  { file: join(DOCS, 'install.md'), title: 'Установка на боевой сервер' },
  { file: join(HERE, 'src/05-ustanovka-master.md'), title: 'Установка через браузер' },
  { file: join(HERE, 'src/02-obzor.md'), title: 'Обзор интерфейса' },
  { file: join(HERE, 'src/03-admin.md'), title: 'Панель администратора' },
  { file: join(DOCS, 'autoconfig.md'), title: 'Почтовые клиенты и автонастройка' },
  { file: join(DOCS, 'migration.md'), title: 'Перенос почты с другого сервера' },
  { file: join(HERE, 'src/04-kerio.md'), title: 'Перенос из Kerio Connect: по шагам' },
  { file: join(HERE, 'src/06-obsluzhivanie.md'), title: 'Обслуживание' },
];

/* ---------------------------------------------------------------- */
/* Вшивание ресурсов                                                 */
/* ---------------------------------------------------------------- */

async function dataUri(path, mime) {
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function fontFaces() {
  const files = [
    ['Golos Text', 'golos-text-cyrillic-wght.woff2'],
    ['Golos Text', 'golos-text-latin-wght.woff2'],
    ['JetBrains Mono', 'jetbrains-mono-cyrillic-wght.woff2'],
    ['JetBrains Mono', 'jetbrains-mono-latin-wght.woff2'],
  ];
  const out = [];
  for (const [family, file] of files) {
    const uri = await dataUri(join(BRAND, 'fonts', file), 'font/woff2');
    out.push(`@font-face{font-family:'${family}';font-weight:400 900;font-display:block;
      src:url('${uri}') format('woff2-variations');}`);
  }
  return out.join('\n');
}

/* ---------------------------------------------------------------- */
/* Разметка                                                          */
/* ---------------------------------------------------------------- */

/**
 * Заголовки глав из исходных документов опускаются на уровень ниже: в самом
 * документе `# Установка…` — верхний уровень, а в руководстве это глава, и
 * над ней стоит номер. Без сдвига в оглавлении оказались бы два первых уровня.
 */
function demoteHeadings(md) {
  return md.replace(/^(#{1,5}) /gm, (_, hashes) => `${hashes}# `);
}

/** Убирает первый заголовок документа: его заменяет заголовок главы. */
function dropLeadingHeading(md) {
  return md.replace(/^#\s+.*\n+/, '');
}

const slug = (text, seen) => {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'razdel';
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
};

async function renderChapters() {
  const seen = new Set();
  const toc = [];
  const parts = [];

  for (const [index, chapter] of CHAPTERS.entries()) {
    const number = index + 1;
    const raw = await readFile(chapter.file, 'utf8');
    const body = demoteHeadings(dropLeadingHeading(raw));

    const id = slug(chapter.title, seen);
    const entry = { number, title: chapter.title, id, children: [] };

    // Оглавление строится по тем же заголовкам, что окажутся в тексте:
    // отдельный список пришлось бы поддерживать вручную, и он бы отстал.
    const renderer = new marked.Renderer();
    const baseHeading = renderer.heading.bind(renderer);
    renderer.heading = (token) => {
      const text = token.text;
      const depth = token.depth;
      const anchor = slug(text, seen);
      if (depth === 2) entry.children.push({ title: text, id: anchor });
      const html = baseHeading(token);
      return html.replace(/^<h(\d)/, `<h$1 id="${anchor}"`);
    };

    const html = await marked.parse(body, { renderer, async: true });
    toc.push(entry);
    parts.push(`
      <section class="chapter" id="${id}">
        <p class="chapter-number">Глава ${number}</p>
        <h1>${chapter.title}</h1>
        ${html}
      </section>`);
  }

  return { toc, html: parts.join('\n') };
}

/** Заменяет ссылки на картинки вшитыми данными. */
async function inlineImages(html) {
  const found = [...html.matchAll(/src="((?:img|\.\/img)\/[^"]+)"/g)];
  let out = html;
  for (const [, src] of found) {
    const file = join(HERE, src.replace(/^\.\//, ''));
    const uri = await dataUri(file, 'image/png');
    out = out.replaceAll(`src="${src}"`, `src="${uri}"`);
  }
  return out;
}

function tocHtml(toc) {
  const items = toc
    .map(
      (c) => `
      <li class="toc-chapter">
        <a href="#${c.id}"><span class="toc-num">${c.number}</span> ${c.title}</a>
        ${
          c.children.length
            ? `<ul>${c.children
                .map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`)
                .join('')}</ul>`
            : ''
        }
      </li>`,
    )
    .join('');
  return `<nav class="toc"><h1>Содержание</h1><ul>${items}</ul></nav>`;
}

/* ---------------------------------------------------------------- */

const CSS = `
:root{
  --sin:#006EC6;          /* True Blue — фирменный цвет, см. docs/brand.md */
  --sin-tem:#005CA8;
  --tekst:#12161C;
  --tihiy:#5A6472;
  --linia:#DFE4EA;
  --fon-koda:#F5F7FA;
}

@page{
  size:A4;
  margin:20mm 18mm 18mm;
}
/* Титул и содержание — без полей сверху под шапку */
@page:first{ margin-top:0; }

*{box-sizing:border-box}
body{
  font-family:'Golos Text',system-ui,sans-serif;
  font-size:10.5pt;
  line-height:1.6;
  color:var(--tekst);
  margin:0;
  /* Печать по умолчанию выбрасывает фоновые заливки: без этого пропали бы
     подложки блоков кода, таблиц и предупреждений. */
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* --- Титул ---------------------------------------------------- */
.title-page{
  height:257mm;                      /* A4 минус поля: ровно один лист */
  display:flex; flex-direction:column; justify-content:center;
  padding:0 18mm;
  page-break-after:always;
}
.title-page img{width:78mm;margin-bottom:16mm}
.title-page h1{font-size:30pt;line-height:1.15;margin:0 0 6mm;font-weight:800;letter-spacing:-0.02em}
.title-page .lead{font-size:13pt;color:var(--tihiy);margin:0 0 22mm;max-width:120mm}
.title-page .meta{font-size:9.5pt;color:var(--tihiy);border-top:1px solid var(--linia);padding-top:5mm}
.title-page .meta b{color:var(--tekst);font-weight:600}

/* --- Содержание ----------------------------------------------- */
.toc{page-break-after:always;padding-top:14mm}
.toc h1{font-size:20pt;margin:0 0 8mm;font-weight:800}
.toc ul{list-style:none;margin:0;padding:0}
.toc .toc-chapter{margin-bottom:5mm}
.toc .toc-chapter > a{
  font-size:12pt;font-weight:700;color:var(--tekst);text-decoration:none;
  display:flex;gap:4mm;align-items:baseline;
}
.toc .toc-num{
  color:var(--sin);font-variant-numeric:tabular-nums;
  min-width:6mm;font-weight:800;
}
.toc .toc-chapter ul{margin:2mm 0 0 10mm}
.toc .toc-chapter ul li{margin:1mm 0}
.toc .toc-chapter ul a{font-size:10pt;color:var(--tihiy);text-decoration:none}

/* --- Главы ----------------------------------------------------- */
.chapter{page-break-before:always}
.chapter-number{
  font-size:9pt;letter-spacing:.14em;text-transform:uppercase;
  color:var(--sin);font-weight:700;margin:0 0 2mm;
}
.chapter > h1{
  font-size:22pt;font-weight:800;letter-spacing:-0.02em;
  margin:0 0 8mm;padding-bottom:4mm;border-bottom:2px solid var(--sin);
}
h2{font-size:15pt;font-weight:700;margin:9mm 0 3mm;page-break-after:avoid}
h3{font-size:12pt;font-weight:700;margin:6mm 0 2mm;page-break-after:avoid}
h4{font-size:10.5pt;font-weight:700;margin:5mm 0 2mm;page-break-after:avoid}
p{margin:0 0 3mm}
ul,ol{margin:0 0 3mm;padding-left:6mm}
li{margin:1mm 0}
strong{font-weight:700}
a{color:var(--sin-tem);text-decoration:none}

/* --- Код ------------------------------------------------------- */
code{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:8.8pt;background:var(--fon-koda);
  padding:.5mm 1.2mm;border-radius:2px;
}
pre{
  background:var(--fon-koda);border:1px solid var(--linia);border-left:3px solid var(--sin);
  border-radius:3px;padding:3mm 4mm;margin:0 0 4mm;
  /* Длинные команды переносятся, а не уезжают за край листа: на бумаге
     горизонтальной прокрутки не бывает, и обрезанная команда бесполезна. */
  white-space:pre-wrap;word-break:break-word;
  page-break-inside:avoid;
}
pre code{background:none;padding:0;font-size:8.4pt;line-height:1.5}

/* --- Таблицы --------------------------------------------------- */
table{
  width:100%;border-collapse:collapse;margin:0 0 4mm;font-size:9.2pt;
  page-break-inside:avoid;
}
th{
  text-align:left;background:var(--fon-koda);font-weight:700;
  border-bottom:1.5px solid var(--linia);padding:2mm 2.5mm;
}
td{border-bottom:1px solid var(--linia);padding:2mm 2.5mm;vertical-align:top}

blockquote{
  margin:0 0 4mm;padding:2.5mm 4mm;border-left:3px solid var(--sin);
  background:var(--fon-koda);color:var(--tihiy);
}
hr{border:0;border-top:1px solid var(--linia);margin:6mm 0}

/* --- Снимки экрана --------------------------------------------- */
figure{margin:5mm 0;page-break-inside:avoid}
figure img{
  width:100%;border:1px solid var(--linia);border-radius:4px;
  display:block;
}
figcaption{
  font-size:9pt;color:var(--tihiy);margin-top:2mm;text-align:center;
}
/* Одиночная картинка в абзаце — тот же вид, что и в figure */
p > img{width:100%;border:1px solid var(--linia);border-radius:4px;display:block;margin:4mm 0}
`;

async function main() {
  await mkdir(dirname(OUT_HTML), { recursive: true });

  const [fonts, { toc, html: chapters }] = await Promise.all([fontFaces(), renderChapters()]);
  const logo = await dataUri(join(BRAND, 'logo-full.svg'), 'image/svg+xml');

  const today = new Date().toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  let doc = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Mail.True — руководство по развёртыванию</title>
<style>${fonts}\n${CSS}</style>
</head><body>

<div class="title-page">
  <img src="${logo}" alt="Mail.True">
  <h1>Руководство<br>по развёртыванию</h1>
  <p class="lead">Установка почтового сервера, настройка домена, подключение
     почтовых клиентов и перенос ящиков с других серверов.</p>
  <p class="meta">
    <b>Mail.True</b> — почтовый сервер с веб-интерфейсом<br>
    Документ собран ${today}
  </p>
</div>

${tocHtml(toc)}
${chapters}

</body></html>`;

  doc = await inlineImages(doc);
  await writeFile(OUT_HTML, doc, 'utf8');
  console.log(`разметка: ${OUT_HTML} (${(doc.length / 1024 / 1024).toFixed(1)} МБ)`);

  await rm(OUT_PDF, { force: true });
  const profile = join(process.env.TEMP ?? '/tmp', `mailtrue-pdf-${process.pid}`);
  await new Promise((done, fail) => {
    const proc = spawn(
      CHROME,
      [
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        // Колонтитулы Chrome — это URL файла и английская дата: в готовом
        // документе они выглядят как след инструмента, а не как вёрстка.
        '--no-pdf-header-footer',
        `--print-to-pdf=${OUT_PDF}`,
        `file:///${OUT_HTML.replace(/\\/g, '/')}`,
      ],
      { stdio: 'inherit' },
    );
    proc.on('exit', (code) => (code === 0 ? done() : fail(new Error(`Chrome вышел с ${code}`))));
    proc.on('error', fail);
  });
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);

  const { size } = await import('node:fs/promises').then((fs) => fs.stat(OUT_PDF));
  console.log(`готово: ${OUT_PDF} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
}

await main();
