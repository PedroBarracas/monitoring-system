const { extract } = require('../../../src/extractors/heuristic-extractor');

describe('heuristic-extractor', () => {
  const sourceUrl = 'https://shop.example.com/collection';

  describe('Shopify patterns', () => {
    test('extracts from .product-card containers', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3 class="card__heading"><a href="/products/widget-alpha">Widget Alpha</a></h3>
          <span class="price">€29.99</span>
        </div>
        <div class="product-card">
          <h3 class="card__heading"><a href="/products/widget-beta">Widget Beta</a></h3>
          <span class="price">€19.99</span>
          <span class="sold-out-badge">Sold out</span>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(2);
      expect(products[0]).toEqual({
        productId: 'widget-alpha',
        productUrl: '/products/widget-alpha',
        title: 'Widget Alpha',
        inStock: 1,
        price: '29.99',
        currency: 'EUR',
        sourceUrl,
      });
      expect(products[1].inStock).toBe(0);
      expect(products[1].productId).toBe('widget-beta');
    });

    test('extracts from .product-grid-item containers', () => {
      const html = `<html><body>
        <div class="product-grid-item">
          <h3><a href="/products/booster-box-op15">Booster Box OP15</a></h3>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(1);
      expect(products[0].productId).toBe('booster-box-op15');
    });

    test('detects sold-out from class name', () => {
      const html = `<html><body>
        <div class="product-card sold-out">
          <h3><a href="/products/sold-item">Sold Item</a></h3>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].inStock).toBe(0);
    });
  });

  describe('WooCommerce patterns', () => {
    test('extracts from li.product containers', () => {
      const html = `<html><body>
        <ul class="products">
          <li class="product type-product">
            <h2 class="woocommerce-loop-product__title">Display OP14</h2>
            <a href="https://shop.example.com/product/display-op14/">View</a>
            <span class="price">€85.00</span>
          </li>
          <li class="product type-product outofstock">
            <h2 class="woocommerce-loop-product__title">Starter Deck ST-18</h2>
            <a href="https://shop.example.com/product/starter-deck-st18/">View</a>
          </li>
        </ul>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(2);
      expect(products[0]).toEqual({
        productId: 'display-op14',
        productUrl: 'https://shop.example.com/product/display-op14/',
        title: 'Display OP14',
        inStock: 1,
        price: '85.00',
        currency: 'EUR',
        sourceUrl,
      });
      expect(products[1].inStock).toBe(0);
    });

    test('detects outofstock class', () => {
      const html = `<html><body>
        <li class="product outofstock">
          <h2 class="woocommerce-loop-product__title">Gone Item</h2>
          <a href="/product/gone/">View</a>
        </li>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].inStock).toBe(0);
    });
  });

  describe('PrestaShop patterns', () => {
    test('extracts from .product-miniature containers', () => {
      const html = `<html><body>
        <div class="product-miniature">
          <h3 class="product-title"><a href="/en/card-games/123-booster-op14.html">Booster OP14</a></h3>
          <span class="price">€4.50</span>
        </div>
        <div class="product-miniature">
          <h3 class="product-title"><a href="/en/card-games/124-booster-op15.html">Booster OP15</a></h3>
          <span class="product-unavailable">Agotado</span>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(2);
      expect(products[0].productId).toBe('123-booster-op14');
      expect(products[0].inStock).toBe(1);
      expect(products[1].inStock).toBe(0);
    });
  });

  describe('generic patterns', () => {
    test('extracts from [class*="product-card"] containers', () => {
      const html = `<html><body>
        <div class="my-product-card-wrapper">
          <h3><a href="/products/generic-item">Generic Item</a></h3>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(1);
      expect(products[0].title).toBe('Generic Item');
    });

    test('extracts from [data-product-id] containers', () => {
      const html = `<html><body>
        <div data-product-id="abc-123">
          <h2><a href="/items/cool-thing">Cool Thing</a></h2>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(1);
      expect(products[0].title).toBe('Cool Thing');
    });

    test('falls back to slugified title when no product URL pattern', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/some/random/path">My Cool Product</a></h3>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].productId).toBe('my-cool-product');
    });
  });

  describe('price extraction', () => {
    test('reads the sale price, not the struck-through original', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/sale-item">Sale Item</a></h3>
          <div class="price">
            <s class="price-item--regular">€49.99</s>
            <span class="price-item--sale">€29.99</span>
          </div>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].price).toBe('29.99');
      expect(products[0].currency).toBe('EUR');
    });

    test('strips struck-through prices even without sale-specific classes', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/x">X</a></h3>
          <div class="product-price"><del>€49.99</del> €29.99</div>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].price).toBe('29.99');
    });

    test('parses prices with thousands separators', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/case">Sealed Case</a></h3>
          <span class="price">€1,299.99</span>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].price).toBe('1299.99');
    });

    test('parses whole-number prices with no decimals', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/round">Round Price</a></h3>
          <span class="price">£30</span>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].price).toBe('30.00');
      expect(products[0].currency).toBe('GBP');
    });
  });

  describe('stock detection', () => {
    test.each([
      ['out of stock', 0],
      ['sold out', 0],
      ['esgotado', 0],
      ['indisponível', 0],
      ['unavailable', 0],
      ['épuisé', 0],
      ['agotado', 0],
      ['producto no disponible', 0],
      ['no disponible', 0],
      ['não disponível', 0],
      ['non disponibile', 0],
      ['nicht verfügbar', 0],
      ['rupture de stock', 0],
      ['en rupture', 0],
      ['In Stock', 1],
      ['Available', 1],
      ['€29.99', 1],
    ])('stock text "%s" → inStock=%i', (stockText, expected) => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/item">Item</a></h3>
          <span>${stockText}</span>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].inStock).toBe(expected);
    });
  });

  describe('edge cases', () => {
    test('returns empty array for empty HTML', () => {
      expect(extract('<html><body></body></html>', sourceUrl)).toEqual([]);
    });

    test('returns empty array when no product containers found', () => {
      const html = '<html><body><p>Just text, no products.</p></body></html>';
      expect(extract(html, sourceUrl)).toEqual([]);
    });

    test('skips containers without a title', () => {
      const html = `<html><body>
        <div class="product-card">
          <span class="price">€10</span>
        </div>
        <div class="product-card">
          <h3><a href="/products/real">Real Product</a></h3>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(1);
      expect(products[0].title).toBe('Real Product');
    });

    test('deduplicates by product ID', () => {
      const html = `<html><body>
        <div class="product-card">
          <h3><a href="/products/widget">Widget</a></h3>
        </div>
        <div class="product-card">
          <h3><a href="/products/widget?variant=1">Widget</a></h3>
        </div>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products).toHaveLength(1);
    });

    test('handles multiple product URL patterns', () => {
      const html = `<html><body>
        <li class="product">
          <h2><a href="/produto/caixa-op17/">Caixa OP17</a></h2>
        </li>
      </body></html>`;

      const products = extract(html, sourceUrl);
      expect(products[0].productId).toBe('caixa-op17');
    });
  });
});
