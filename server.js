require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const { handleMessage } = require('./stateMachine');
const { startCrons } = require('./crons');

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    if (!value?.messages) return;
    const message = value.messages[0];
    const phoneId = value.metadata.phone_number_id;
    const from    = message.from;
    let text = '';
    if (message.type === 'text') {
      text = message.text.body.trim();
    } else if (message.type === 'interactive') {
      text = message.interactive?.button_reply?.title
          || message.interactive?.list_reply?.title
          || '';
    }
    console.log(`Message from ${from}: "${text}"`);
    await handleMessage({ phoneId, from, text, messageId: message.id });
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic bot running on port ${PORT}`);
  startCrons();
  });
