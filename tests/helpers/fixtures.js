const COINGECKO_RESPONSE = {
  bitcoin: { usd: 50000, usd_24h_change: 2.5 },
  ethereum: { usd: 3000, usd_24h_change: -1.2 },
  solana: { usd: 100, usd_24h_change: 5.0 },
};

const PRODUCT_HTML = `
<html>
<body>
  <div class="product-card" data-product-id="prod-001">
    <h3 class="product-title">Widget Alpha</h3>
    <span class="stock-label">In Stock</span>
    <a href="https://shop.example.com/products/prod-001">View</a>
  </div>
  <div class="product-card" data-product-id="prod-002">
    <h3 class="product-title">Widget Beta</h3>
    <span class="stock-label">Out of Stock</span>
    <a href="https://shop.example.com/products/prod-002">View</a>
  </div>
  <div class="product-card" data-product-id="prod-003">
    <h3 class="product-title">Widget Gamma</h3>
    <span class="stock-label">In Stock</span>
    <a href="https://shop.example.com/products/prod-003">View</a>
  </div>
</body>
</html>
`;

const PRODUCT_HTML_WITH_NEW_ITEM = `
<html>
<body>
  <div class="product-card" data-product-id="prod-001">
    <h3 class="product-title">Widget Alpha</h3>
    <span class="stock-label">In Stock</span>
    <a href="https://shop.example.com/products/prod-001">View</a>
  </div>
  <div class="product-card" data-product-id="prod-002">
    <h3 class="product-title">Widget Beta</h3>
    <span class="stock-label">In Stock</span>
    <a href="https://shop.example.com/products/prod-002">View</a>
  </div>
  <div class="product-card" data-product-id="prod-003">
    <h3 class="product-title">Widget Gamma</h3>
    <span class="stock-label">In Stock</span>
    <a href="https://shop.example.com/products/prod-003">View</a>
  </div>
  <div class="product-card" data-product-id="prod-004">
    <h3 class="product-title">Widget Delta</h3>
    <span class="stock-label">In Stock</span>
    <a href="https://shop.example.com/products/prod-004">View</a>
  </div>
</body>
</html>
`;

const NEWS_HTML = `
<html>
<body>
  <article data-article-id="news-001">
    <h2><a href="https://news.example.com/articles/news-001">Breaking: Major Update Released</a></h2>
  </article>
  <article data-article-id="news-002">
    <h2><a href="https://news.example.com/articles/news-002">Market Analysis: Q1 Trends</a></h2>
  </article>
</body>
</html>
`;

const NEWS_HTML_WITH_NEW_ARTICLE = `
<html>
<body>
  <article data-article-id="news-001">
    <h2><a href="https://news.example.com/articles/news-001">Breaking: Major Update Released</a></h2>
  </article>
  <article data-article-id="news-002">
    <h2><a href="https://news.example.com/articles/news-002">Market Analysis: Q1 Trends</a></h2>
  </article>
  <article data-article-id="news-003">
    <h2><a href="https://news.example.com/articles/news-003">New Partnership Announced</a></h2>
  </article>
</body>
</html>
`;

const TELEGRAM_SUCCESS_RESPONSE = { ok: true, result: { message_id: 123 } };

const DEFAULT_PRODUCT_SELECTORS = {
  container: '.product-card',
  title: '.product-title',
  productId: 'data-product-id',
  stockStatus: '.stock-label',
  link: 'a',
};

const DEFAULT_NEWS_SELECTORS = {
  container: 'article',
  title: 'h2 a',
  link: 'h2 a',
  articleId: 'data-article-id',
};

module.exports = {
  COINGECKO_RESPONSE,
  PRODUCT_HTML,
  PRODUCT_HTML_WITH_NEW_ITEM,
  NEWS_HTML,
  NEWS_HTML_WITH_NEW_ARTICLE,
  TELEGRAM_SUCCESS_RESPONSE,
  DEFAULT_PRODUCT_SELECTORS,
  DEFAULT_NEWS_SELECTORS,
};
