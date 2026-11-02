# Production image for the Next.js app (system_design.md §5, service "frontend").
# Three stages: only the last one becomes the image; the first two are thrown away after the build.

# 1. All dependencies (dev ones too: TypeScript and Tailwind are needed to build).
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# 2. Compile the app into .next/.
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# 3. The image that runs: production dependencies and the compiled app only, no source code.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
# Reuse the packages of stage 1 and remove the dev ones: no second download from the npm registry.
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/public ./public
# The "node" user (built into the base image) owns .next/, so the server can write its page cache there (ISR).
COPY --from=build --chown=node:node /app/.next ./.next
USER node

EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
