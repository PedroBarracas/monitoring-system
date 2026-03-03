function createCoinGeckoService({ httpClient, apiKey, logger }) {
  const baseUrl = 'https://api.coingecko.com/api/v3';

  async function getSimplePrices(coinIds, vsCurrencies = ['usd']) {
    if (!coinIds || coinIds.length === 0) return {};

    const params = new URLSearchParams({
      ids: coinIds.join(','),
      vs_currencies: vsCurrencies.join(','),
      include_24hr_change: 'true',
    });

    const url = `${baseUrl}/simple/price?${params}`;
    const headers = {};
    if (apiKey) {
      headers['x-cg-demo-api-key'] = apiKey;
    }

    try {
      const data = await httpClient.fetchJson(url, { headers });
      logger.info(`Fetched prices for ${coinIds.length} coins`);
      return data;
    } catch (err) {
      if (err.message && err.message.includes('429')) {
        logger.warn('CoinGecko rate limited, skipping this cycle');
        return null;
      }
      throw err;
    }
  }

  return { getSimplePrices };
}

module.exports = { createCoinGeckoService };
