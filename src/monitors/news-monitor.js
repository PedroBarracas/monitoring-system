const crypto = require('crypto');
const cheerio = require('cheerio');

function createNewsMonitor({ newsRepo, alertRepo, notifier, httpClient, config, logger }) {
  function extractArticles(html, selectors, sourceUrl) {
    const $ = cheerio.load(html);
    const articles = [];

    $(selectors.container).each((_i, el) => {
      const titleEl = $(el).find(selectors.title);
      const title = titleEl.text().trim();
      if (!title) return;

      const articleUrl = titleEl.attr('href') || $(el).find(selectors.link).attr('href') || '';
      const articleId =
        $(el).attr(selectors.articleId) || hashString(articleUrl || title);

      articles.push({ articleId, title, articleUrl, sourceUrl });
    });

    return articles;
  }

  return {
    name: 'news-monitor',

    async run() {
      let alertsSent = 0;
      const errors = [];

      for (const source of config.sources) {
        try {
          const html = await httpClient.fetchHtml(source.url);
          const articles = extractArticles(html, source.selectors, source.url);
          logger.info(`Extracted ${articles.length} articles from ${source.url}`);

          for (const article of articles) {
            const existing = newsRepo.getArticle(article.sourceUrl, article.articleId);

            if (!existing) {
              newsRepo.insertArticle({
                sourceUrl: article.sourceUrl,
                articleId: article.articleId,
                title: article.title,
                articleUrl: article.articleUrl,
              });

              alertRepo.logAlert('new_article', {
                articleId: article.articleId,
                title: article.title,
                url: article.articleUrl,
              });

              const sent = await notifier.sendAlert({
                eventType: 'NEW_ARTICLE',
                title: article.title,
                body: `URL: ${article.articleUrl}`,
              });
              if (!sent) logger.warn(`Failed to send article alert for ${article.articleId}`);
              alertsSent++;
            }
          }
        } catch (err) {
          logger.error(`Failed to process ${source.url}`, { error: err.message });
          errors.push(`${source.url}: ${err.message}`);
        }
      }

      return { alertsSent, errors };
    },
  };
}

function hashString(str) {
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 12);
}

module.exports = { createNewsMonitor };
