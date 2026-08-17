// ════════════════════════════════════════════════════════════
//  WhatsApp Clinic Booking Bot  —  Main Server
//  Receives WhatsApp messages → runs state machine → replies
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const { handleMessage } = require('./lib/stateMachine');
const { startCrons } = require('./lib/crons');

// ── Health check (Render uses this to confirm the app is alive) ──
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── WhatsApp Webhook Verification ──
// When you register your webhook URL in Meta, WhatsApp sends a GET
// request to verify you own this server. We just echo back the challenge.
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Webhook verification failed — check WEBHOOK_VERIFY_TOKEN');
    res.sendStatus(403);
  }
});

// ── Receive WhatsApp Messages ──
app.post('/webhook', async (req, res) => {
  // IMPORTANT: Always respond 200 immediately.
  // WhatsApp will retry if you take >5 seconds.
  res.sendStatus(200);

  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // Ignore delivery/read receipts — only handle actual messages
    if (!value?.messages) return;

    const message = value.messages[0];
    const phoneId = value.metadata.phone_number_id; // Your WhatsApp number
    const from    = message.from;                   // Patient's phone number

    // Extract text — handle plain text and button replies
    let text = '';
    if (message.type === 'text') {
      text = message.text.body.trim();
    } else if (message.type === 'interactive') {
      // Button or list reply
      text = message.interactive?.button_reply?.title
          || message.interactive?.list_reply?.title
          || '';
    }

    console.log(`📨 Message from ${from}: "${text}"`);

    // Pass to state machine — it handles everything else
    await handleMessage({ phoneId, from, text, messageId: message.id });

  } catch (err) {
    console.error('❌ Webhook handler error:', err.message, err.stack);
  }
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Clinic bot running on port ${PORT}`);
  console.log(`📋 Webhook URL: https://YOUR-APP.onrender.com/webhook\n`);

  // Start scheduled jobs (reminders, cleanup, reviews)
  startCrons();
});
