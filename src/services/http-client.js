// Use undici's own fetch (not Node's built-in) so it pairs with undici's
// ProxyAgent — passing a dispatcher from the standalone undici package to the
// global fetch fails with a version-mismatch ("invalid onRequestStart method").
const undici = require('undici');
const { ProxyAgent } = undici;

// Statuses where a direct request was likely rate-limited or bot-blocked —
// worth retrying through the proxy, which rotates IP per connection.
const PROXY_RETRY_STATUSES = new Set([403, 429, 503]);
const MAX_PROXY_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

// Build an undici dispatcher for a proxy URL, handling embedded credentials
// (http://user:pass@host:port).
function buildProxyDispatcher(proxyUrl) {
  const u = new URL(proxyUrl);
  const opts = { uri: `${u.protocol}//${u.host}` };
  if (u.username || u.password) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    opts.token = `Basic ${Buffer.from(creds).toString('base64')}`;
  }
  return new ProxyAgent(opts);
}

function createHttpClient({ logger, timeout = 15000, proxyUrl = '' } = {}) {
  let proxyDispatcher = null;
  if (proxyUrl) {
    try {
      proxyDispatcher = buildProxyDispatcher(proxyUrl);
      logger.info('HTTP client: proxy fallback enabled for blocked/failed requests');
    } catch (err) {
      logger.warn(`HTTP client: invalid PROXY_URL, proxy disabled — ${err.message}`);
    }
  }

  // Single fetch attempt with a timeout. Wraps timeouts in a friendly,
  // identifiable error so callers (and the retry logic) handle them consistently.
  // When `dispatcher` is given the request goes through the proxy.
  async function attempt(url, fetchOptions, dispatcher) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const opts = { ...fetchOptions, signal: controller.signal };
      if (dispatcher) opts.dispatcher = dispatcher;
      return await undici.fetch(url, opts);
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(`Request to ${url} timed out after ${timeout}ms`);
        timeoutErr.isTimeout = true;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(url, options = {}) {
    const { headers: optHeaders, ...restOptions } = options;
    const fetchOptions = {
      ...restOptions,
      headers: {
        'User-Agent': 'MonitoringSystem/1.0',
        ...optHeaders,
      },
    };

    // First try: direct connection.
    let blockedResponse = null;
    try {
      const response = await attempt(url, fetchOptions);
      if (!proxyDispatcher || !PROXY_RETRY_STATUSES.has(response.status)) {
        return response;
      }
      // Rate-limited / blocked and a proxy is available — fall back to it.
      blockedResponse = response;
      logger.warn(`HTTP ${response.status} from ${url} — retrying via proxy`);
    } catch (err) {
      if (err.isTimeout) throw err;
      logger.warn(`Request to ${url} failed (${err.message}) — retrying${proxyDispatcher ? ' via proxy' : ''}`);
    }

    // Retries: through the proxy when configured (a fresh IP each attempt),
    // otherwise a single plain retry — matching the previous behaviour.
    const maxRetries = proxyDispatcher ? MAX_PROXY_RETRIES : 1;
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        const response = await attempt(url, fetchOptions, proxyDispatcher || undefined);
        if (!proxyDispatcher || !PROXY_RETRY_STATUSES.has(response.status)) {
          return response;
        }
        blockedResponse = response; // still blocked through the proxy — keep trying
      } catch (err) {
        if (err.isTimeout) throw err;
        lastError = err;
      }
    }

    // Retries exhausted — surface the blocked response so the caller throws the
    // real HTTP status, or rethrow the last network error.
    if (blockedResponse) return blockedResponse;
    throw lastError || new Error(`Request to ${url} failed`);
  }

  return {
    async fetchJson(url, options = {}) {
      const response = await request(url, options);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
      }
      return response.json();
    },

    async fetchHtml(url, options = {}) {
      const response = await request(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      return response.text();
    },
  };
}

module.exports = { createHttpClient };
