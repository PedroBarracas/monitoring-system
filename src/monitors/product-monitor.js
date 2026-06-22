const crypto = require('crypto');
const cssExtractor = require('../extractors/css-extractor');
const jsonldExtractor = require('../extractors/jsonld-extractor');
const heuristicExtractor = require('../extractors/heuristic-extractor');
const { createLimiter } = require('../utils/concurrency');
const OOS_KEYWORDS = require('../utils/oos-keywords');
const { checkDetailPageStock } = require('../utils/detail-stock-checker');
const { formatPriceDisplay } = require('../utils/price');
const { shipsToPortugal } = require('../utils/ships-to-portugal');

// Canonical hash of an extracted product list. Hashing the *extracted* data
// instead of the raw HTML avoids false positives from cosmetic noise (CSRF
// tokens, dynamic ads, build hashes). Captures product membership, stock, and
// price — the things we care about for "did this page meaningfully change".
function hashProductList(products) {
  const canonical = products
    .map((p) => `${p.productId}|${p.inStock}|${p.price || ''}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

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

// HTTP-cache TTL: force a full GET at least every CACHE_TTL_MS regardless of
// stored validators. Bounds how long a stale 304 (from a misbehaving CDN or
// origin) can lie to us. 1 hour pairs well with a 10-min cron — worst-case
// staleness is ~6 cycles before we re-extract.
const CACHE_TTL_MS = 60 * 60 * 1000;

function createProductMonitor({ productRepo, alertRepo, sourceCacheRepo, notifiers, errorNotifier, httpClient, config, logger }) {
  const limit = createLimiter(config.concurrency || 15);
  // Cap on concurrent Chromium launches. Each render launches its own browser
  // (no persistent state), and the deployed Linux VM throws `spawn EAGAIN`
  // when several launch in parallel. Default 1 = serialized.
  const playwrightLimit = createLimiter(config.playwrightConcurrency || 1);
  const missingThreshold = config.removalThreshold || 3;
  // Per-operation budget: applied INLINE around each network op (fetchHtml,
  // renderWithPlaywright). Timer ticks against actual work, not queue wait
  // behind playwrightLimit. The outer-loop withTimeout is a wider safety net
  // sized to also cover the deterministic queue wait — see `run()`.
  const perOpMs = config.targetTimeoutMs || 180000;
  // Title-substring blocklist (lowercased once at startup). Products whose
  // title contains any of these are dropped after extraction so they never
  // get inserted or alerted on.
  const excludeKeywords = (config.excludeTitleKeywords || []).map((k) => String(k).toLowerCase());

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

  // Render a page with Playwright, optionally through the proxy. Per-cycle
  // launch (Chromium is created and torn down each render), no persistent
  // state.
  //
  // The combination that avoids Playwright's driver corruption:
  //
  // 1. Proxy is configured AT LAUNCH TIME, only when `useProxy` is true. No
  //    per-context placeholder ("per-context") — that silently routed direct
  //    traffic through the real proxy and burned bandwidth on every direct
  //    fetch.
  //
  // 2. Graceful cleanup sequence in `finally`: page → context → browser.
  //    Closing the inner handles first lets `browser.close()` finish quickly
  //    because no in-flight operations remain. This eliminates the hang that
  //    used to trigger the SIGKILL fallback.
  //
  // 3. If `browser.close()` does hang, we send SIGTERM (cooperative) instead
  //    of SIGKILL. Chromium handles SIGTERM by exiting cleanly, which lets
  //    Playwright's IPC pipe tear down properly. SIGKILL corrupted the
  //    driver's bookkeeping and made every subsequent `chromium.launch()`
  //    fail with "Target page, context or browser has been closed" until the
  //    Node process restarted.
  async function renderWithPlaywright(url, renderWait, useProxy, deadlineMs) {
    let browser;
    let context;
    let page;
    let deadlineTimer;
    let timedOut = false;

    if (deadlineMs) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        if (browser) {
          // Force-close to interrupt the in-flight page action; the finally
          // block will run the full graceful cleanup. Playwright's close is
          // idempotent so the second call from finally is a no-op.
          browser.close().catch(() => {});
        }
      }, deadlineMs);
    }

    try {
      browser = await chromium.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-http2',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
        ],
        timeout: 30000,
        ...(useProxy && playwrightProxy ? { proxy: playwrightProxy } : {}),
      });
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
          'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not-A.Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
        },
      });
      context.setDefaultTimeout(30000);
      context.setDefaultNavigationTimeout(30000);
      page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(renderWait || 5000);
      return { status: response ? response.status() : null, html: await page.content() };
    } catch (err) {
      if (timedOut) {
        throw new Error(`renderWithPlaywright(${url}) timed out after ${deadlineMs}ms`);
      }
      throw err;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // Inside-out close: empties the browser of pending work before asking
      // it to shut down, so browser.close() rarely hangs.
      if (page) {
        await withTimeout(page.close(), 3000, 'page.close').catch(() => {});
      }
      if (context) {
        await withTimeout(context.close(), 3000, 'context.close').catch(() => {});
      }
      if (browser) {
        await withTimeout(browser.close(), 10000, 'browser.close').catch(() => {
          logger.warn(`browser.close() hung for ${url} — sending SIGTERM`);
          // SIGTERM, NOT SIGKILL: SIGTERM lets Chromium and Playwright's
          // driver pipe close cleanly. SIGKILL is the trigger for the
          // driver-corruption failure mode.
          try { browser.process()?.kill('SIGTERM'); } catch { /* already gone */ }
        });
      }
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
      // Set by the conditional-GET branch when the server returned 200. We
      // defer the source_cache upsert (and the lie-detection hash comparison)
      // until after extraction, when we have the canonical product list to
      // hash.
      let pendingFullFetchUpdate = null;

      if (target.dynamic) {
        if (!chromium) {
          logger.warn(`Skipping dynamic target ${target.url} — Playwright unavailable`);
          return { sent, errs };
        }
        try {
          let result;
          // Funnel all Playwright work through playwrightLimit — every
          // chromium.launch() call (initial attempt + proxy retry) counts as
          // one slot, so launches are serialized when playwrightConcurrency=1.
          // `perOpMs` is the per-operation budget: applied INSIDE the closure
          // so the timer only ticks against actual work, not queue wait.
          try {
            result = await playwrightLimit(() =>
              renderWithPlaywright(target.url, target.renderWait, false, perOpMs)
            );
            // Blocked? Fall back to the proxy (fresh IP), like the HTTP client does.
            if (playwrightProxy && [403, 429, 503].includes(result.status)) {
              logger.warn(`HTTP ${result.status} from ${target.url} (Playwright) — retrying via proxy`);
              result = await playwrightLimit(() =>
                renderWithPlaywright(target.url, target.renderWait, true, perOpMs)
              );
            }
          } catch (err) {
            if (!playwrightProxy) throw err;
            logger.warn(`Playwright failed for ${target.url} (${err.message}) — retrying via proxy`);
            result = await playwrightLimit(() =>
              renderWithPlaywright(target.url, target.renderWait, true, perOpMs)
            );
          }
          html = result.html;
        } catch (err) {
          logger.error(`Playwright failed for ${target.url}`, { error: err.message });
          errs.push(`${target.url}: ${err.message}`);
          return { sent, errs };
        }
      } else if (sourceCacheRepo && typeof httpClient.fetchHtmlConditional === 'function') {
        // Conditional GET: send the stored ETag / Last-Modified so the server
        // can answer 304 Not Modified (near-zero bytes) instead of re-sending
        // the same body. Skips the proxy bandwidth entirely on unchanged pages.
        //
        // Falls back to an unconditional GET when:
        //   - no validators stored yet (first cycle on this target)
        //   - last full fetch is older than CACHE_TTL_MS (TTL safety net
        //     against a misbehaving CDN that keeps serving phantom 304s)
        //   - source has been caught lying (conditional_disabled flag)
        const cached = sourceCacheRepo.get(target.url);
        const ttlExpired = !cached || (Date.now() - new Date(cached.last_full_fetch_at + 'Z').getTime()) > CACHE_TTL_MS;
        const useConditional =
          cached &&
          (cached.etag || cached.last_modified) &&
          !ttlExpired &&
          !cached.conditional_disabled;

        const validators = useConditional
          ? { etag: cached.etag, lastModified: cached.last_modified }
          : {};
        const result = await withTimeout(
          httpClient.fetchHtmlConditional(target.url, validators),
          perOpMs,
          `fetchHtmlConditional(${target.url})`
        );

        if (result.status === 304) {
          // Unchanged. Refresh validators (server may have rotated them while
          // serving the same body) and mark had_304_since_last so the next
          // full GET can run the lie-detection comparison. Skipping extraction
          // here is equivalent to "every previously-seen product is still
          // present" — removal hysteresis only fires when products are ABSENT
          // from a fresh extraction.
          sourceCacheRepo.refreshValidators(target.url, result.etag, result.lastModified);
          logger.info(`304 Not Modified for ${target.url} — skipping extraction`);
          return { sent, errs };
        }
        html = result.html;
        // Defer the upsertFullFetch + lie-detection until after extraction —
        // we need the extracted product list to compute the content hash.
        // See the post-extraction block below.
        pendingFullFetchUpdate = { cached, result };
      } else {
        // Fallback: plain fetchHtml. Used by tests and any wiring that
        // didn't supply a sourceCacheRepo.
        html = await withTimeout(
          httpClient.fetchHtml(target.url),
          perOpMs,
          `fetchHtml(${target.url})`
        );
      }

      let products = await extractProducts(html, target);
      logger.info(`Extracted ${products.length} products from ${target.url}`);

      // Title-keyword filter (sleeves / playmats / starter decks by default).
      // Applied BEFORE detailStock to avoid spending extra HTTP calls on
      // products we're going to drop anyway. Pre-existing DB rows whose title
      // now matches the filter drain quietly via removal hysteresis —
      // products_removed only writes to the alert_log, no Discord alert.
      if (excludeKeywords.length > 0 && products.length > 0) {
        const before = products.length;
        products = products.filter((p) => {
          const t = (p.title || '').toLowerCase();
          return !excludeKeywords.some((kw) => t.includes(kw));
        });
        const dropped = before - products.length;
        if (dropped > 0) {
          logger.info(`Filtered ${dropped} product(s) by title keywords from ${target.url}`);
        }
      }

      // Lie-detection + source_cache upsert for the conditional-GET 200 path.
      // We do this after the keyword filter so the hash reflects the
      // "interesting" product set, not noise like sleeves.
      if (pendingFullFetchUpdate) {
        const { cached, result } = pendingFullFetchUpdate;
        const newHash = hashProductList(products);
        // Was there a 304 since the last full GET? If so, and the content
        // actually changed, the server lied about "Not Modified" during the
        // TTL window — disable conditional GETs for this source from now on.
        if (cached && cached.had_304_since_last && cached.content_hash && cached.content_hash !== newHash) {
          logger.warn(
            `Lying 304 detected for ${target.url} — content changed during a "Not Modified" window. ` +
            `Disabling conditional GETs for this source.`
          );
          sourceCacheRepo.disableConditional(target.url);
        }
        sourceCacheRepo.upsertFullFetch(target.url, result.etag, result.lastModified, newHash);
      }

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

      // Per-target safety net. Per-operation budgets (`perOpMs`) are applied
      // inline inside processTarget, so the timer there ticks only against
      // actual work. THIS outer cap is wider — it has to account for the
      // deterministic queue wait dynamic targets spend behind playwrightLimit
      // (otherwise queue position alone trips the cap, regardless of whether
      // anything actually hung). For dynamic targets, budget =
      // (queueDepth + 1) × perOpMs; for static, perOpMs is fine since there
      // is no queue.
      const dynamicCount = config.targets.filter((t) => t.dynamic).length;
      const pwConc = config.playwrightConcurrency || 1;
      const queueRounds = Math.ceil(dynamicCount / pwConc);
      const dynamicOuterMs = perOpMs * (queueRounds + 1);
      const budgetFor = (target) => (target.dynamic ? dynamicOuterMs : perOpMs);

      const results = await Promise.all(
        config.targets.map((target) =>
          limit(() =>
            withTimeout(processTarget(target), budgetFor(target), `processTarget(${target.url})`).catch((err) => {
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
          // Collapse multi-line errors (e.g. Playwright's "page.goto ... Call log:\n- navigating to ...")
          // to their first line, strip embedded URLs, and truncate. Discord embeds cap at 25 fields /
          // 6000 chars total, and the field-parser splits on \n — so unbounded multi-line errors
          // produce too many fields and the webhook returns HTTP 400.
          const firstLine = msg.split('\n')[0].trim();
          const cleanMsg = firstLine
            .replace(/\s+from\s+https?:\/\/\S+/, '')
            .replace(/:\s*$/, '')
            .trim()
            .slice(0, 200);
          let siteName;
          try {
            siteName = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
          } catch {
            siteName = url;
          }
          if (!grouped[cleanMsg]) grouped[cleanMsg] = [];
          grouped[cleanMsg].push(siteName);
        }
        const MAX_ERROR_GROUPS = 15;
        const entries = Object.entries(grouped);
        const visible = entries.slice(0, MAX_ERROR_GROUPS);
        const errorLines = visible.map(([msg, sites]) =>
          `${msg} → ${sites.length} occurrence${sites.length > 1 ? 's' : ''} (${sites.slice(0, 10).join(', ')}${sites.length > 10 ? `, +${sites.length - 10} more` : ''})`
        );
        if (entries.length > MAX_ERROR_GROUPS) {
          errorLines.push(`… and ${entries.length - MAX_ERROR_GROUPS} more error type(s) omitted`);
        }
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
