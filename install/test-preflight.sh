#!/usr/bin/env bash
# ------------------------------------------------------------------
# Предполётные проверки установщика — на подставных командах.
#
#   bash install/test-preflight.sh
#
# Ни Docker, ни root, ни Linux не нужны: docker, snap и systemctl
# подменяются заглушками. Смысл — закрепить то, что было найдено живой
# установкой и стоило человеку часа:
#
#   * Docker из snap выглядит рабочим («Docker работает (29.6.1)»), но
#     каталога проекта не видит, и установка падает через шаг на
#     «no such file or directory» про файл, лежащий на месте;
#   * системный Postfix держит 25-й и 465-й порты, а совет, что это за
#     процесс «master» и что с ним делать, печатался ПОСЛЕ вопроса
#     «всё равно продолжить?» — до него не доходило;
#   * список портов в подсказке был переписан руками и разошёлся с
#     проверяемым: 465-й проверяли, а в подсказке его не было.
# ------------------------------------------------------------------
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
BIN="$TMP/snap/bin"
mkdir -p "$BIN" "$TMP/plain"

PASS=0
FAILED=0
check() { # check <описание> <ожидание> <факт>
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"
    else
        FAILED=$((FAILED + 1)); printf 'FAIL %s: ждали <%s>, получили <%s>\n' "$1" "$2" "$3"
    fi
}

# --- подставной docker: изображает snap (файлов не видит) -------------
cat > "$BIN/docker" <<'EOS'
#!/usr/bin/env bash
case "$1" in
  compose)
     for a in "$@"; do case "$a" in *.yml) f="$a";; esac; done
     printf 'open %s: no such file or directory\n' "$f" >&2; exit 1 ;;
  ps) exit 0 ;;
  info) exit 0 ;;
esac
exit 0
EOS
cat > "$BIN/snap" <<'EOS'
#!/usr/bin/env bash
[ "$1" = list ] && [ "$2" = docker ] && exit 0
exit 1
EOS
chmod +x "$BIN/docker" "$BIN/snap"

# --- подставной docker: обычный, файлы видит --------------------------
cat > "$TMP/plain/docker" <<'EOS'
#!/usr/bin/env bash
case "$1" in
  compose)
     for a in "$@"; do case "$a" in *.yml) f="$a";; esac; done
     [ -f "$f" ] || { printf 'open %s: no such file or directory\n' "$f" >&2; exit 1; }
     exit 0 ;;
esac
exit 0
EOS
chmod +x "$TMP/plain/docker"

# ==== 1. snap распознаётся, обычный docker — нет ======================
(
    PATH="$BIN:$PATH"
    . "$REPO/install/lib/common.sh"
    docker_from_snap && exit 0 || exit 1
)
check "snap-Docker распознан" 0 $?

# ------------------------------------------------------------------
# ПРОВЕРКА, КОТОРАЯ НЕ МОГЛА ПРОВАЛИТЬСЯ.
#
# Здесь стояло уверение «snap в PATH тоже есть — важно, что решает не он,
# а путь к docker». Неправда: в PATH подставлялся только $TMP/plain, где
# лежит один docker, а подставного snap там нет. То есть проверка
# получала «не snap» просто потому, что команды snap не нашлось, — и
# осталась бы зелёной, даже если бы разбор пути выбросили целиком.
#
# Теперь проверок две, и вторая как раз про разбор пути: docker, лежащий
# ПОД /snap/, обязан быть распознан и без команды snap на машине (её там
# может не быть — например, у пакета остались хвосты). Сломай разбор —
# проверка покраснеет.
# ------------------------------------------------------------------
(
    PATH="$TMP/plain:$PATH"
    . "$REPO/install/lib/common.sh"
    docker_from_snap && exit 0 || exit 1
)
check "обычный Docker без snap на машине не принят за snap" 1 $?

# Каталог с «/snap/» в пути и БЕЗ подставного snap рядом — в отличие от
# $BIN, где snap лежит и мог бы ответить за разбор пути.
mkdir -p "$TMP/onlysnap/snap/bin"
cp "$TMP/plain/docker" "$TMP/onlysnap/snap/bin/docker"
(
    # snap-команды в PATH нет НАРОЧНО: решает только путь до файла docker.
    PATH="$TMP/onlysnap/snap/bin:$PATH"
    . "$REPO/install/lib/common.sh"
    docker_from_snap && exit 0 || exit 1
)
check "docker из каталога /snap/ распознан по пути, без команды snap" 0 $?

# ==== 2. видимость каталога ==========================================
(
    PATH="$BIN:$PATH"
    . "$REPO/install/lib/common.sh"
    docker_sees_repo && exit 0 || exit 1
)
check "невидимый каталог замечен" 1 $?

(
    PATH="$TMP/plain:$PATH"
    . "$REPO/install/lib/common.sh"
    docker_sees_repo && exit 0 || exit 1
)
check "видимый каталог принят" 0 $?

