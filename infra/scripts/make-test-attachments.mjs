// Генератор тестовых вложений для проверки полнотекстового поиска.
// Делает два файла с заведомо уникальными словами внутри:
//   fts-test.pdf  — PDF со словом kryptonorbis (латиница: у базового шрифта
//                   PDF нет кириллицы, а нам важно проверить сам разбор PDF)
//   fts-test.docx — DOCX (OOXML = zip) с русским словом «квазисенокос»
// Использование: node infra/scripts/make-test-attachments.mjs <каталог>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".";
mkdirSync(outDir, { recursive: true });

export const PDF_WORD = "kryptonorbis";
export const DOCX_WORD = "квазисенокос";

// ---------------------------------------------------------------- PDF
// Минимальный корректный PDF: каталог, страница, поток с текстом, шрифт.
// Смещения объектов считаем на ходу — таблица xref должна быть точной.
function buildPdf(text) {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
      "/Resources<</Font<</F1 5 0 R>>>>>>",
    null, // поток с текстом, собирается ниже
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const stream = `BT /F1 14 Tf 72 700 Td (${text}) Tj ET\n`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}endstream`;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\n` +
    `startxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------- ZIP
// DOCX — это zip. Пишем без сжатия (метод 0): так формат укладывается
// в полсотни строк и не требует внешних библиотек.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // требуемая версия
    lh.writeUInt16LE(0, 6); // флаги
    lh.writeUInt16LE(0, 8); // метод: без сжатия
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, end]);
}

function buildDocx(text) {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return buildZip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    ],
    [
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ]);
}

writeFileSync(
  join(outDir, "fts-test.pdf"),
  buildPdf(`Otchet za kvartal ${PDF_WORD} confidential`),
);
writeFileSync(
  join(outDir, "fts-test.docx"),
  buildDocx(`Отчёт за квартал ${DOCX_WORD} для проверки поиска`),
);
console.log(`fts-test.pdf (${PDF_WORD}) и fts-test.docx (${DOCX_WORD}) -> ${outDir}`);
