FROM node:20-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY convex ./convex
COPY server ./server
RUN npm run build:interaction-canary

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /src/dist-interaction-canary/start.mjs ./start.mjs
USER node
EXPOSE 4311
CMD ["node", "start.mjs"]
