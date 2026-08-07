# Веб-установщик Mail.True — мастер первого запуска в браузере.
#
# Образ живёт ровно столько, сколько идёт установка: служба поднимается под
# профилем installer, а закончив, останавливает себя сама (см. комментарий
# к службе installer в infra/docker-compose.yml).
#
# ------------------------------------------------------------------
# ПОЧЕМУ ЗДЕСЬ СТОЛЬКО СИСТЕМНЫХ ПАКЕТОВ
# ------------------------------------------------------------------
# Установщик не переписывает установку заново — он запускает ту же
# install/install.sh, что и в консоли. Значит внутри контейнера должно быть
# всё, что она ожидает найти на сервере:
#
#   bash              — сама install.sh и install/lib/common.sh;
#   docker-cli,
#   docker-cli-compose,
#   docker-cli-buildx — сборка образов и подъём стека через сокет;
#   coreutils         — df --output, date -Iseconds, sha256sum, install -m:
#                       у busybox этих ключей нет, и проверки install.sh
#                       молча выдавали бы «свободно 0 ГБ»;
#   openssl           — самоподписанный сертификат;
#   curl, bind-tools,
#   iproute2          — то, что install.sh доустанавливает на голой Ubuntu
#                       через apt-get; здесь apt-get нет, поэтому кладём сразу,
#                       иначе она напишет «не хватает: curl dig ss»;
#   postgresql-client — не нужен: запросы к базе идут через docker compose exec
#                       в контейнер postgres, как и в консольной установке.
FROM node:24-alpine AS build
WORKDIR /repo
COPY tsconfig.base.json ./
# Общий пакет: в нём живут правила разбора своего TLS-сертификата — те же,
# что применяет раздел «Сертификат» в панели. Двух наборов правил на одно
# действие быть не должно, поэтому пакет собирается прямо здесь.
COPY packages/shared ./packages/shared
COPY apps/installer/package.json apps/installer/tsconfig.json ./apps/installer/
WORKDIR /repo/apps/installer
RUN npm install --no-audit --no-fund \
    # Общий пакет собирается тем же компилятором и теми же описаниями
    # типов. Своих зависимостей у packages/shared нет — в хранилище он
    # берёт их из корня рабочих пространств, которого здесь не существует.
    # Ссылка ставит их туда, где он их ищет: без неё сборка падает на
    # «Cannot find module 'node:crypto'» при полностью исправном коде.
    && ln -s /repo/apps/installer/node_modules /repo/node_modules
COPY apps/installer/src ./src
RUN npx tsc -b

FROM node:24-alpine
ENV NODE_ENV=production
RUN apk add --no-cache \
      bash \
      coreutils \
      docker-cli \
      docker-cli-buildx \
      docker-cli-compose \
      openssl \
      curl \
      bind-tools \
      iproute2 \
      tar

WORKDIR /srv/installer
COPY apps/installer/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/apps/installer/dist ./dist
COPY apps/installer/public ./public
# Связь с общим пакетом делается руками: рабочих пространств npm в этом
# образе нет (установщик ставит только свои зависимости), а импорт
# «@mail-true/shared» должен разрешаться в рантайме так же, как при сборке.
COPY packages/shared/package.json ./node_modules/@mail-true/shared/package.json
COPY --from=build /repo/packages/shared/dist ./node_modules/@mail-true/shared/dist
COPY apps/installer/scripts/certbot /usr/local/bin/certbot
RUN chmod 755 /usr/local/bin/certbot \
 && rm -f dist/*.test.js dist/*.test.js.map dist/*.test.d.ts dist/*.test.d.ts.map

# Работает от root намеренно: ему нужен сокет Docker и право писать в
# infra/.env и infra/data/certs каталога проекта. Это и есть та цена, которая
# платится на время установки и исчезает вместе со службой.
EXPOSE 8099
CMD ["node", "dist/server.js"]
