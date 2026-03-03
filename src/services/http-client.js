function createHttpClient({ logger, timeout = 15000 } = {}) {
  async function request(url, options = {}) {
    const { headers: optHeaders, ...restOptions } = options;
    const mergedHeaders = {
      'User-Agent': 'MonitoringSystem/1.0',
      ...optHeaders,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const fetchOptions = {
      ...restOptions,
      signal: controller.signal,
      headers: mergedHeaders,
    };

    try {
      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeout}ms`);
      }

      // Retry once on network errors
      logger.warn(`Request to ${url} failed, retrying...`, { error: err.message });
      await new Promise((r) => setTimeout(r, 2000));

      const retryResponse = await fetch(url, {
        ...restOptions,
        headers: mergedHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      return retryResponse;
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
