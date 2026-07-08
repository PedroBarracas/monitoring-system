FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium

COPY src/ src/
COPY scripts/ scripts/
COPY data/product-targets.json data/product-targets.json

EXPOSE 3000

CMD ["node", "src/index.js"]
