const MAX_MESSAGE_LENGTH = 4096;

function createTelegramService({ botToken, chatId, httpClient, logger }) {
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  async function sendMessage(text, { parseMode = 'HTML' } = {}) {
    let finalText = text;
    let finalParseMode = parseMode;

    if (finalText.length > MAX_MESSAGE_LENGTH) {
      // Truncation can break HTML tags/entities, so fall back to plain text
      finalText = stripHtml(finalText);
      finalText = finalText.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';
      finalParseMode = undefined;
      logger.warn('Message truncated, sending as plain text');
    }

    try {
      const payload = {
        chat_id: chatId,
        text: finalText,
      };
      if (finalParseMode) payload.parse_mode = finalParseMode;

      await httpClient.fetchJson(`${baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      logger.info('Telegram message sent successfully');
      return true;
    } catch (err) {
      logger.error('Failed to send Telegram message', { error: err.message });
      return false;
    }
  }

  async function sendAlert({ eventType, title, body }) {
    const timestamp = new Date().toISOString();
    const message = [
      `<b>[${eventType}]</b> ${escapeHtml(title)}`,
      '---',
      escapeHtml(body),
      '---',
      timestamp,
    ].join('\n');

    return sendMessage(message);
  }

  return { sendMessage, sendAlert };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

module.exports = { createTelegramService, escapeHtml };
