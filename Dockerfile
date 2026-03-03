FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY data/product-targets.json data/product-targets.json

EXPOSE 3000

CMD ["node", "src/index.js"]