# проба за собой убирает
[ -f "$REPO/.mt-docker-probe.yml" ]
check "временный файл пробы удалён" 1 $?

# ==== 3. чужой MTA отключается сам ===================================
cat > "$TMP/plain/systemctl" <<EOS
#!/usr/bin/env bash
if [ "\$1" = is-active ]; then
    # активен только postfix
    for a in "\$@"; do [ "\$a" = postfix ] && exit 0; done
    exit 3
fi
if [ "\$1" = disable ]; then printf '%s\n' "\$@" >> "$TMP/disabled"; exit 0; fi
exit 0
EOS
cat > "$TMP/plain/dpkg-query" <<'EOS'
#!/usr/bin/env bash
exit 1
EOS
chmod +x "$TMP/plain/systemctl" "$TMP/plain/dpkg-query"

# ------------------------------------------------------------------
# Без root отключать нечем — должен сказать это, а не молча делать вид.
#
# ПРОВЕРКА ЛОЖНО ПАДАЛА ОТ ROOT.
#
# Она про поведение «мы не root», а «не root» брала из настоящего `id -u`.
# Запусти проверки от root (а установщик и проверяют от root — это его
# обычный режим) — и handle_foreign_mta уходила в ветку «отключаю сам»:
# совета «sudo systemctl disable» в выводе не оказывалось, файл $TMP/disabled
# появлялся, и обе строки краснели на исправном коде. Красная проверка, к
# которой привыкли, ничем не лучше отсутствующей.
#
# Поэтому `id` тоже подставной: ниже, для ветки «от root», он заменяется
# на возвращающий ноль. Кто мы — решает проверка, а не тот, кто её запустил.
# ------------------------------------------------------------------
cat > "$TMP/plain/id" <<'EOS'
#!/usr/bin/env bash
[ "$1" = "-u" ] && { printf '1000\n'; exit 0; }
exit 0
EOS
chmod +x "$TMP/plain/id"

OUT_NOROOT=$(
    PATH="$TMP/plain:$PATH"
    . "$REPO/install/lib/common.sh"
    handle_foreign_mta 2>&1
)
printf '%s' "$OUT_NOROOT" | grep -q 'sudo systemctl disable'
check "без root сказано, что делать руками" 0 $?
[ -f "$TMP/disabled" ]
check "без root служба не трогалась" 1 $?

# ...а от root — отключает сам
cat > "$TMP/plain/id" <<'EOS'
#!/usr/bin/env bash
[ "$1" = "-u" ] && { printf '0\n'; exit 0; }
exit 0
EOS
chmod +x "$TMP/plain/id"

OUT=$(
    PATH="$TMP/plain:$PATH"
    . "$REPO/install/lib/common.sh"
    handle_foreign_mta 2>&1
)
printf '%s' "$OUT" | grep -q 'postfix'
check "в отчёте назван postfix" 0 $?
grep -q 'disable' "$TMP/disabled" 2>/dev/null
check "служба действительно отключена" 0 $?
printf '%s' "$OUT" | grep -q 'apt-get purge'
check "сказано про оставшийся пакет" 0 $?

# ==== 4. подсказка про порты собирается из общего списка =============
#
# ПРОВЕРКИ, КОТОРЫЕ НЕ МОГЛИ ПРОВАЛИТЬСЯ.
#
# Здесь было три grep по исходникам: «есть строка MT_REQUIRED_PORTS[@]»,
# «есть слово ports_re», «нет фразы про 465». Ни одна не выполняла код и
# ни одна не сравнивала список из подсказки с проверяемым — а разошлись
# они именно так: 465-й проверяли, а в подсказке его не было. Перепиши
# кто-нибудь подсказку руками с тем же словом ports_re — все три
# остались бы зелёными.
#
# Теперь подсказка СТРОИТСЯ по-настоящему, и в ней ищется каждый порт из
# MT_REQUIRED_PORTS. Уберите порт из подсказки — проверка покраснеет.
PORTS_HINT=$(
    . "$REPO/install/lib/common.sh"
    ports_re="$(printf '%s|' "${MT_REQUIRED_PORTS[@]}")"
    printf 'ss -ltnp | grep -E ":(%s)\\b"\n' "${ports_re%|}"
)
MISSING_PORTS=''
for p in $(
    . "$REPO/install/lib/common.sh"
    printf '%s\n' "${MT_REQUIRED_PORTS[@]}"
); do
    printf '%s' "$PORTS_HINT" | grep -qE "(^|[|:(])$p([|)]|\\b)" || MISSING_PORTS="$MISSING_PORTS $p"
done
check "в подсказке названы все проверяемые порты" "" "${MISSING_PORTS# }"
# 465 (submissions) обязан быть и в списке, и в подсказке: его публикует
# install/compose.prod.yml, его же анонсирует автонастройка, и без него
# Outlook и почта Apple упирались в «соединение отклонено».
printf '%s' "$PORTS_HINT" | grep -q '465'
check "порт 465 не потерялся" 0 $?

