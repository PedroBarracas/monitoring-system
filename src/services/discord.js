const MAX_EMBED_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;
const MAX_EMBEDS = 10;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBED_TOTAL_CHARS = 6000;

const EVENT_COLORS = {
  CRYPTO_TRACKING: 0x3498db, // blue
  PRICE_CHANGE: 0xf39c12,   // gold
  NEW_PRODUCT: 0xfee75c,    // bright yellow
  STOCK_CHANGE: 0xe67e22,   // orange
  PRODUCTS_REMOVED: 0xe74c3c, // red
  NEW_ARTICLE: 0x9b59b6,    // purple
  ERROR: 0xe74c3c,          // red
  CYCLE_SUMMARY: 0x2ecc71,  // green
};
const DEFAULT_COLOR = 0x95a5a6; // gray

const WEBHOOK_TIMEOUT = 10000;
const WEBHOOK_MAX_RETRIES = 3;

function createDiscordService({ webhookUrl, httpClient, logger }) {
  async function postWebhook(payload) {
    let lastError;
    for (let attempt = 0; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.status === 429) {
          const retryAfter = parseFloat(response.headers.get('retry-after') || '5');
          const delay = Math.ceil(retryAfter * 1000);
          logger.warn(`Discord rate limited, waiting ${delay}ms (attempt ${attempt + 1}/${WEBHOOK_MAX_RETRIES + 1})...`);
          if (attempt < WEBHOOK_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`Discord rate limited after ${WEBHOOK_MAX_RETRIES + 1} attempts`);
        }

        if (!response.ok) {
          throw new Error(`Discord webhook returned HTTP ${response.status}`);
        }

        return response;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        // Only retry on network/timeout errors, not on HTTP errors or exhausted rate limits
        const isNetworkError = err.name === 'AbortError' || err.name === 'TypeError' || err.message.includes('fetch failed');
        if (!isNetworkError || attempt >= WEBHOOK_MAX_RETRIES) {
          throw err;
        }
        const delay = 1000 * (attempt + 1);
        logger.warn(`Discord webhook failed, retrying in ${delay}ms (attempt ${attempt + 1}/${WEBHOOK_MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async function sendMessage(text) {
    try {
      await postWebhook({ content: text.slice(0, 2000) });
      logger.info('Discord message sent successfully');
      return true;
    } catch (err) {
      logger.error('Failed to send Discord message', { error: err.message });
      return false;
    }
  }

  async function sendAlert({ eventType, title, body }) {
    const color = EVENT_COLORS[eventType] || DEFAULT_COLOR;
    const fields = clampEmbedFields(parseBodyToFields(body), title);
    const timestamp = new Date().toISOString();

    const embed = {
      title: title.slice(0, 256),
      color,
      fields,
      footer: {
        text: 'Monitoring System',
      },
      timestamp,
    };

    // If there are URL/Product/Link fields, extract the first one as the embed URL
    const urlField = fields.find(
      (f) => ['url', 'link', 'product'].includes(f.name.toLowerCase())
    );
    if (urlField && isValidUrl(urlField.value)) {
      embed.url = urlField.value;
    }

    try {
      await postWebhook({ embeds: [embed] });
      logger.info('Discord alert sent successfully');
      return true;
    } catch (err) {
      logger.error('Failed to send Discord alert', { error: err.message });
      return false;
    }
  }

  return { sendMessage, sendAlert };
}

// Enforce Discord's hard caps so an oversized payload doesn't HTTP 400.
// Discord limits a single embed to 25 fields and 6000 total characters
// (title + field names + field values + footer text).
function clampEmbedFields(fields, title = '') {
  let budget = MAX_EMBED_TOTAL_CHARS - (title?.length || 0) - 'Monitoring System'.length;
  const out = [];
  for (const f of fields) {
    if (out.length >= MAX_FIELDS_PER_EMBED - 1) {
      out.push({ name: '​', value: `… ${fields.length - out.length} more line(s) omitted`.slice(0, MAX_FIELD_VALUE), inline: false });
      break;
    }
    const cost = (f.name?.length || 0) + (f.value?.length || 0);
    if (cost > budget) {
      out.push({ name: '​', value: '… truncated'.slice(0, MAX_FIELD_VALUE), inline: false });
      break;
    }
    out.push(f);
    budget -= cost;
  }
  return out;
}

function parseBodyToFields(body) {
  const lines = body.split('\n').filter((l) => l.trim());
  const fields = [];

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0 && colonIndex < line.length - 1) {
      const name = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      if (name && value) {
        fields.push({
          name: name.slice(0, 256),
          value: value.slice(0, MAX_FIELD_VALUE),
          inline: value.length < 40,
        });
        continue;
      }
    }
    // Line without a clear key:value structure — add as a description field
    fields.push({
      name: '\u200b', // zero-width space (Discord requires non-empty name)
      value: line.trim().slice(0, MAX_FIELD_VALUE),
      inline: false,
    });
  }

  return fields;
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { createDiscordService, parseBodyToFields, clampEmbedFields, EVENT_COLORS };
