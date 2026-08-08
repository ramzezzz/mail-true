#!/bin/sh
# Первичное наполнение: основной домен и его строки настроек.
#
# Выполняется ТОЛЬКО самим Postgres при создании базы на пустом томе
# (каталог смонтирован в /docker-entrypoint-initdb.d). Установщик его не
# запускает и запускать не должен: apply_migrations перебирает *.sql, а
# это .sh — и так задумано. Имя домена берётся из окружения, а окружение
# у контейнера базы задаётся при СОЗДАНИИ: на работающем сервере оно уже
# может быть другим (домен меняли из панели), и повторный прогон завёл бы
# второй «основной» домен.
#
# ПОЧЕМУ ЗДЕСЬ ЖЕ ЗАВОДЯТСЯ domain_settings И ai_domain_settings.
# Раньше строку домена вставлял этот скрипт, а строки его настроек —
# запросы INSERT ... SELECT FROM virtual_domains в миграциях 0003, 0004
# и 0006. Работало это по случайности порядка файлов: домен появлялся
# в 0002, а настройки для «всех существующих доменов» досоздавались
# следом. После свёртки миграций в 0001_baseline.sql схема создаётся
# ДО этого скрипта, то есть в момент её создания доменов ещё нет вовсе,
# и те запросы вставили бы ноль строк. Поэтому наполнение собрано в одном
# месте — там, где домен и заводится.
set -e
: "${MAIL_DOMAIN:=mail.local}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOF
INSERT INTO virtual_domains (name) VALUES ('${MAIL_DOMAIN}')
ON CONFLICT (name) DO NOTHING;

-- Строки настроек на каждый домен без своих настроек. Значения по
-- умолчанию заданы в самой схеме, поэтому здесь только связь.
INSERT INTO domain_settings (domain_id)
SELECT d.id FROM virtual_domains d
WHERE NOT EXISTS (SELECT 1 FROM domain_settings s WHERE s.domain_id = d.id);

INSERT INTO ai_domain_settings (domain_id)
SELECT d.id FROM virtual_domains d
WHERE NOT EXISTS (SELECT 1 FROM ai_domain_settings s WHERE s.domain_id = d.id);
EOF
