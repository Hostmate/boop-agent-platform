FROM node:20-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
RUN npm run build:hostmate-runtime

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /src/dist-hostmate-runtime/start.mjs ./start.mjs
USER node
EXPOSE 4310
CMD ["node", "start.mjs"]
