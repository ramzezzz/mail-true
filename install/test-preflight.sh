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

(
    PATH="$TMP/plain:$PATH"
    . "$REPO/install/lib/common.sh"
    # snap в PATH тоже есть — важно, что решает не он, а путь к docker
    docker_from_snap && exit 0 || exit 1
)
check "обычный Docker не принят за snap" 1 $?

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

# Без root отключать нечем — должен сказать это, а не молча делать вид
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
grep -q 'MT_REQUIRED_PORTS\[@\]' "$REPO/install/lib/common.sh"
check "подсказка строится из MT_REQUIRED_PORTS" 0 $?
grep -q 'ports_re' "$REPO/install/lib/common.sh"
check "жёсткий список портов убран" 0 $?
grep -q 'стек его не использует' "$REPO/install/install.sh" "$REPO/install/lib/common.sh"
check "устаревшая фраза про 465 удалена" 1 $?

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

rm -rf "$TMP"
printf '\nпройдено %s, провалено %s\n' "$PASS" "$FAILED"
[ "$FAILED" -eq 0 ]
