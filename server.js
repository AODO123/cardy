require('dotenv').config({ quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Resvg } = require('@resvg/resvg-js');
const { cardSvg } = require('./og-image');

const app = express();
app.disable('x-powered-by'); // don't advertise Express in every response

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// Upstash Redis. Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from
// the environment (.env locally, Vercel env vars in production).
const redis = Redis.fromEnv();
const cardKey = (id) => `cardy:card:${id}`;

// Admin auth. The password is ADMIN_PASSWORD, unless it was changed from the
// dashboard — that stores a scrypt hash in Redis, which wins. Sessions live
// in Redis (so they survive serverless restarts), cookies are httpOnly +
// sameSite=strict, login is rate-limited per IP, and every state-changing
// request must echo a per-session CSRF token.
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

// Password hashing uses scrypt with a random per-password salt, stored as
// "<salt_hex>:<derived_hex>". sha256 is kept around only to verify hashes
// written before this upgrade, and those get re-hashed on first success.
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) return reject(err);
      resolve(salt.toString('hex') + ':' + key.toString('hex'));
    });
  });
}

// Verify a password against a stored hash. legacy=true means the stored value
// is a bare sha-256 hex from before scrypt — the caller re-hashes on success.
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return { ok: false, legacy: false };
  const sep = stored.indexOf(':');
  if (sep === -1) {
    return { ok: safeEqual(sha256(String(password)), stored), legacy: true };
  }
  const saltHex = stored.slice(0, sep);
  const hashHex = stored.slice(sep + 1);
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) {
    return { ok: false, legacy: false };
  }
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, expected.length, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return { ok: derived.length === expected.length && crypto.timingSafeEqual(derived, expected), legacy: false };
}

