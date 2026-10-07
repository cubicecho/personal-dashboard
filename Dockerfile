FROM node:26-alpine
WORKDIR /app
COPY package*.json biome.json ./
COPY server/package.json server/
RUN npm ci --omit=dev
COPY server/src server/src
COPY app app
# Schema snapshots for apps that refuse introspection in production.
COPY schemas schemas
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/src/index.ts"]
