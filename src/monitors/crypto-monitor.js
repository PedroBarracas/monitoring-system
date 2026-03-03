function createCryptoMonitor({ cryptoRepo, alertRepo, notifier, coingecko, config, logger }) {
  return {
    name: 'crypto-monitor',

    async run() {
      let alertsSent = 0;
      const errors = [];

      let prices;
      try {
        prices = await coingecko.getSimplePrices(config.coins);
      } catch (err) {
        logger.error('Failed to fetch crypto prices', { error: err.message });
        errors.push(err.message);
        return { alertsSent, errors };
      }

      if (prices === null) {
        logger.info('Skipping cycle (rate limited)');
        return { alertsSent, errors };
      }

      for (const coinId of config.coins) {
        const priceData = prices[coinId];
        if (!priceData || priceData.usd === undefined) {
          logger.warn(`No price data for ${coinId}`);
          continue;
        }

        const newPrice = priceData.usd;
        const existing = cryptoRepo.getPrice(coinId);

        if (!existing) {
          // First time tracking this coin — use coinId as symbol since
          // the simple/price endpoint doesn't return ticker symbols
          cryptoRepo.upsertPrice(coinId, coinId, newPrice);

          alertRepo.logAlert('crypto_first_track', {
            coinId,
            price: newPrice,
            event: 'first_tracking',
          });

          const sent = await notifier.sendAlert({
            eventType: 'CRYPTO_TRACKING',
            title: `Now tracking ${coinId}`,
            body: `Initial price: $${newPrice.toLocaleString()}`,
          });
          if (!sent) logger.warn(`Failed to send tracking alert for ${coinId}`);
          alertsSent++;
          logger.info(`Started tracking ${coinId} at $${newPrice}`);
        } else {
          const oldPrice = existing.price_usd;
          if (oldPrice === 0) {
            cryptoRepo.upsertPrice(coinId, existing.symbol, newPrice);
            continue;
          }
          const percentChange =
            Math.abs((newPrice - oldPrice) / oldPrice) * 100;
          const direction = newPrice > oldPrice ? 'increased' : 'decreased';

          if (percentChange >= config.thresholdPercent) {
            alertRepo.logAlert('crypto_price_change', {
              coinId,
              oldPrice,
              newPrice,
              percentChange: percentChange.toFixed(2),
              direction,
            });

            const sent = await notifier.sendAlert({
              eventType: 'PRICE_CHANGE',
              title: `${coinId} price ${direction}`,
              body: [
                `Old: $${oldPrice.toLocaleString()}`,
                `New: $${newPrice.toLocaleString()}`,
                `Change: ${direction === 'increased' ? '+' : '-'}${percentChange.toFixed(2)}%`,
              ].join('\n'),
            });
            if (!sent) logger.warn(`Failed to send price alert for ${coinId}`);
            alertsSent++;
            logger.info(
              `${coinId} price ${direction} by ${percentChange.toFixed(2)}% ($${oldPrice} -> $${newPrice})`
            );
          }

          // Always update the stored price
          cryptoRepo.upsertPrice(coinId, existing.symbol, newPrice);
        }
      }

      return { alertsSent, errors };
    },
  };
}

module.exports = { createCryptoMonitor };