// The active admin password hash: a runtime-changed hash in Redis wins,
// otherwise fall back to the ADMIN_PASSWORD env var (hashed once and cached —
// scrypt is deliberately slow, so re-deriving it on every login would hurt).
let envPasswordHash = null;
async function adminPasswordHash() {
  const stored = await redis.get(passwordKey);
  if (stored) return stored;
  if (!process.env.ADMIN_PASSWORD) return null;
  if (!envPasswordHash) envPasswordHash = await hashPassword(process.env.ADMIN_PASSWORD);
  return envPasswordHash;
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
// Compared via safeEqual so a wrong token doesn't leak timing information.
const requireCsrf = (req, res, next) => {
  const provided = req.headers['x-csrf-token'];
  if (!req.admin || typeof provided !== 'string' || !safeEqual(provided, req.admin.csrf)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
  }
  next();
};

// A couple of headers on everything: don't sniff content types, don't leak the
// referrer, and a content-security-policy that only allows our own origin.
// The admin pages additionally refuse to be framed (a clickjacked login form
// could trick the admin into typing their password over a fake overlay) and
// are never cached.
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// The dashboard and sign-in HTML live in views/ (not public/) so Vercel's
// static file server can't serve them to everyone — they're only reachable
// through /admin, which gates on the session. Legacy direct paths redirect
// through that same gate.
app.get(['/admin.html', '/admin-login.html'], (_req, res) => res.redirect('/admin'));

app.use(express.json({ limit: '1mb' })); // 1MB limit for photo uploads
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 swallows errors thrown in async handlers; this wrapper surfaces
// them as a 500 instead of letting the process crash. Errors we throw on
// purpose carry a numeric status and a message worth showing the client.
const asyncHandler = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (err && typeof err.status === 'number') {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('cardy error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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

// Internal fields must never leave the server. The visitor fingerprint is how
// edit-ownership is decided — if a card response leaked it, anyone could read
// a stranger's fingerprint and forge the cookie to take over their card.
function toPublicCard(card) {
  if (!card) return null;
  const copy = { ...card };
  delete copy.fingerprint;
  return copy;
}

// SCAN every stored card key. Keep the full `cardy:card:<id>` form — mget()
// needs the full keys, not the bare ids.
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

// The base URL used for share links. In production PUBLIC_BASE_URL is set, so
// a malicious Host header can never poison a share link. When it's unset (a
// fresh local clone) only loopback hosts are accepted — anything else fails
// loudly instead of silently building links that point at the attacker.
const ALLOWED_DEV_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = req.get('host');
  if (!host || !ALLOWED_DEV_HOST_RE.test(host)) {
    throw httpError(500, 'Server cannot build share links: set PUBLIC_BASE_URL.');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${host}`;
}

function buildCardUrl(req, id) {
  return `${baseUrl(req)}/card/${id}`;
}

// Socials are plain usernames; anything outside this list is dropped.
const KNOWN_PLATFORMS = ['discord', 'x', 'instagram', 'tiktok'];

// Normalize incoming socials: known platforms only, one per platform,
// handles trimmed, extra fields (like old `verified`) dropped.
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

// Validate and sanitize a base64 photo data URI. Returns the cleaned string
// or null if the input is invalid or absent.
function sanitizePhoto(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    if (buf.length > 800000) return null; // ~800KB cap
    return 'data:image/' + m[1].toLowerCase() + ';base64,' + buf.toString('base64');
  } catch { return null; }
}

// One place that turns raw input into a card. Returns { value } on success or
// { error } on failure. includeOwner is admin-only — the public form can
// never mark a card as the owner.
function normalizeCard(body, opts = {}) {
  const {
    name, age, country, role, roleLabel,
    aboutMe, notes, socials, website, mbti, interests,
    favoriteSong, favoriteMusic, favoriteMovie,
    owner, photo,
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

  // Trimmed string, truncated to max chars so one abusive request can't blow
  // up the stored card (and the DOM that renders it).
  const str = (v, max) => {
    const s = v == null ? null : String(v).trim();
    if (!s) return null;
    return max && s.length > max ? s.slice(0, max) : s;
  };

  const value = {
    name: str(name, 100),
    age: ageNum,
    country: str(country, 100),
    role: role === 'student' ? 'student' : 'job',
    roleLabel: str(roleLabel, 100),
    aboutMe: str(aboutMe, 500) || str(notes, 500),
    socials: sanitizeSocials(socials),
    website: str(website, 200),
    mbti: str(mbti, 10),
    interests: str(interests, 200),
    favoriteSong: str(favoriteSong, 200) || str(favoriteMusic, 200),
    favoriteMovie: str(favoriteMovie, 200),
  };

  const cleanPhoto = sanitizePhoto(photo);
  if (cleanPhoto) value.photo = cleanPhoto;

  if (opts.includeOwner) value.owner = owner === true;
  return { value };
}

// ── Visitor fingerprint (httpOnly cookie, 30 days) ─────────────────────
const FP_COOKIE = 'cardy_fp';
const FP_TTL = 30 * 24 * 60 * 60; // 30 days

function getFingerprint(req) {
  let fp = getCookie(req, FP_COOKIE);
  if (fp && /^[0-9a-f]{16}$/.test(fp)) return fp;
  return null;
}

function ensureFingerprint(req, res) {
  let fp = getCookie(req, FP_COOKIE);
  if (fp && /^[0-9a-f]{16}$/.test(fp)) return fp;
  fp = crypto.randomBytes(8).toString('hex');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(FP_COOKIE, fp, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: FP_TTL * 1000,
  });
  return fp;
}

// ── Daily card limit ───────────────────────────────────────────────────
function dailyLimitKey(fp) {
  return `cardy:daily:${fp}:${new Date().toISOString().slice(0, 10)}`;
}

app.post('/api/cards', asyncHandler(async (req, res) => {
  const result = normalizeCard(req.body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  const fp = ensureFingerprint(req, res);

  // Admin sessions (valid cardy_admin cookie) may create unlimited cards.
  const adminSession = getCookie(req, COOKIE_NAME) ? await sessionFor(req) : null;

  // Editing an existing card — bypass the daily limit since the user owns it.
  const rawEditId = req.body._editId;
  let editingId = null;
  if (rawEditId != null && rawEditId !== '') {
    if (typeof rawEditId !== 'string' || !/^[0-9a-f]{6}$/.test(rawEditId)) {
      return res.status(400).json({ error: 'Invalid card id.' });
    }
    editingId = rawEditId;
  }
  if (editingId) {
    const existing = await getCard(editingId);
    if (!existing) {
      return res.status(404).json({ error: 'Card not found.' });
    }
    if (existing.fingerprint !== fp) {
      return res.status(403).json({ error: 'You can only edit your own card.' });
    }
    const card = { ...existing, ...result.value };
    await saveCard(card);
    return res.json(toPublicCard(card));
  }

  // New card — enforce one per day per browser, unless an admin session is
  // present. Admins still get their cards tracked per-browser below so they
  // can edit them from the banner, but no daily key is written.
  if (!adminSession) {
    const existingCardId = await redis.get(dailyLimitKey(fp));
    if (existingCardId) {
      const existing = await getCard(existingCardId);
      if (existing) {
        return res.status(429).json({
          error: 'limit',
          message: 'You can create one card per day. Come back tomorrow!',
          card: toPublicCard(existing),
        });
      }
    }
  }

  const id = await nextId();
  const card = {
    id,
    ...result.value,
    fingerprint: fp,
    createdAt: new Date().toISOString(),
    shareUrl: buildCardUrl(req, id),
  };

  await saveCard(card);
  // Remember this browser's card so the limit banner can link back to every
  // card they've made, not just today's.
  await redis.lpush('cardy:fp:' + fp, id);
  await redis.ltrim('cardy:fp:' + fp, 0, 49);
  if (!adminSession) {
    await redis.set(dailyLimitKey(fp), id, { ex: 172800 }); // 48h TTL
  }
  res.status(201).json(toPublicCard(card));
}));

app.get('/api/cards/:id', asyncHandler(async (req, res) => {
  const card = await getCard(req.params.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  res.json(toPublicCard(card));
}));

// Check whether this browser has already created a card today, and return it
// so the client can switch to edit mode instead of showing the create form.
// Also lists every card this browser ever made, so the limit banner can link
// to each one (newest card last).
app.get('/api/daily-limit', async (req, res) => {
  const admin = getCookie(req, COOKIE_NAME) ? await sessionFor(req) : null;
  const fp = getFingerprint(req);
  if (!fp) return res.json({ limited: false, cards: [] });
  try {
    // Admins bypass the limit (unlimited creation), but the card list is
    // still returned so the banner can offer edit links to their cards.
    const todayId = admin ? null : await redis.get(dailyLimitKey(fp));
    const today = todayId ? await getCard(todayId) : null;

    const ids = await redis.lrange('cardy:fp:' + fp, 0, -1);
    const cards = [];
    if (ids.length) {
      const values = await redis.mget(...ids.reverse().map((id) => cardKey(id)));
      for (const v of values) if (v) cards.push(toPublicCard(v));
    }
    if (today && !cards.some((c) => c.id === today.id)) {
      cards.unshift(toPublicCard(today));
    }

    res.json({ limited: admin ? false : !!todayId, today: today ? toPublicCard(today) : null, cards });
  } catch (err) {
    console.error('cardy error:', err);
    res.json({ limited: false, cards: [] });
  }
});

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
  if (typeof password !== 'string') {
    await redis.set(lock, attempts + 1, { ex: LOGIN_LOCK_SECONDS });
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const verify = await verifyPassword(password, hash);
  if (!verify.ok) {
    await redis.set(lock, attempts + 1, { ex: LOGIN_LOCK_SECONDS });
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  await redis.del(lock); // a success resets the lockout counter

  if (verify.legacy) {
    // First successful login with a pre-scrypt hash: upgrade it in place.
    await redis.set(passwordKey, await hashPassword(password));
  }

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

// Serve the dashboard, or the sign-in page when there's no valid session.
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
    .filter(Boolean)
    .map(toPublicCard);
  cards.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(cards);
}));

app.get('/admin/api/cards/:id', requireAuth(), asyncHandler(async (req, res) => {
  const card = await getCard(req.params.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  res.json(toPublicCard({ id: req.params.id, ...card }));
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
  };
  await saveCard(card);
  res.status(201).json(toPublicCard(card));
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
  res.json(toPublicCard(card));
}));

app.delete('/admin/api/cards/:id', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const deleted = await redis.del(cardKey(req.params.id));
  if (!deleted) {
    return res.status(404).json({ error: 'Card not found.' });
  }
  res.json({ ok: true });
}));

// Bulk delete from the dashboard: the front-end sends the checked ids, we drop
// whatever exists and report how many went away. idempotent — ids that are
// already gone are just ignored.
app.post('/admin/api/cards/bulk-delete', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => /^[0-9a-f]{6}$/.test(String(id))) : [];
  if (!ids.length) {
    return res.status(400).json({ error: 'No valid card ids provided.' });
  }
  const keys = ids.map((id) => cardKey(id));
  const values = await redis.mget(...keys);
  const existingKeys = keys.filter((key, i) => values[i]);
  if (existingKeys.length) {
    await redis.del(...existingKeys);
  }
  res.json({ ok: true, deleted: existingKeys.length });
}));

app.post('/admin/api/password', requireAuth(), requireCsrf, asyncHandler(async (req, res) => {
  const { currentPassword, password } = req.body || {};
  const current = await adminPasswordHash();
  const verify = await verifyPassword(currentPassword || '', current);
  if (!verify.ok) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  await redis.set(passwordKey, await hashPassword(password));
  res.json({ ok: true });
}));

// The extra <head> tags for a card page. Link-preview crawlers (Discord,
// WhatsApp, Telegram) fetch the HTML without running JS, so the per-card
// title and Open Graph tags have to be baked into the response itself.
function cardHeadTags(card, shareUrl) {
  const name = String(card.name || 'cardy');
  const roleLine = card.roleLabel || (card.role === 'student' ? 'Student' : 'your tiny digital card');
  const meta = [card.age, card.country].filter(Boolean).join(' · ');
  const description = [
    `${name} — ${roleLine}`,
    meta ? `${meta}.` : '',
    card.aboutMe ? card.aboutMe : '',
  ].filter(Boolean).join(' ');
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return (
    `<title>${escapeAttr(name)} — cardy</title>\n` +
    `    <meta name="description" content="${escapeAttr(description.slice(0, 160))}">\n` +
    `    <meta property="og:type" content="profile">\n` +
    `    <meta property="og:title" content="${escapeAttr(name + ' — cardy')}">\n` +
    `    <meta property="og:description" content="${escapeAttr(description.slice(0, 200))}">\n` +
    `    <meta property="og:url" content="${escapeAttr(shareUrl)}">\n` +
    `    <meta property="og:image" content="${escapeAttr(shareUrl.replace('/card/', '/og/') + '.png')}">\n` +
    `    <meta property="og:image:width" content="1200">\n` +
    `    <meta property="og:image:height" content="630">\n` +
    `    <meta name="twitter:card" content="summary_large_image">\n` +
    `    <meta name="twitter:title" content="${escapeAttr(name + ' — cardy')}">\n` +
    `    <meta name="twitter:description" content="${escapeAttr(description.slice(0, 200))}">\n` +
    `    <meta name="twitter:image" content="${escapeAttr(shareUrl.replace('/card/', '/og/') + '.png')}">`
  );
}

// Rasterize a card's SVG to PNG. resvg is a WASM build, so no native binaries
// to fight with on Vercel's serverless instances.
function renderCardPng(card) {
  const svg = cardSvg(card);
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' } });
  const png = resvg.render().asPng();
  return Buffer.from(png);
}

// The shared card page — a static shell that fetches /api/cards/:id in JS.
// The title and meta tags are injected server-side so shared links preview
// with the person's actual name and card graphic.
app.get('/card/:id', asyncHandler(async (req, res) => {
  const template = fs.readFileSync(path.join(__dirname, 'public', 'card.html'), 'utf8');
  let card = null;
  try {
    card = await getCard(req.params.id);
  } catch (err) {
    console.error('cardy og lookup failed:', err.message);
  }
  if (card) {
    const shareUrl = buildCardUrl(req, req.params.id);
    return res.send(template.replace(
      '<title>cardy — your tiny digital card</title>',
      cardHeadTags(card, shareUrl)
    ));
  }
  // Unknown id or Redis hiccup — serve the plain shell rather than an error.
  res.send(template);
}));

// The OG card image: a flat PNG of the card, generated fresh per card. The
// image is deterministic per card id, so the CDN can cache it indefinitely.
// Rendering is CPU-heavy, so cap it per IP. The limiter lives in memory —
// per serverless instance — which raises the cost of hammering it without
// being a hard global cap (fine for this threat model).
const OG_LIMIT = 30; // requests per IP per minute
const OG_WINDOW_MS = 60 * 1000;
const ogHits = new Map(); // ip → { count, resetAt }

function ogLimited(req) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const hit = ogHits.get(ip);
  if (!hit || now > hit.resetAt) {
    ogHits.set(ip, { count: 1, resetAt: now + OG_WINDOW_MS });
    if (ogHits.size > 5000) {
      // Opportunistic sweep so the map can't grow forever.
      for (const [k, v] of ogHits) if (now > v.resetAt) ogHits.delete(k);
    }
    return false;
  }
  hit.count++;
  return hit.count > OG_LIMIT;
}

app.get('/og/:id.png', asyncHandler(async (req, res) => {
  if (ogLimited(req)) {
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  }
  const card = await getCard(req.params.id);
  const png = renderCardPng(card); // cardSvg falls back to the brand card
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(png);
}));

// Some browsers still poke at /favicon.ico by habit even though every page
// declares /cardy.png as its icon. Answer with the real icon instead of a 404.
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cardy.png'));
});

// Unmatched routes return JSON 404 instead of Express's HTML page.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Last-resort error handler: malformed JSON gets a clean 400, everything
// else (including async errors not caught above) becomes a JSON 500.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  console.error('cardy error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

// Start the server when run directly; Vercel just imports the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`cardy running at http://localhost:${PORT}`);
  });
}

module.exports = app;
