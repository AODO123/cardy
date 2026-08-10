require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const app = express();

const PORT = process.env.PORT || 3000;
const BITLY_TOKEN = process.env.BITLY_ACCESS_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// Upstash Redis. Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from
// the environment (.env locally, Vercel env vars in production).
const redis = Redis.fromEnv();
const cardKey = (id) => `cardy:card:${id}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 doesn't catch errors from async handlers — this wrapper does,
// so a Redis hiccup returns a 500 instead of crashing the process.
const asyncHandler = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error('cardy error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

function makeId() {
  return crypto.randomBytes(3).toString('hex'); // 6 hex chars
}

async function getCard(id) {
  // Upstash's client auto-deserializes JSON, so the value is already an object.
  return redis.get(cardKey(id));
}

async function saveCard(card) {
  await redis.set(cardKey(card.id), JSON.stringify(card));
}

async function idTaken(id) {
  return (await redis.exists(cardKey(id))) === 1;
}

// --- Bitly ----------------------------------------------------------------
async function shortenWithBitly(longUrl) {
  const res = await fetch('https://api-ssl.bitly.com/v4/shorten', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BITLY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ long_url: longUrl }),
  });
  if (!res.ok) {
    throw new Error(`Bitly returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.link;
}

function buildCardUrl(req, id) {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/card/${id}`;
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}/card/${id}`;
}

// --- API routes ------------------------------------------------------------
app.post('/api/cards', asyncHandler(async (req, res) => {
  const { name, age, country, role, roleLabel, notes } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  let id;
  do {
    id = makeId();
  } while (await idTaken(id));

  const ageNum = age === '' || age == null ? null : Number(age);

  const card = {
    id,
    name: String(name).trim(),
    age: Number.isFinite(ageNum) ? ageNum : null,
    country: String(country || '').trim() || null,
    role: role === 'student' ? 'student' : 'job',
    roleLabel: String(roleLabel || '').trim() || null,
    notes: String(notes || '').trim() || null,
    createdAt: new Date().toISOString(),
    shareUrl: buildCardUrl(req, id),
    bitlyUrl: null,
  };

  await saveCard(card);

  if (BITLY_TOKEN) {
    try {
      card.bitlyUrl = await shortenWithBitly(card.shareUrl);
      await saveCard(card); // persist the bit.ly link on the stored card too
    } catch (err) {
      console.error('Bitly shorten failed:', err.message);
    }
  }

  res.status(201).json(card);
}));

app.get('/api/cards/:id', asyncHandler(async (req, res) => {
  const card = await getCard(req.params.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  res.json(card);
}));

// --- card view ------------------------------------------------------------
app.get('/card/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'card.html'));
});

// Listen only when run directly — Vercel imports the app instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`cardy running at http://localhost:${PORT}`);
  });
}

module.exports = app;
