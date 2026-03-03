const { createNewsMonitor } = require('../../../src/monitors/news-monitor');
const {
  NEWS_HTML,
  NEWS_HTML_WITH_NEW_ARTICLE,
  DEFAULT_NEWS_SELECTORS,
} = require('../../helpers/fixtures');

describe('news-monitor', () => {
  let mockNewsRepo;
  let mockAlertRepo;
  let mockNotifier;
  let mockHttpClient;
  let mockLogger;
  let monitor;

  const config = {
    sources: [
      {
        url: 'https://news.example.com',
        selectors: DEFAULT_NEWS_SELECTORS,
      },
    ],
  };

  beforeEach(() => {
    mockNewsRepo = {
      getArticle: jest.fn(),
      insertArticle: jest.fn(),
    };
    mockAlertRepo = { logAlert: jest.fn() };
    mockNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
    mockHttpClient = { fetchHtml: jest.fn() };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    monitor = createNewsMonitor({
      newsRepo: mockNewsRepo,
      alertRepo: mockAlertRepo,
      notifier: mockNotifier,
      httpClient: mockHttpClient,
      config,
      logger: mockLogger,
    });
  });

  test('has correct name', () => {
    expect(monitor.name).toBe('news-monitor');
  });

  test('first run inserts all articles and sends alerts', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(NEWS_HTML);
    mockNewsRepo.getArticle.mockReturnValue(undefined);

    const result = await monitor.run();

    expect(result.alertsSent).toBe(2);
    expect(result.errors).toEqual([]);

    // Verify repo calls
    expect(mockNewsRepo.insertArticle).toHaveBeenCalledTimes(2);
    expect(mockNewsRepo.insertArticle).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 'news-001',
        title: 'Breaking: Major Update Released',
      })
    );

    expect(mockNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'NEW_ARTICLE',
        title: 'Breaking: Major Update Released',
      })
    );
  });

  test('no alerts on second run with same articles', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(NEWS_HTML);
    // All articles already exist
    mockNewsRepo.getArticle.mockReturnValue({ article_id: 'existing' });

    const result = await monitor.run();

    expect(result.alertsSent).toBe(0);
    expect(mockNotifier.sendAlert).not.toHaveBeenCalled();
  });

  test('detects new article', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(NEWS_HTML_WITH_NEW_ARTICLE);
    // First two exist, third is new
    mockNewsRepo.getArticle
      .mockReturnValueOnce({ article_id: 'news-001' })
      .mockReturnValueOnce({ article_id: 'news-002' })
      .mockReturnValueOnce(undefined);

    const result = await monitor.run();

    expect(result.alertsSent).toBe(1);
    expect(mockNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'NEW_ARTICLE',
        title: 'New Partnership Announced',
      })
    );

    expect(mockNewsRepo.insertArticle).toHaveBeenCalledTimes(1);
    expect(mockNewsRepo.insertArticle).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'news-003' })
    );
  });

  test('handles fetch error gracefully', async () => {
    mockHttpClient.fetchHtml.mockRejectedValue(new Error('DNS resolution failed'));

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('DNS resolution failed');
  });

  test('handles empty HTML gracefully', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue('<html><body></body></html>');

    const result = await monitor.run();
    expect(result.alertsSent).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test('records alerts via alertRepo', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(NEWS_HTML);
    mockNewsRepo.getArticle.mockReturnValue(undefined);

    await monitor.run();

    expect(mockAlertRepo.logAlert).toHaveBeenCalledTimes(2);
    expect(mockAlertRepo.logAlert).toHaveBeenCalledWith(
      'new_article',
      expect.objectContaining({ articleId: 'news-001' })
    );
  });

  test('handles multiple sources', async () => {
    const multiConfig = {
      sources: [
        { url: 'https://news1.com', selectors: DEFAULT_NEWS_SELECTORS },
        { url: 'https://news2.com', selectors: DEFAULT_NEWS_SELECTORS },
      ],
    };
    const multiMonitor = createNewsMonitor({
      newsRepo: mockNewsRepo,
      alertRepo: mockAlertRepo,
      notifier: mockNotifier,
      httpClient: mockHttpClient,
      config: multiConfig,
      logger: mockLogger,
    });

    mockHttpClient.fetchHtml.mockResolvedValue(NEWS_HTML);
    mockNewsRepo.getArticle.mockReturnValue(undefined);

    const result = await multiMonitor.run();

    // 2 articles * 2 sources = 4 alerts
    expect(result.alertsSent).toBe(4);
  });

  test('does not insert existing articles', async () => {
    mockHttpClient.fetchHtml.mockResolvedValue(NEWS_HTML);
    // All articles already exist
    mockNewsRepo.getArticle.mockReturnValue({ article_id: 'existing' });

    await monitor.run();

    expect(mockNewsRepo.insertArticle).not.toHaveBeenCalled();
  });
});
