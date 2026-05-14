function createHttpClient({ logger, timeout = 15000 } = {}) {
  // Single fetch attempt with a timeout. Wraps timeouts in a friendly,
  // identifiable error so callers (and the retry logic) handle them consistently.
  async function attempt(url, fetchOptions) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...fetchOptions, signal: controller.signal });
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

    try {
      return await attempt(url, fetchOptions);
    } catch (err) {
      // Timeouts are already wrapped and aren't worth retrying.
      if (err.isTimeout) throw err;

      // Retry once on network errors — the retry runs through attempt() too,
      // so a timeout on the second try is wrapped the same way.
      logger.warn(`Request to ${url} failed, retrying...`, { error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
      return attempt(url, fetchOptions);
    }
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
