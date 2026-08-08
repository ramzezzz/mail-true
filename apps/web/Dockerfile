# Веб-интерфейс почты Mail.True: сборка Vite, раздача nginx.
#
# Контекст сборки — корень репозитория (npm workspaces): интерфейсу нужен
# общий пакет packages/shared, а генератору дизайн-токенов — выгрузка
# brand/reference/design-tokens-raw.json.
#
# Итоговый образ — nginx со статикой: ни Node, ни node_modules, ни исходников.

# ------------------------------------------------------------------
# 1. Зависимости монорепозитория (слой общий с apps/api и apps/admin)
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
# 2. Сборка: токены -> проверка типов (tsc -b) -> vite build
# ------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
# Нужен генератору apps/web/scripts/build-tokens.mjs
COPY brand/reference/design-tokens-raw.json ./brand/reference/
COPY apps/web ./apps/web
RUN npm run build --workspace @mail-true/web \
    # Карты кода наружу не отдаём: это +1.7 МБ к образу и исходники в открытом виде
    && find apps/web/dist -name '*.map' -delete

# ------------------------------------------------------------------
# 3. Итоговый образ: nginx 1.27-alpine (тот же, что у фронтового сервиса,
#    отдельный слой базового образа не скачивается)
# ------------------------------------------------------------------
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# Работаем не от root. Штатный entrypoint образа при этом пропускает
# свои root-шаги (шаблоны нам не нужны) и просто запускает nginx.
RUN mkdir -p /tmp/client_temp \
    && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /tmp/client_temp

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -qO- http://127.0.0.1:8080/healthz | grep -q '"ok":true'