# ==== 5. Присваивание из падающей команды под set -e ==================
# Установка обрывалась молча (код 1, ни слова об ошибке) на чистом
# сервере: CERT_SOURCE="$(cat файл 2>/dev/null | tr -d ...)" — файла ещё
# нет, cat возвращает единицу, pipefail тянет её в подстановку.
grep -nE '^[^#]*=\"?\$\(cat ' "$REPO/install/install.sh" "$REPO/install/lib/common.sh" >/dev/null 2>&1
check "чтение файла не идёт через \$(cat …)" 1 $?

OUT_SETE=$(
    set -euo pipefail
    CERT_SOURCE_FILE="$TMP/net/source"
    CERT_SOURCE=''
    if [ -f "$CERT_SOURCE_FILE" ]; then
        CERT_SOURCE="$(tr -d '[:space:]' < "$CERT_SOURCE_FILE" 2>/dev/null || true)"
    fi
    printf 'выжили:%s\n' "${CERT_SOURCE:-пусто}"
)
printf '%s' "$OUT_SETE" | grep -q 'выжили:пусто'
check "отсутствие файла не обрывает установку" 0 $?

# ==== 6. Удаление ящика: пустой адрес не сносит почту всех доменов ====
#
# `drop-mailbox.sh "$MAIL"` с незаполненной переменной — обычное дело в
# сценариях проверок. Проверка «аргументов хотя бы один» пустую строку
# пропускала, обе половинки адреса получались пустыми, и строка
#
#     rm -rf /var/mail/vhosts/$DOMAIN_PART/$USER_PART
#
# превращалась в «rm -rf /var/mail/vhosts//» — то есть в удаление почты
# ВСЕХ доменов стенда. Скрипт при этом печатал «ящик  удалён полностью»
# и заканчивался нулевым кодом.
#
# Проверяем настоящим запуском: подставной docker записывает КАЖДЫЙ свой
# вызов. Файла быть не должно вовсе — ни одной команды в контейнер.
mkdir -p "$TMP/dropbin"
cat > "$TMP/dropbin/docker" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/docker-calls.txt"
exit 0
EOS
chmod +x "$TMP/dropbin/docker"

PATH="$TMP/dropbin:$PATH" bash "$REPO/infra/scripts/drop-mailbox.sh" '' >/dev/null 2>&1
check "пустой адрес отвергнут" 2 $?
[ -f "$TMP/docker-calls.txt" ]
check "при пустом адресе в контейнер не ушло ни одной команды" 1 $?

PATH="$TMP/dropbin:$PATH" bash "$REPO/infra/scripts/drop-mailbox.sh" 'не-адрес' >/dev/null 2>&1
check "строка без собаки отвергнута" 2 $?
PATH="$TMP/dropbin:$PATH" bash "$REPO/infra/scripts/drop-mailbox.sh" 'a@b.ru' '../../etc@x' >/dev/null 2>&1
check "адрес со слэшем отвергнут" 2 $?
# И отвергнут ДО первого разрушительного действия: первый адрес в списке
# верный, но негодный второй обязан остановить всё, а не половину.
[ -f "$TMP/docker-calls.txt" ]
check "негодный адрес в списке останавливает уборку до её начала" 1 $?

# Обычный адрес обязан проходить: проверка адресов не должна превратиться
# в «ничего не удаляем никогда».
PATH="$TMP/dropbin:$PATH" bash "$REPO/infra/scripts/drop-mailbox.sh" 'ivanov@nasha.ru' >/dev/null 2>&1
check "обычный адрес принят" 0 $?
grep -q 'ivanov' "$TMP/docker-calls.txt" 2>/dev/null
check "для обычного адреса уборка дошла до контейнера" 0 $?

# ==== 7. selfcheck --external последним аргументом не вешает проверку ==
#
# Было: EXTERNAL="${2:-}"; shift 2. При одном аргументе `shift 2`
# возвращает единицу, сдвига не происходит, а `set -e` здесь намеренно
# выключен — цикл разбора ключей не заканчивался НИКОГДА. Самопроверка
# молча висела, съедая процессор, и её приходилось убивать.
if command -v timeout >/dev/null 2>&1; then
    timeout 15 bash "$REPO/install/selfcheck.sh" --external >/dev/null 2>&1
    RC_EXT=$?
    # 124 — это как раз «timeout убил зависшую»: то самое поведение.
    [ "$RC_EXT" -ne 124 ]
    check "--external без адреса завершается, а не висит" 0 $?
    [ "$RC_EXT" -ne 0 ]
    check "--external без адреса завершается ошибкой" 0 $?
else
    printf 'пропуск: нет timeout, проверку зависания не выполнить\n'
fi

rm -rf "$TMP"
printf '\nпройдено %s, провалено %s\n' "$PASS" "$FAILED"
[ "$FAILED" -eq 0 ]
