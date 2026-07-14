FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY mcp/package.json ./package.json
COPY mcp/src ./src

USER node
EXPOSE 3001

CMD ["node", "src/index.js"]
