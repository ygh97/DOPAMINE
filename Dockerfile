# 도파민 센터 프로덕션 컨테이너 (Node 24 + 웹 정적 빌드 + SQLite 내장)
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN npm ci

COPY packages ./packages
COPY apps ./apps

RUN npm run build --workspace @dopamine/web

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4810
ENV DB_FILE=/app/data/dopamine.db

VOLUME ["/app/data"]
EXPOSE 4810

CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
