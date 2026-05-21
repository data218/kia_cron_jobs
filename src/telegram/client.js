import { config, requireSecret } from '../config.js';

export class TelegramClient {
  constructor({ token = config.telegramBotToken } = {}) {
    requireSecret('TELEGRAM_BOT_TOKEN', token);
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async request(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(`Telegram ${method} failed: ${JSON.stringify(payload)}`);
    }

    return payload.result;
  }

  async getMe() {
    return this.request('getMe');
  }

  async getUpdates({ offset, timeout = 0 } = {}) {
    return this.request('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'channel_post']
    });
  }

  async dropPendingUpdates() {
    const updates = await this.getUpdates({ timeout: 0 });
    if (!updates.length) return null;
    return updates.at(-1).update_id + 1;
  }

  async sendMessage({ chatId = config.telegramChatId, text }) {
    requireSecret('TELEGRAM_CHAT_ID', chatId);
    return this.request('sendMessage', {
      chat_id: chatId,
      text
    });
  }
}
