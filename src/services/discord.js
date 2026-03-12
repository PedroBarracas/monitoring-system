const MAX_EMBED_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;
const MAX_EMBEDS = 10;

const EVENT_COLORS = {
  CRYPTO_TRACKING: 0x3498db, // blue
  PRICE_CHANGE: 0xf39c12,   // gold
  NEW_PRODUCT: 0xfee75c,    // bright yellow
  STOCK_CHANGE: 0xe67e22,   // orange
  NEW_ARTICLE: 0x9b59b6,    // purple
  ERROR: 0xe74c3c,          // red
};
const DEFAULT_COLOR = 0x95a5a6; // gray

function createDiscordService({ webhookUrl, httpClient, logger }) {
  async function postWebhook(payload) {
    const response = await httpClient.fetchHtml(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response;
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
    const fields = parseBodyToFields(body);
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

module.exports = { createDiscordService, parseBodyToFields, EVENT_COLORS };
