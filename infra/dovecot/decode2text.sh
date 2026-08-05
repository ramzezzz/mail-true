#!/bin/sh
# Извлечение текста из вложений для полнотекстового индекса (fts_decoder).
#
# Как это устроено в Dovecot: плагин fts при индексации встречает часть письма
# не-текстового типа и отдаёт её службе `decode2text` (см. dovecot.conf,
# `service decode2text` + `plugin { fts_decoder = decode2text }`).
# Служба поднимает этот скрипт через обёртку `script`:
#   * без аргументов  -> скрипт печатает список поддерживаемых типов
#                        (Dovecot спрашивает это один раз, чтобы зря не гонять
#                         вложения, которые мы всё равно не разберём);
#   * с Content-Type в $1 -> само вложение приходит на stdin, а на stdout
#                        мы обязаны выдать UTF-8 текст (мусор Dovecot отбросит).
#
# Второй столбец списка — расширение файла. Оно используется, когда клиент
# прислал вложение как application/octet-stream: тогда тип угадывается по имени.
#
# Разборщики ставятся в образ (см. Dockerfile): poppler-utils, catdoc, unzip,
# unrtf. XML из OOXML/ODF разбирает штатный /usr/lib/dovecot/xml2text.

libexec_dir=$(dirname "$0")
content_type=$1

formats='application/pdf pdf
application/x-pdf pdf
application/msword doc
application/vnd.ms-word doc
application/mspowerpoint ppt
application/vnd.ms-powerpoint ppt
application/ms-excel xls
application/x-msexcel xls
application/vnd.ms-excel xls
application/vnd.openxmlformats-officedocument.wordprocessingml.document docx
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet xlsx
application/vnd.openxmlformats-officedocument.presentationml.presentation pptx
application/vnd.oasis.opendocument.text odt
application/vnd.oasis.opendocument.spreadsheet ods
application/vnd.oasis.opendocument.presentation odp
application/rtf rtf
application/x-rtf rtf
'

# Вызов без аргументов — Dovecot спрашивает, что мы умеем разбирать
if [ -z "$content_type" ]; then
  echo "$formats"
  exit 0
fi

fmt=$(echo "$formats" | grep -w "^$content_type" | cut -d ' ' -f 2)
if [ -z "$fmt" ]; then
  echo "Content-Type: $content_type not supported" >&2
  exit 1
fi

# Разборщики не умеют читать stdin, поэтому кладём вложение во временный файл
path=$(mktemp) || exit 1
trap 'rm -rf "$path" "$tempdir"' 0 1 2 3 14 15
cat > "$path"

# Распаковать zip-контейнер (OOXML/ODF) и вытащить текст из нужных XML
xmlunzip() {
  name=$1
  tempdir=$(mktemp -d) || exit 1
  cd "$tempdir" || exit 1
  unzip -q "$path" 2>/dev/null || exit 0
  find . -name "$name" -print0 | xargs -0 cat 2>/dev/null | "$libexec_dir/xml2text"
}

LANG=C.UTF-8
export LANG

# Ограничение по времени: битое вложение не должно вешать индексатор
run() { timeout 20 "$@" 2>/dev/null; return 0; }

case "$fmt" in
  pdf)  run pdftotext -enc UTF-8 "$path" - ;;
  doc)  run catdoc -d utf-8 "$path" ;;
  ppt)  run catppt -d utf-8 "$path" ;;
  xls)  run xls2csv -d utf-8 "$path" ;;
  rtf)  run unrtf --text --nopict "$path" ;;
  odt|ods|odp) xmlunzip "content.xml" ;;
  docx) xmlunzip "document.xml" ;;
  xlsx) xmlunzip "sharedStrings.xml" ;;
  pptx) xmlunzip "slide*.xml" ;;
  *)    echo "Buggy decoder script: $fmt not handled" >&2; exit 1 ;;
esac
exit 0
