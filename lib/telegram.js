// Thin wrapper around the Telegram Bot API. No SDK dependency -- just plain
// fetch (Node 18+, already required by package.json) against Telegram's
// HTTPS API.
//
// Deliberately uses getUpdates (long-poll-on-demand), never a webhook. A
// webhook would need to live at ONE fixed URL, but this app is multiple
// separate per-facility Vercel deployments sharing one bot -- there's no
// single deployment that could own it. getUpdates has no such requirement:
// any deployment can call it at any time with the shared bot token, as
// long as no webhook has ever been registered for the bot (setWebhook and
// getUpdates are mutually exclusive; this app never calls setWebhook, so
// getUpdates always works).

const TELEGRAM_API = 'https://api.telegram.org';

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return token;
}

// The bot's own @username (without the @), only used to build a one-tap
// t.me deep link in the admin panel. Optional -- if not set, the admin
// panel just tells the admin to open the bot chat manually and send the
// code, which works exactly the same, just one extra tap.
function getBotUsername() {
  return process.env.TELEGRAM_BOT_USERNAME || null;
}

// Sends a plain-text message to a chat. Returns true/false rather than
// throwing, so a Telegram outage or a stale/blocked chat_id never breaks
// the booking flow that triggered it -- notifying the admin is a courtesy
// on top of the booking, not a requirement for the booking to succeed.
async function sendTelegramMessage(chatId, text) {
  const token = getBotToken();
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error('Telegram sendMessage failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram sendMessage error:', err);
    return false;
  }
}

// Scans recent messages sent to the bot for one whose text contains `code`
// (case-insensitive), and returns the chat that sent it. Used right after
// the admin taps "Finish linking" in the admin panel, having just sent the
// bot their one-time code.
//
// `offset` isn't tracked/persisted anywhere -- each call just asks Telegram
// for its default recent-updates window (up to the last ~100, or whatever
// hasn't been pruned yet) and searches all of them. That's deliberately
// simple for a link-once, low-volume flow like this; it does mean an old,
// already-used code sitting in that window could theoretically be matched
// again, which is exactly why the code is cleared from the database the
// moment it's used and re-checked for expiry before matching here.
async function findChatIdForCode(code) {
  const token = getBotToken();
  if (!token || !code) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates?limit=100`);
    if (!res.ok) {
      console.error('Telegram getUpdates failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const updates = data.result || [];
    const needle = String(code).trim().toLowerCase();
    for (let i = updates.length - 1; i >= 0; i--) {
      const msg = updates[i].message;
      const text = msg && msg.text;
      if (text && text.toLowerCase().includes(needle)) {
        return {
          chatId: String(msg.chat.id),
          name: [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || 'there',
        };
      }
    }
    return null;
  } catch (err) {
    console.error('Telegram getUpdates error:', err);
    return null;
  }
}

module.exports = { sendTelegramMessage, findChatIdForCode, getBotUsername, getBotToken };
