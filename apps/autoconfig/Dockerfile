# Сервис автоопределения настроек почтовых клиентов (autoconfig/autodiscover).
# Контекст сборки — корень репозитория (см. infra/docker-compose.yml):
# нужен tsconfig.base.json, от которого наследуется tsconfig сервиса.
FROM node:24-alpine AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY apps/autoconfig/package.json apps/autoconfig/tsconfig.json ./apps/autoconfig/
WORKDIR /repo/apps/autoconfig
RUN npm install --no-audit --no-fund
COPY apps/autoconfig/src ./src
RUN npx tsc -b

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /srv/autoconfig
COPY apps/autoconfig/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/apps/autoconfig/dist ./dist
# Тестовые файлы в рантайме не нужны
RUN rm -f dist/*.test.js dist/*.test.js.map dist/*.test.d.ts dist/*.test.d.ts.map dist/testutil.*
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
