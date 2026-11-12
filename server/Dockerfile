# Hosted translation proxy. Build from the repository root:
#   docker build -f server/Dockerfile -t ast-proxy .
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/translation ./src/translation
COPY src/types ./src/types
COPY server ./server
RUN npm run server:build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/app.db \
    TRUST_PROXY_HOPS=1
COPY --from=build /repo/server/dist ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "main.js"]
