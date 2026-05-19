const cssExtractor = require('../extractors/css-extractor');
const jsonldExtractor = require('../extractors/jsonld-extractor');
const heuristicExtractor = require('../extractors/heuristic-extractor');
const { createLimiter } = require('../utils/concurrency');
const OOS_KEYWORDS = require('../utils/oos-keywords');
const { checkDetailPageStock } = require('../utils/detail-stock-checker');
const { formatPriceDisplay } = require('../utils/price');
const { shipsToPortugal } = require('../utils/ships-to-portugal');

function resolveUrl(url, base) {
  if (!url) return base;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Reject if `promise` doesn't settle within `ms` — a hard bound for operations
// (like Playwright's browser.close()) that can otherwise hang indefinitely.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Auto-detect the trading-card-game category from a URL, used to route alerts
// to a dedicated channel when configured. Path tokens win over query tokens, so
// `.../collections/one-piece-card-game?filter.vendor=Pokemon` reads as "one-piece".
function categoryOf(url) {
  if (!url) return null;
  let path = '';
  let query = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    query = u.search.toLowerCase();
  } catch {
    return null;
  }
  const matchPokemon = (s) => s.includes('pokemon') || s.includes('pokémon');
  const matchOnePiece = (s) =>
    s.includes('one-piece') ||
    s.includes('one_piece') ||
    s.includes('onepiece') ||
    s.includes('one+piece') ||
    s.includes('one%20piece');
  if (matchPokemon(path)) return 'pokemon';
  if (matchOnePiece(path)) return 'one-piece';
  if (matchPokemon(query)) return 'pokemon';
  if (matchOnePiece(query)) return 'one-piece';
  return null;
}

