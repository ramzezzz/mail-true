# Админка Mail.True: сборка Vite, раздача nginx.
#
# Контекст сборки — корень репозитория (npm workspaces). Админка не копирует
# дизайн-систему, а берёт компоненты и токены из apps/web (алиас @web/*),
# поэтому в сборку попадают исходники обоих приложений.
#
# Итоговый образ — nginx со статикой: ни Node, ни node_modules, ни исходников.

# ------------------------------------------------------------------
# 1. Зависимости монорепозитория (слой общий с apps/api и apps/web)
# ------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /repo
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
# 2. Сборка: проверка типов (tsc --noEmit) -> vite build
# ------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY research/mailru/design-tokens-raw.json ./research/mailru/
COPY apps/web ./apps/web
COPY apps/admin ./apps/admin
# Слой дизайн-токенов порождается генератором, а не пишется руками:
# так админка собирается даже из дерева, где tokens.css ещё не сгенерирован.
RUN npm run tokens --workspace @mail-true/web \
    && npm run build --workspace @mail-true/admin \
    && find apps/admin/dist -name '*.map' -delete

# ------------------------------------------------------------------
# 3. Итоговый образ
# ------------------------------------------------------------------
FROM nginx:1.27-alpine
COPY apps/admin/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html

RUN mkdir -p /tmp/client_temp \
    && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /tmp/client_temp

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -qO- http://127.0.0.1:8080/healthz | grep -q '"ok":true'
