# Monitoring System

Node.js product monitoring system that scrapes e-commerce sites and sends Discord or Telegram notifications for new products and stock changes.

## Features

- **Multi-extractor pipeline** — JSON-LD, CSS selectors, and heuristic extraction strategies tried in order
- **Detail page stock verification** — follows product links to confirm stock status on individual pages
- **Price tracking** — detects and reports price changes
- **Dynamic rendering** — Playwright support for JavaScript-rendered sites
- **Cron scheduling** — configurable polling interval
- **Dual notifications** — Discord webhooks or Telegram bot messages

## Prerequisites

- Node.js 18+ and npm, **or** Docker

## Installation

```bash
npm install
```

For targets that require JavaScript rendering (`"dynamic": true`):

```bash
npx playwright install chromium
```

### Docker

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

The container mounts `./data` as a volume so the SQLite database persists across restarts. Configure via `.env` (loaded automatically by docker-compose).

## Configuration

### 1. Environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `NOTIFICATION_CHANNEL` | `discord` or `telegram` | `telegram` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (required if channel is telegram) | — |
| `TELEGRAM_CHAT_ID` | Telegram chat ID (required if channel is telegram) | — |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL (required if channel is discord) | — |
| `DISCORD_WEBHOOK_URL_POKEMON` | Optional Discord webhook for Pokémon product alerts. URLs containing `pokemon` route here; otherwise falls back to `DISCORD_WEBHOOK_URL`. | — |
| `DISCORD_WEBHOOK_URL_ONE_PIECE` | Optional Discord webhook for One Piece product alerts. URLs containing `one-piece` route here; otherwise falls back to `DISCORD_WEBHOOK_URL`. | — |
| `PRODUCT_TARGETS` | JSON array of target configs (see below) | `[]` |
| `PRODUCT_CONCURRENCY` | Max concurrent target fetches | `5` |
| `PRODUCT_REMOVAL_THRESHOLD` | Consecutive cycles a product must be absent before it's marked removed (removal hysteresis — absorbs flaky scrapes) | `3` |
| `PRODUCT_TARGET_TIMEOUT_MS` | Hard upper bound (ms) on a single target's processing. Belt to the per-operation timeouts — guarantees no single target can stall the whole cycle. | `180000` |
| `CURRENCY_RATES_EUR` | JSON object of `{ "CURRENCY": rateToEur }` overrides for the static EUR-conversion table shown in notifications (e.g. `{"GBP":1.25}`) | built-in defaults |
| `CRON_EXPRESSION` | Cron schedule expression | `*/30 * * * *` |
| `DB_PATH` | SQLite database path | `./data/monitoring.db` |
| `LOG_LEVEL` | Logging level (`debug`, `info`, `warn`, `error`) | `info` |
| `PROXY_URL` | Optional proxy (`http://user:pass@host:port`). Store fetches that hit `403`/`429`/`503` or a network error are retried through it; notification traffic is not proxied. Unset = disabled. | — |

### 2. Product targets

Define targets in `PRODUCT_TARGETS` env var or in `data/product-targets.json`. Each target is a JSON object:

```json
[
  {
    "url": "https://example.com/new-arrivals",
    "extractor": "css",
    "selectors": {
      "container": ".product-card",
      "title": ".product-title",
      "productId": "data-product-id",
      "stockStatus": ".stock-label",
      "link": "a"
    },
    "dynamic": false,
    "detailStock": true
  }
]
```

| Field | Description | Required |
|---|---|---|
| `url` | Page URL to scrape | Yes |
| `extractor` | Extraction strategy: `jsonld`, `css`, or `heuristic` | No (auto-detected) |
| `selectors` | CSS selectors for product fields (used with `css` extractor) | No |
| `dynamic` | Use Playwright for JS-rendered pages | No (`false`) |
| `renderWait` | Milliseconds to wait after page load for JS-rendered grids to settle (`dynamic` targets only) | No (`5000`) |
| `detailStock` | Follow product links to verify stock on detail pages | No (`false`) |
| `category` | Force notification routing (e.g. `"pokemon"`, `"one-piece"`); overrides the URL auto-detection | No (auto-detected) |
| `currency` | Force ISO currency code (e.g. `"SEK"`) on every product from this target; overrides extractor detection and JSON-LD. Useful when a store's TLD doesn't disambiguate (e.g. a Swedish shop on a `.com` domain showing `kr`). | No (auto-detected) |

### Ships-to-Portugal indicator

Discord notifications get a 🇵🇹 flag prefixed on the title when the target's store is on the **confirmed ships-to-PT** list:

- **Any `.pt` domain** — automatic.
- **Other hosts** — listed in [`data/ships-to-portugal.json`](data/ships-to-portugal.json). Edit that file to add hosts as you manually verify them; see [`docs/shipping-status.md`](docs/shipping-status.md) for the audit that built the initial list.

## Running

```bash
# Start the monitor
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Scripts

Diagnostic and utility scripts live in `scripts/`:

| Script | Purpose |
|---|---|
| `diagnose-extraction.js` | Test extraction pipeline against a URL |
| `populate-db.js` | Seed the database with existing products |
| `quick-extract.js` | Quick one-shot product extraction |
| `diagnose-dynamic.js` | Debug Playwright-based dynamic rendering |
| `diagnose-containers.js` | Inspect detected product containers on a page |

Run any script with `node scripts/<name>.js`.

## Project Structure

```
src/
├── config.js                  # Environment variable loading
├── index.js                   # Entry point and wiring
├── logger.js                  # Structured logger
├── scheduler.js               # Cron-based scheduling
├── db/
│   ├── database.js            # SQLite connection and migrations
│   ├── migrations.js          # Schema definitions
│   ├── alert-repository.js    # Alert history persistence
│   └── product-repository.js  # Product state persistence
├── extractors/
│   ├── jsonld-extractor.js    # JSON-LD schema.org extraction
│   ├── css-extractor.js       # CSS selector-based extraction
│   └── heuristic-extractor.js # Fallback heuristic extraction
├── monitors/
│   └── product-monitor.js     # Product monitoring orchestration
├── services/
│   ├── http-client.js         # HTTP fetching with retries
│   ├── discord.js             # Discord webhook notifications
│   └── telegram.js            # Telegram bot notifications
└── utils/
    ├── concurrency.js         # Concurrency limiter
    ├── detail-stock-checker.js# Detail page stock verification
    └── oos-keywords.js        # Out-of-stock keyword matching
```
