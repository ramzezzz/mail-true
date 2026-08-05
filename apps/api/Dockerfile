# Сервер приложения Mail.True (Fastify): HTTP API /api/* и WebSocket /ws.
#
# Контекст сборки — корень репозитория: это npm workspaces, и сборке нужны
# общие пакеты packages/shared, packages/ai, packages/migrate.
#
# Сборка двухстадийная: компилятор, исходники и dev-зависимости остаются
# в промежуточных слоях, в итоговый образ попадают только dist и
# production-зависимости.

# ------------------------------------------------------------------
# 1. Зависимости монорепозитория.
#    Слой одинаков в apps/api, apps/web и apps/admin — BuildKit
#    переиспользует его между тремя образами и не качает npm трижды.
# ------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /repo
# Только манифесты: правка исходников не должна ронять кэш npm ci
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/admin/package.json ./apps/admin/
COPY apps/autoconfig/package.json ./apps/autoconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ai/package.json ./packages/ai/
COPY packages/migrate/package.json ./packages/migrate/
RUN npm ci --no-audit --no-fund

# ------------------------------------------------------------------
# 2. Компиляция TypeScript.
#    tsc -b собирает и связанные проекты (shared, ai, migrate) —
#    они перечислены в references у apps/api/tsconfig.json.
# ------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npx tsc -b apps/api \
    # Тесты в рантайме не нужны и тянут за собой лишние файлы
    && find apps/api/dist packages/shared/dist packages/ai/dist packages/migrate/dist \
        -type d -name '__tests__' -prune -exec rm -rf {} + \
    && find apps/api/dist packages/shared/dist packages/ai/dist packages/migrate/dist \
        -type f \( -name '*.test.*' -o -name 'testutil.*' -o -name '*.map' \) -delete

# ------------------------------------------------------------------
# 3. Только production-зависимости самого API.
#    Ключ -w оставляет дерево одного рабочего пространства: vite, react
#    и прочее из apps/web в образ сервера не попадает.
# ------------------------------------------------------------------
FROM node:24-alpine AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/admin/package.json ./apps/admin/
COPY apps/autoconfig/package.json ./apps/autoconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ai/package.json ./packages/ai/
COPY packages/migrate/package.json ./packages/migrate/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @mail-true/api \
    && npm cache clean --force \
    && rm -rf /root/.npm

# ------------------------------------------------------------------
# 4. Итоговый образ.
#
#    Базой взят не node:24-alpine (234 МБ), а чистая Alpine с одним лишь
#    двоичным файлом node: сервер запускается как `node dist/server.js`,
#    ни npm, ни npx, ни corepack, ни yarn, ни заголовки для нативных
#    модулей в рантайме не нужны. Это минус 37 МБ образа (306 -> 269 МБ)
#    и минус четыре лишних способа что-нибудь запустить внутри контейнера.
#    Больше отсюда не выжать: 125 МБ из оставшихся — сам двоичный node.
#
#    ВАЖНО: версия Alpine здесь должна совпадать с той, на которой собран
#    node:24-alpine (`cat /etc/alpine-release` в нём) — node динамически
#    слинкован с musl, libstdc++ и libgcc этой системы.
# ------------------------------------------------------------------
FROM alpine:3.24
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
RUN apk add --no-cache libstdc++ ca-certificates
COPY --from=node:24-alpine /usr/local/bin/node /usr/local/bin/node
WORKDIR /srv

# Раскладка каталогов сохраняется: связи node_modules/@mail-true/* —
# относительные символические ссылки внутрь packages/.
COPY --from=prod-deps /repo/ ./
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/ai/dist ./packages/ai/dist
COPY --from=build /repo/packages/migrate/dist ./packages/migrate/dist
COPY --from=build /repo/apps/api/dist ./apps/api/dist

# Пользователь vmail с тем же uid, что у Dovecot (5000): API кладёт личные
# правила фильтрации прямо в почтовое хранилище (SIEVE_TRANSPORT=local),
# и файлы обязаны принадлежать владельцу Maildir. Заодно это гарантирует,
# что от root не работает ничего.
RUN addgroup -g 5000 vmail \
    && adduser -u 5000 -G vmail -D -H -h /srv vmail \
    # Каталог временных вложений: права выставляются в образе, чтобы
    # свежесозданный том получил их же, а не root:root
    && mkdir -p /srv/data/uploads \
    && chown -R 5000:5000 /srv/data

USER 5000:5000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD wget -qO- http://127.0.0.1:3000/healthz | grep -q '"ok":true'
CMD ["node", "apps/api/dist/server.js"]
