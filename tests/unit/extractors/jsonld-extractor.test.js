const { extract } = require('../../../src/extractors/jsonld-extractor');

function wrapJsonLd(data) {
  const json = JSON.stringify(data);
  return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`;
}

describe('jsonld-extractor', () => {
  const sourceUrl = 'https://shop.example.com/products';

  test('extracts a single Product', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'Widget Alpha',
      sku: 'W-001',
      url: 'https://shop.example.com/products/widget-alpha',
      offers: { availability: 'https://schema.org/InStock', price: '29.99' },
    });

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(1);
    expect(products[0]).toEqual({
      productId: 'W-001',
      productUrl: 'https://shop.example.com/products/widget-alpha',
      title: 'Widget Alpha',
      inStock: 1,
      price: '29.99',
      currency: null,
      sourceUrl,
    });
  });

  test('extracts from an array of Products', () => {
    const html = wrapJsonLd([
      { '@type': 'Product', name: 'A', sku: '1', offers: { availability: 'https://schema.org/InStock' } },
      { '@type': 'Product', name: 'B', sku: '2', offers: { availability: 'https://schema.org/OutOfStock' } },
    ]);

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(2);
    expect(products[0].inStock).toBe(1);
    expect(products[1].inStock).toBe(0);
  });

  test('extracts from @graph container', () => {
    const html = wrapJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Product', name: 'Graphed Product', sku: 'GP-1', offers: {} },
        { '@type': 'WebPage', name: 'Some Page' },
      ],
    });

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('Graphed Product');
  });

  test('handles AggregateOffer with nested offers', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'Bundle',
      sku: 'B-1',
      offers: {
        '@type': 'AggregateOffer',
        offers: [
          { availability: 'https://schema.org/InStock' },
          { availability: 'https://schema.org/InStock' },
        ],
      },
    });

    const products = extract(html, sourceUrl);
    expect(products[0].inStock).toBe(1);
  });

  test('marks out of stock when any offer is OutOfStock', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'Sold Out Item',
      sku: 'SO-1',
      offers: { availability: 'https://schema.org/OutOfStock' },
    });

    const products = extract(html, sourceUrl);
    expect(products[0].inStock).toBe(0);
  });

  test('handles http:// schema URLs', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'HTTP Item',
      sku: 'H-1',
      offers: { availability: 'http://schema.org/OutOfStock' },
    });

    const products = extract(html, sourceUrl);
    expect(products[0].inStock).toBe(0);
  });

  test('uses productID when sku is absent', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'No SKU',
      productID: 'PID-42',
      offers: {},
    });

    const products = extract(html, sourceUrl);
    expect(products[0].productId).toBe('PID-42');
  });

  test('falls back to URL slug when no sku or productID', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'Fallback Product',
      url: 'https://shop.example.com/products/fallback-widget',
      offers: {},
    });

    const products = extract(html, sourceUrl);
    expect(products[0].productId).toBe('fallback-widget');
  });

  test('falls back to name slug when no identifiers', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'My Great Product',
      offers: {},
    });

    const products = extract(html, sourceUrl);
    expect(products[0].productId).toBe('my-great-product');
  });

  test('skips items without a name', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      sku: 'NO-NAME',
      offers: {},
    });

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(0);
  });

  test('skips non-Product types', () => {
    const html = wrapJsonLd({
      '@type': 'Organization',
      name: 'Some Org',
    });

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(0);
  });

  test('handles invalid JSON gracefully', () => {
    const html = '<html><head><script type="application/ld+json">{invalid json</script></head><body></body></html>';
    const products = extract(html, sourceUrl);
    expect(products).toEqual([]);
  });

  test('returns empty array when no JSON-LD scripts present', () => {
    const html = '<html><body><p>No structured data</p></body></html>';
    const products = extract(html, sourceUrl);
    expect(products).toEqual([]);
  });

  test('handles multiple JSON-LD script blocks', () => {
    const block1 = JSON.stringify({ '@type': 'Product', name: 'P1', sku: 's1', offers: {} });
    const block2 = JSON.stringify({ '@type': 'Product', name: 'P2', sku: 's2', offers: {} });
    const html = `<html><head>
      <script type="application/ld+json">${block1}</script>
      <script type="application/ld+json">${block2}</script>
    </head><body></body></html>`;

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(2);
  });

  test('defaults to in-stock when offers missing', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'No Offers',
      sku: 'NO-1',
    });

    const products = extract(html, sourceUrl);
    expect(products[0].inStock).toBe(1);
  });

  test('defaults to in-stock when availability not specified', () => {
    const html = wrapJsonLd({
      '@type': 'Product',
      name: 'No Avail',
      sku: 'NA-1',
      offers: { price: '10.00' },
    });

    const products = extract(html, sourceUrl);
    expect(products[0].inStock).toBe(1);
  });

  test('extracts Products from ItemList with ListItem elements', () => {
    const html = wrapJsonLd({
      '@type': 'ItemList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          item: {
            '@type': 'Product',
            name: 'Booster Box OP14',
            sku: '4582769923180',
            offers: { '@type': 'Offer', availability: 'https://schema.org/OutOfStock', price: '169.99' },
            url: 'https://shop.example.com/product/op14',
          },
        },
        {
          '@type': 'ListItem',
          position: 2,
          item: {
            '@type': 'Product',
            name: 'Booster Box OP15',
            sku: '43088',
            offers: { '@type': 'Offer', availability: 'https://schema.org/InStock', price: '89.99' },
            url: 'https://shop.example.com/product/op15',
          },
        },
      ],
    });

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(2);
    expect(products[0]).toEqual({
      productId: '4582769923180',
      productUrl: 'https://shop.example.com/product/op14',
      title: 'Booster Box OP14',
      inStock: 0,
      price: '169.99',
      currency: null,
      sourceUrl,
    });
    expect(products[1]).toEqual({
      productId: '43088',
      productUrl: 'https://shop.example.com/product/op15',
      title: 'Booster Box OP15',
      inStock: 1,
      price: '89.99',
      currency: null,
      sourceUrl,
    });
  });

  test('skips ItemList with non-Product items', () => {
    const html = wrapJsonLd({
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item: { '@type': 'WebPage', name: 'Page 1' } },
      ],
    });

    const products = extract(html, sourceUrl);
    expect(products).toHaveLength(0);
  });
});
