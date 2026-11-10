# Pin this to the exact Playwright version in package.json. The image ships the
# matching Chromium build, so we never download browsers at runtime.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Run as the image's non-root user. Mounted output dirs should be writable by
# UID 1000, or override with `--user "$(id -u):$(id -g)"`.
USER pwuser

# Chromium in a container needs --no-sandbox; see src/capture.ts.
ENTRYPOINT ["node", "dist/cli.js"]
