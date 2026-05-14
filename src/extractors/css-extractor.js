const cheerio = require('cheerio');
const { parsePrice, detectCurrency } = require('../utils/price');

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function extract(html, selectors, sourceUrl, outOfStockKeywords = []) {
  const $ = cheerio.load(html);
  const products = [];

  $(selectors.container).each((_i, el) => {
    const title = $(el).find(selectors.title).text().trim();
    if (!title) return;

    const productId = $(el).attr(selectors.productId) || slugify(title);
    const productUrl = $(el).find(selectors.link).attr('href') || '';
    const stockText = $(el).find(selectors.stockStatus).text().trim().toLowerCase();

    let inStock = 1;
    for (const keyword of outOfStockKeywords) {
      if (stockText.includes(keyword.toLowerCase())) {
        inStock = 0;
        break;
      }
    }

    const priceText = selectors.price ? $(el).find(selectors.price).text().trim() : '';
    const price = parsePrice(priceText);
    const currency = detectCurrency(priceText, sourceUrl);

    products.push({ productId, productUrl, title, inStock, price, currency, sourceUrl });
  });

  return products;
}

module.exports = { extract, slugify };
