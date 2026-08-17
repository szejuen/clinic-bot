// ════════════════════════════════════════════════════════════
//  WhatsApp Cloud API  —  Helper Functions
//  All WhatsApp message sending goes through this file.
//  To change how messages look, edit only this file.
// ════════════════════════════════════════════════════════════
const axios = require('axios');

const BASE_URL = 'https://graph.facebook.com/v19.0';

// ── Internal: send any WhatsApp message payload ──
async function _send(phoneId, payload) {
  try {
    await axios.post(
      `${BASE_URL}/${phoneId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10s timeout
      }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`❌ WhatsApp send error: ${detail}`);
    // Don't throw — a failed message should not crash the bot
  }
}

// ── Send a plain text message ──
async function sendText(phoneId, to, text) {
  await _send(phoneId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

// ── Send a list of quick-reply buttons (max 3 buttons) ──
// buttons = [{ id: 'btn_yes', title: 'Yes' }, ...]
async function sendButtons(phoneId, to, bodyText, buttons) {
  await _send(phoneId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.substring(0, 20) }, // max 20 chars
        })),
      },
    },
  });
}

// ── Send a scrollable list (max 10 items) ──
// sections = [{ title: 'Services', rows: [{ id: 'svc_1', title: 'Consultation', description: '30 min' }] }]
async function sendList(phoneId, to, headerText, bodyText, buttonText, sections) {
  await _send(phoneId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: bodyText },
      action: {
        button: buttonText,
        sections,
      },
    },
  });
}

// ── Send a pre-approved WhatsApp Template message ──
// Used for proactive messages (reminders, reviews) — requires Meta approval first
// templateName = name you registered in Meta Business Manager
// components = template variable values
async function sendTemplate(phoneId, to, templateName, components = []) {
  await _send(phoneId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components,
    },
  });
}

// ── Mark a message as read (shows blue ticks) ──
async function markRead(phoneId, messageId) {
  await _send(phoneId, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, markRead };
