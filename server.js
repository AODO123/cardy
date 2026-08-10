require('dotenv').config({ quiet: true });

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

// --- Admin auth ------------------------------------------------------------
// The admin password comes from the ADMIN_PASSWORD env var and can be changed
// at runtime from the dashboard (which stores a sha-256 hash in Redis; that
// hash then wins over the env var). Sessions live in Redis so they survive
// serverless restarts, cookies are httpOnly + sameSite=strict, login is
// rate-limited per IP, and every state-changing request must echo a CSRF
// token from the session.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_SECONDS = 15 * 60; // 15 minutes
const COOKIE_NAME = 'cardy_admin';
const passwordKey = 'cardy:admin:passhash';
const sessionKey = (token) => `cardy:admin:session:${token}`;
const loginKey = (ip) => `cardy:admin:login:${ip}`;

app.set('trust proxy', 1); // Vercel sits one hop in front of us

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Constant-time comparison so login timing doesn't leak the password hash.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// The active admin password hash: a runtime-changed hash in Redis wins,
// otherwise fall back to the ADMIN_PASSWORD env var.
async function adminPasswordHash() {
  const stored = await redis.get(passwordKey);
  if (stored) return stored;
  return process.env.ADMIN_PASSWORD ? sha256(process.env.ADMIN_PASSWORD) : null;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

async function sessionFor(req) {
  const token = getCookie(req, COOKIE_NAME);
  if (!token) return null;
  let raw;
  try { raw = await redis.get(sessionKey(token)); } catch { return null; }
  if (!raw) return null;
  let session;
  try { session = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!session || !session.csrf) return null;
  return { token, csrf: session.csrf };
}

// Protect an admin API route. API routes return JSON 401; page routes redirect.
const requireAuth = (api = true) => async (req, res, next) => {
  const session = await sessionFor(req);
  if (!session) {
    if (api) return res.status(401).json({ error: 'Admin authentication required.' });
    return res.redirect('/admin');
  }
  req.admin = session;
  next();
};

// CSRF: state-changing admin requests must echo the session's CSRF token.
const requireCsrf = (req, res, next) => {
  const provided = req.headers['x-csrf-token'];
  if (!req.admin || !provided || provided !== req.admin.csrf) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
};

// --- Basic security headers (defense in depth) -----------------------------
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) {
    // Block clickjacking of the login/dashboard (a framed login form could
    // trick the admin into typing their password over a fake overlay).
    res.setHeader('X-Frame-Options', 'DENY');
    // Never let the browser cache the dashboard or its API responses.
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// The dashboard and sign-in HTML live in views/ (NOT public/) so Vercel's
// static file server can't hand them out to everyone — they are only
// reachable through /admin, which gates on the session. Any legacy direct
// paths redirect through that same gate.
app.get(['/admin.html', '/admin-login.html'], (_req, res) => res.redirect('/admin'));

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

async function nextId() {
  let id;
  do {
    id = makeId();
  } while ((await redis.exists(cardKey(id))) === 1);
  return id;
}

async function getCard(id) {
  // Upstash's client auto-deserializes JSON, so the value is already an object.
  return redis.get(cardKey(id));
}

async function saveCard(card) {
  await redis.set(cardKey(card.id), JSON.stringify(card));
}

// All stored card KEYS (full `cardy:card:<id>` form), via SCAN. Returning the
// full keys matters: redis.mget() needs them, not the bare ids.
async function getAllCardKeys() {
  const keys = [];
  let cursor = 0;
  do {
    const [next, found] = await redis.scan(cursor, { match: 'cardy:card:*', count: 200 });
    keys.push(...found);
    cursor = Number(next) || 0;
  } while (cursor !== 0);
  return keys;
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

// --- Socials ---------------------------------------------------------------
// Platforms accepted from the form. 'spotify' is kept for backward compatibility
// with cards created before it was replaced by 'x'.
const KNOWN_PLATFORMS = ['discord', 'x', 'instagram', 'tiktok', 'spotify'];

// Normalize incoming socials: keep only known platforms, one per platform,
// trim handles, and drop any extra fields (like old `verified`).
function sanitizeSocials(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const platform = String(item.platform || '').toLowerCase();
    if (!KNOWN_PLATFORMS.includes(platform) || seen.has(platform)) continue;
    seen.add(platform);
    const handle = String(item.handle || '').trim().slice(0, 120);
    if (!handle) continue;
    out.push({ platform, handle });
  }
  return out;
}

// --- Card validation -------------------------------------------------------
// Single source of truth for card input. Returns { value } on success or
// { error } on failure. `includeOwner` is admin-only: the public form can
// never mark a card as the owner.
function normalizeCard(body, opts = {}) {
  const {
    name, age, country, role, roleLabel,
    aboutMe, notes, socials, website, mbti, interests,
    favoriteSong, favoriteMusic, favoriteMovie,
    owner,
  } = body || {};

  if (!name || !String(name).trim()) {
    return { error: 'Name is required.' };
  }

  if (age === '' || age == null) {
    return { error: 'Age is required.' };
  }

  const ageNum = Number(age);
  const ageClean = (typeof age === 'number' || typeof age === 'string') &&
    Number.isInteger(ageNum) && ageNum >= 1 && ageNum <= 130;
  if (!ageClean) {
    return { error: 'Age must be a whole number between 1 and 130.' };
  }

  const str = (v) => (v == null ? null : String(v).trim()) || null;

  const value = {
    name: String(name).trim(),
    age: ageNum,
    country: str(country),
    role: role === 'student' ? 'student' : 'job',
    roleLabel: str(roleLabel),
    // Backward compatible: old cards sent `notes`, new forms send `aboutMe`.
    aboutMe: str(aboutMe) || str(notes),
    socials: sanitizeSocials(socials),
    website: str(website),
    mbti: str(mbti),
    interests: str(interests),
    // Backward compatible: old cards used `favoriteMusic`, new forms use `favoriteSong`.
    favoriteSong: str(favoriteSong) || str(favoriteMusic),
    favoriteMovie: str(favoriteMovie),
  };
  if (opts.includeOwner) value.owner = owner === true;
  return { value };
}

// --- Public API ------------------------------------------------------------
app.post('/api/cards', asyncHandler(async (req, res) => {
  const result = normalizeCard(req.body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const id = await nextId();
  const card = {
    id,
    ...result.value,
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

// --- Admin ----------------------------------------------------------------
app.post('/admin/login', asyncHandler(async (req, res) => {
  const ip = req.ip || 'unknown';
  const lock = loginKey(ip);
  const attempts = Number(await redis.get(lock)) || 0;
  if (attempts >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const hash = await adminPasswordHash();
  if (!hash) {
    return res.status(503).json({ error: 'Admin is not configured. Set the ADMIN_PASSWORD env var.' });
  }

  const { password } = req.body || {};
  if (typeof password !== 'string' || !safeEqual(sha256(password), hash)) {
    await redis.set(lock, attempts + 1, { ex: LOGIN_LOCK_SECONDS });
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  await redis.del(lock); // a success resets the lockout counter

  const token = crypto.randomBytes(32).toString('hex');
  await redis.set(
    sessionKey(token),
    JSON.stringify({ csrf: crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString() }),
    { ex: SESSION_TTL_SECONDS }
  );

  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  res.json({ ok: true });
}));

app.post('/admin/logout', requireAuth(), asyncHandler(async (req, res) => {
  await redis.del(sessionKey(req.admin.token));
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// The dashboard (or the sign-in page when there's no valid session). The
// pages live in views/ (not public/) so they can only be served here, after
// the session check.
app.get('/admin', asyncHandler(async (req, res) => {
  const session = await sessionFor(req);
  res.sendFile(path.join(__dirname, 'views', session ? 'admin.html' : 'admin-login.html'));
}));

// The dashboard needs the session's CSRF token for its mutations.
app.get('/admin/api/me', requireAuth(), (req, res) => {
  res.json({ ok: true, csrf: req.admin.csrf });
});

app.get('/admin/api/cards', requireAuth(), asyncHandler(async (req, res) => {
  const keys = await getAllCardKeys();
  if (!keys.length) return res.json([]); // mget() with no keys would throw
  const values = await redis.mget(...keys);
  const cards = keys
    .map((key, i) => (values[i] ? { id: key.slice('cardy:card:'.length), ...values[i] } : null))
    .filter(Boolean);
  cards.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(cards);
}));

app.get('/admin/api/cards/:id', requireAuth(), asyncHandler(async (req, res) => {
  const card = await getCard(req.params.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  res.json({ id: req.params.id, ...card });
}));

app.post('/admin/api/cards', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const result = normalizeCard(req.body, { includeOwner: true });
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const id = await nextId();
  const card = {
    id,
    ...result.value,
    createdAt: new Date().toISOString(),
    shareUrl: buildCardUrl(req, id),
    bitlyUrl: null,
  };
  await saveCard(card);
  res.status(201).json(card);
}));

app.patch('/admin/api/cards/:id', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const existing = await getCard(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  const result = normalizeCard(req.body, { includeOwner: true });
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const card = { ...existing, ...result.value };
  await saveCard(card);
  res.json(card);
}));

app.delete('/admin/api/cards/:id', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const deleted = await redis.del(cardKey(req.params.id));
  if (!deleted) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  res.json({ ok: true });
}));

app.post('/admin/api/password', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const { currentPassword, password } = req.body || {};
  const current = await adminPasswordHash();
  if (!current || !safeEqual(sha256(currentPassword || ''), current)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  await redis.set(passwordKey, sha256(password));
  res.json({ ok: true });
}));

// --- card view ------------------------------------------------------------
app.get('/card/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'card.html'));
});

// Any unmatched route returns JSON instead of Express's default HTML 404.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Final error handler — malformed JSON bodies get a clean 400, anything else
// (including async route errors not caught above) becomes a JSON 500.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error('cardy error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

// Listen only when run directly — Vercel imports the app instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`cardy running at http://localhost:${PORT}`);
  });
}

module.exports = app;