function createProductMonitor({ productRepo, alertRepo, notifiers, errorNotifier, httpClient, config, logger }) {
  const limit = createLimiter(config.concurrency || 15);
  const missingThreshold = config.removalThreshold || 3;

  // Pick the notifier for a target — by explicit `category` field on the target,
  // otherwise auto-detected from the URL. Falls back to `notifiers.default`.
  function pickNotifier(target) {
    const cat = target.category || categoryOf(target.url);
    return (cat && notifiers[cat]) ? notifiers[cat] : notifiers.default;
  }

  // Resolve Playwright once at creation time (optional dependency)
  let chromium = null;
  const hasDynamicTargets = config.targets.some((t) => t.dynamic);
  if (hasDynamicTargets) {
    try {
      chromium = require('playwright').chromium;
    } catch {
      logger.warn('Playwright not installed — dynamic targets will be skipped');
    }
  }

  // Parse the optional proxy URL into Playwright's proxy-config shape — used as
  // a fallback for dynamic targets that get blocked.
  let playwrightProxy = null;
  if (config.proxyUrl) {
    try {
      const u = new URL(config.proxyUrl);
      playwrightProxy = {
        server: `${u.protocol}//${u.host}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      logger.warn('Invalid proxy URL — Playwright dynamic targets will not use a proxy');
    }
  }

  // Render a page with Playwright, optionally through the proxy. Returns the
  // HTTP status (for block detection) and the rendered HTML.
  async function renderWithPlaywright(url, renderWait, useProxy) {
    const browser = await chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-http2',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
      timeout: 30000, // bound the launch itself
      ...(useProxy && playwrightProxy ? { proxy: playwrightProxy } : {}),
    });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
          'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
        },
      });
      // Default timeouts for the context — propagate to every page so any
      // unguarded action (waits, frame events, etc.) is also bounded.
      context.setDefaultTimeout(30000);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      // Deterministic render: the same wait strategy every cycle so the DOM
      // snapshot doesn't vary. `load` fires once and reliably; the fixed settle
      // lets client-side grids finish.
      const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(renderWait || 5000);
      return { status: response ? response.status() : null, html: await page.content() };
    } finally {
      // A wedged browser must not hang the cycle: give close() 10s, then
      // force-kill the process so the slot is always released.
      await withTimeout(browser.close(), 10000, 'browser.close').catch(() => {
        logger.warn(`browser.close() hung for ${url} — force-killing the browser process`);
        try {
          browser.process()?.kill('SIGKILL');
        } catch {
          /* process already gone */
        }
      });
    }
  }

  function extractProducts(html, target) {
    const mode = target.extractor || 'auto';

    if (mode === 'css') {
      return cssExtractor.extract(html, target.selectors, target.url, OOS_KEYWORDS);
    }
    if (mode === 'jsonld') {
      return jsonldExtractor.extract(html, target.url);
    }
    if (mode === 'heuristic') {
      return heuristicExtractor.extract(html, target.url);
    }

    // auto: try JSON-LD first, fall back to heuristic HTML extraction
    const jsonldProducts = jsonldExtractor.extract(html, target.url);
    if (jsonldProducts.length > 0) return jsonldProducts;

    return heuristicExtractor.extract(html, target.url);
  }

  async function processTarget(target) {
    let sent = 0;
    const errs = [];
    // Route product alerts to the category-specific channel when configured.
    const notifier = pickNotifier(target);
    // Prefix notification titles with the PT flag for Portuguese (.pt) domains
    // (auto-detected) and any host explicitly listed in data/ships-to-portugal.json.
    const titleFlag = shipsToPortugal(target.url) ? '🇵🇹 ' : '';

    try {
      let html;

      if (target.dynamic) {
        if (!chromium) {
          logger.warn(`Skipping dynamic target ${target.url} — Playwright unavailable`);
          return { sent, errs };
        }
        try {
          let result;
          try {
            result = await renderWithPlaywright(target.url, target.renderWait, false);
            // Blocked? Fall back to the proxy (fresh IP), like the HTTP client does.
            if (playwrightProxy && [403, 429, 503].includes(result.status)) {
              logger.warn(`HTTP ${result.status} from ${target.url} (Playwright) — retrying via proxy`);
              result = await renderWithPlaywright(target.url, target.renderWait, true);
            }
          } catch (err) {
            if (!playwrightProxy) throw err;
            logger.warn(`Playwright failed for ${target.url} (${err.message}) — retrying via proxy`);
            result = await renderWithPlaywright(target.url, target.renderWait, true);
          }
          html = result.html;
        } catch (err) {
          logger.error(`Playwright failed for ${target.url}`, { error: err.message });
          errs.push(`${target.url}: ${err.message}`);
          return { sent, errs };
        }
      } else {
        html = await httpClient.fetchHtml(target.url);
      }

      let products = await extractProducts(html, target);
      logger.info(`Extracted ${products.length} products from ${target.url}`);

      if (target.detailStock && products.length > 0) {
        products = await checkDetailPageStock(products, {
          baseUrl: target.url,
          httpClient,
          logger,
          concurrency: target.detailConcurrency || 3,
        });
      }

      // Explicit per-target currency override (e.g. a Swedish shop on a .com TLD
      // where auto-detection of `kr` can't distinguish SEK/DKK/NOK/ISK).
      // Applied last so it beats both extractor detection and JSON-LD details.
      if (target.currency && products.length > 0) {
        products = products.map((p) => ({ ...p, currency: target.currency }));
      }

      if (products.length === 0 && productRepo.countBySource(target.url) > 0) {
        logger.warn(`Zero products extracted from ${target.url} but ${productRepo.countBySource(target.url)} exist in DB — skipping update`);
        return { sent, errs };
      }

      const extractedIds = new Set(products.map((p) => p.productId));

      // First-run detection: if the store has no products in DB yet, this is an
      // initial seed — skip notifications to avoid flooding on new targets.
      const isFirstRun = productRepo.countBySource(target.url) === 0;

      for (const product of products) {
        const existing = productRepo.getProduct(product.sourceUrl, product.productId);
        const priceDisplay = formatPriceDisplay(product.price, product.currency, config.eurRates);

        // detailStock fetch failed for this *existing* product — we can't trust
        // the listing's stock default. Preserve the prior DB value and skip the
        // stock-change alert; metadata gets refreshed normally. New products
        // (no existing row) flow through the normal insert/notify path below,
        // because announcing a newly-discovered product matters more than the
        // exact stock reading on first sight.
        if (product.stockUnverified && existing) {
          if (!existing.removed) {
            productRepo.updateProduct({
              sourceUrl: product.sourceUrl,
              productId: product.productId,
              inStock: existing.in_stock,
              title: `${titleFlag}${product.title}`,
              price: product.price,
              currency: product.currency,
            });
          }
          continue;
        }

        if (!existing) {
          productRepo.insertProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            productUrl: product.productUrl,
            title: product.title,
            inStock: product.inStock,
            price: product.price,
            currency: product.currency,
          });

          if (!isFirstRun) {
            alertRepo.logAlert('new_product', {
              productId: product.productId,
              title: `${titleFlag}${product.title}`,
              url: product.productUrl,
              inStock: product.inStock === 1,
              price: product.price,
            });

            const absoluteProductUrl = resolveUrl(product.productUrl, product.sourceUrl);
            const bodyLines = [
              `Product: ${absoluteProductUrl}`,
              `Store: ${product.sourceUrl}`,
              `Status: ${product.inStock ? 'In Stock' : 'Out of Stock'}`,
              // Always show a Price line on new-product alerts — fall back to
              // "Unknown" when extraction didn't find one, so it's never absent.
              `Price: ${priceDisplay || 'Unknown'}`,
            ];

            const ok = await notifier.sendAlert({
              eventType: 'NEW_PRODUCT',
              title: `${titleFlag}🛒 New product added: ${product.title}`,
              body: bodyLines.join('\n'),
            });
            if (!ok) logger.warn(`Failed to send new product alert for ${product.productId}`);
            sent++;
          } else {
            logger.info(`Skipping notification for new product: ${product.title} (first run)`);
          }
        } else if (existing.removed) {
          // Product was previously removed and is back on the page
          productRepo.reactivateProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            inStock: product.inStock,
            title: product.title,
            price: product.price,
            currency: product.currency,
          });

          if (product.inStock) {
            const absoluteUrl = resolveUrl(product.productUrl, product.sourceUrl);
            const bodyLines = [
              `Status: Back in Stock`,
              `Product: ${absoluteUrl}`,
              `Store: ${product.sourceUrl}`,
            ];
            if (priceDisplay) bodyLines.push(`Price: ${priceDisplay}`);

            alertRepo.logAlert('stock_change', {
              productId: product.productId,
              title: `${titleFlag}${product.title}`,
              oldStatus: 'Removed',
              newStatus: 'In Stock',
            });

            const ok = await notifier.sendAlert({
              eventType: 'STOCK_CHANGE',
              title: `${titleFlag}${product.title}`,
              body: bodyLines.join('\n'),
            });
            if (!ok) logger.warn(`Failed to send restock alert for ${product.productId}`);
            sent++;
          }
        } else if (existing.in_stock !== product.inStock) {
          productRepo.updateProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            inStock: product.inStock,
            title: product.title,
            price: product.price,
            currency: product.currency,
          });

          const oldStatus = existing.in_stock ? 'In Stock' : 'Out of Stock';
          const newStatus = product.inStock ? 'In Stock' : 'Out of Stock';
          alertRepo.logAlert('stock_change', {
            productId: product.productId,
            title: product.title,
            oldStatus,
            newStatus,
          });

          // Only notify when product comes back in stock (not when it goes out of stock)
          if (product.inStock) {
            const absoluteChangeUrl = resolveUrl(product.productUrl, product.sourceUrl);
            const bodyLines = [
              `Status: ${oldStatus} -> ${newStatus}`,
              `Product: ${absoluteChangeUrl}`,
              `Store: ${product.sourceUrl}`,
            ];
            if (priceDisplay) bodyLines.push(`Price: ${priceDisplay}`);

            const ok = await notifier.sendAlert({
              eventType: 'STOCK_CHANGE',
              title: `${titleFlag}${product.title}`,
              body: bodyLines.join('\n'),
            });
            if (!ok) logger.warn(`Failed to send stock change alert for ${product.productId}`);
            sent++;
          }
        } else {
          productRepo.updateProduct({
            sourceUrl: product.sourceUrl,
            productId: product.productId,
            inStock: product.inStock,
            title: product.title,
            price: product.price,
            currency: product.currency,
          });
        }
      }

      // Detect products absent from this cycle. Removal uses hysteresis: a
      // product is only marked removed after it's been missing for
      // `missingThreshold` consecutive cycles, so a single flaky scrape doesn't
      // churn products in/out of the DB (which fired spurious restock alerts).
      const existingProducts = productRepo.getProductsBySource(target.url);
      const missingProducts = existingProducts.filter((p) => !extractedIds.has(p.product_id));

      const newlyRemoved = [];
      for (const p of missingProducts) {
        productRepo.markMissing(target.url, p.product_id, missingThreshold);
        // p.missing_count is the pre-increment value read at the top of the cycle.
        if ((p.missing_count || 0) + 1 >= missingThreshold) newlyRemoved.push(p);
      }

      if (newlyRemoved.length > 0) {
        alertRepo.logAlert('products_removed', {
          sourceUrl: target.url,
          count: newlyRemoved.length,
          products: newlyRemoved.map((p) => ({ productId: p.product_id, title: p.title })),
        });
        logger.info(`${newlyRemoved.length} product(s) marked as removed from ${target.url} (missing ${missingThreshold}+ cycles)`);
      }

      const stillPending = missingProducts.length - newlyRemoved.length;
      if (stillPending > 0) {
        logger.info(`${stillPending} product(s) absent from ${target.url} this cycle — below removal threshold`);
      }
    } catch (err) {
      logger.error(`Failed to process ${target.url}`, { error: err.message });
      errs.push(`${target.url}: ${err.message}`);
    }

    return { sent, errs };
  }

  return {
    name: 'product-monitor',

    async run() {
      const startTime = Date.now();

      // Hard per-target cap: no single target can stall the cycle past
      // `targetTimeoutMs`, regardless of which sub-operation hangs. The per-
      // operation timeouts are the primary bound — this is the safety net.
      const perTargetMs = config.targetTimeoutMs || 180000;
      const results = await Promise.all(
        config.targets.map((target) =>
          limit(() =>
            withTimeout(processTarget(target), perTargetMs, `processTarget(${target.url})`).catch((err) => {
              logger.error(`processTarget exceeded its budget`, { url: target.url, error: err.message });
              return { sent: 0, errs: [`${target.url}: ${err.message}`] };
            })
          )
        )
      );

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

      let alertsSent = 0;
      const errors = [];
      for (const { sent, errs } of results) {
        alertsSent += sent;
        errors.push(...errs);
      }

      const successCount = config.targets.length - errors.length;
      const failCount = errors.length;

      const summaryLines = [
        `Successful: ${successCount}/${config.targets.length}`,
        `Failed: ${failCount}/${config.targets.length}`,
        `Alerts sent: ${alertsSent}`,
        `Duration: ${durationSec}s`,
      ];

      if (failCount > 0) {
        const grouped = {};
        for (const e of errors) {
          const sep = e.indexOf(': ');
          const url = sep > -1 ? e.slice(0, sep) : e;
          const msg = sep > -1 ? e.slice(sep + 2) : 'Unknown error';
          // Strip embedded URLs from error message to group by error type
          // e.g. "HTTP 403 from https://example.com" → "HTTP 403"
          const cleanMsg = msg.replace(/\s+from\s+https?:\/\/\S+/, '').replace(/:\s*$/, '').trim();
          let siteName;
          try {
            siteName = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
          } catch {
            siteName = url;
          }
          if (!grouped[cleanMsg]) grouped[cleanMsg] = [];
          grouped[cleanMsg].push(siteName);
        }
        const errorLines = Object.entries(grouped).map(([msg, sites]) =>
          `${msg} → ${sites.length} occurrence${sites.length > 1 ? 's' : ''} (${sites.join(', ')})`
        );
        summaryLines.push(`\nErrors:\n${errorLines.join('\n')}`);
      }

      await errorNotifier.sendAlert({
        eventType: failCount > 0 ? 'ERROR' : 'CYCLE_SUMMARY',
        title: failCount > 0
          ? `⚠️ Cycle summary: ${successCount} OK / ${failCount} failed`
          : `✅ Cycle complete: ${successCount}/${config.targets.length} OK`,
        body: summaryLines.join('\n'),
      });

      logger.info(`Cycle complete: ${successCount} OK, ${failCount} failed, ${alertsSent} alerts in ${durationSec}s`);

      return { alertsSent, errors };
    },
  };
}

module.exports = { createProductMonitor };
