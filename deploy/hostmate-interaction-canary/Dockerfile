FROM node:20-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
COPY .agents ./.agents
RUN npm run build:interaction-canary

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /src/dist-interaction-canary/start.mjs ./start.mjs
COPY --from=builder /src/.agents ./.agents
USER node
EXPOSE 4311
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4311/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "start.mjs"]
