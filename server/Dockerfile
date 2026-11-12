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
# TRUST_PROXY_HOPS is set by the deployment that sits behind a proxy (cloudrun.sh), not baked in.
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/app.db
COPY --from=build /repo/server/dist ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "main.js"]
