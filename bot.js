require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { pool, initDB } = require('./db');

const app = express();
app.use(express.json());

const TOKEN        = process.env.WHATSAPP_TOKEN;
const PHONE_ID     = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const TRIGGER = ['café', 'cafe', 'coffee', '☕'];
const OUI     = ['oui', 'yes', '✅', '👍'];
const NON     = ['non', 'no',  '❌', '👎'];
const SUMMARY_DELAY_MS = 10 * 60 * 1000; // 10 min

// ─── Helpers ────────────────────────────────────────────────────
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

async function getActiveSession(groupId) {
  const { rows } = await pool.query(
    `SELECT * FROM cafe_sessions
     WHERE group_id = $1 AND active = true
     ORDER BY id DESC LIMIT 1`,
    [groupId]
  );
  return rows[0] || null;
}

async function getSummary(sessionId) {
  const { rows } = await pool.query(
    `SELECT vote, COUNT(*) AS total
     FROM cafe_votes WHERE session_id = $1
     GROUP BY vote`,
    [sessionId]
  );
  const oui = rows.find(r => r.vote === 'oui')?.total ?? 0;
  const non = rows.find(r => r.vote === 'non')?.total ?? 0;
  return { oui: Number(oui), non: Number(non) };
}

async function closeSession(sessionId) {
  await pool.query(
    'UPDATE cafe_sessions SET active = false WHERE id = $1',
    [sessionId]
  );
}

// ─── Webhook Meta (vérification) ────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ─── Webhook Meta (messages entrants) ───────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // toujours répondre immédiatement à Meta

  try {
    const change  = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from    = message.from;
    const groupId = change.metadata?.phone_number_id;
    const body    = message.text.body.toLowerCase().trim();

    // ── 1. Déclenchement sondage ──
    if (TRIGGER.some(w => body === w)) {
      const prev = await getActiveSession(groupId);
      if (prev) await closeSession(prev.id);

      const { rows } = await pool.query(
        'INSERT INTO cafe_sessions (group_id) VALUES ($1) RETURNING id',
        [groupId]
      );
      const sessionId = rows[0].id;

      await sendMessage(from,
        '☕ *Est-ce qu\'il y a du café ?*\n\n' +
        'Répondez *Oui* ou *Non*\n' +
        '📊 Résumé automatique dans 10 minutes.'
      );

      // Résumé automatique après 10 min
      setTimeout(async () => {
        const session = await getActiveSession(groupId);
        if (!session || session.id !== sessionId) return;
        const { oui, non } = await getSummary(sessionId);
        await sendMessage(from,
          `☕ *Résumé du sondage café :*\n\n` +
          `✅ Oui : ${oui}\n` +
          `❌ Non : ${non}\n\n` +
          `👥 Total : ${oui + non} réponse(s)`
        );
        await closeSession(sessionId);
      }, SUMMARY_DELAY_MS);

      return;
    }

    // ── 2. Vote ──
    const session = await getActiveSession(groupId);

    if (!session) {
      await sendMessage(from,
        '⚠️ Aucun sondage en cours.\nEnvoyez *Café* pour en démarrer un.'
      );
      return;
    }

    if (OUI.some(w => body === w)) {
      await pool.query(
        `INSERT INTO cafe_votes (session_id, sender, vote) VALUES ($1, $2, 'oui')
         ON CONFLICT (session_id, sender) DO UPDATE SET vote = 'oui'`,
        [session.id, from]
      );
      const { oui, non } = await getSummary(session.id);
      await sendMessage(from, `✅ Vote enregistré ! (${oui} oui · ${non} non)`);
      return;
    }

    if (NON.some(w => body === w)) {
      await pool.query(
        `INSERT INTO cafe_votes (session_id, sender, vote) VALUES ($1, $2, 'non')
         ON CONFLICT (session_id, sender) DO UPDATE SET vote = 'non'`,
        [session.id, from]
      );
      const { oui, non } = await getSummary(session.id);
      await sendMessage(from, `❌ Vote enregistré ! (${oui} oui · ${non} non)`);
      return;
    }

    // ── 3. Message non conforme ──
    await sendMessage(from,
      '⚠️ *Message non autorisé.*\n\n' +
      'Ce groupe accepte uniquement :\n' +
      '• *Café* — démarrer un sondage\n' +
      '• *Oui* / *Non* — voter'
    );

  } catch (err) {
    console.error('Erreur webhook :', err.message);
  }
});

// ─── Démarrage ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log('☕ Bot café démarré sur le port', process.env.PORT || 3000)
  );
});
