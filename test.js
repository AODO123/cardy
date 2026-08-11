// cardy test suite — run with: npm test
//
// Boots the real server against the real Upstash Redis and pokes at it:
// card validation, backward compatibility, pages/assets, the shared
// renderer, and the whole admin flow (login, CSRF, rate limit, CRUD,
// password change). Tests delete every card they create, so the DB stays
// clean afterwards.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const http = require('http');

require('dotenv').config({ quiet: true }); // load UPSTASH/REDIS env for the test process too

const HOST = '127.0.0.1';
const PORT = 4123;
const BASE = `http://${HOST}:${PORT}`;
// A second server with no PUBLIC_BASE_URL exercises the Host-header rejection
// path (and an isolated OG rate-limit counter).
const PORT2 = 4124;
const BASE2 = `http://${HOST}:${PORT2}`;

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// Every card id created during this run, so we can delete them at the end —
// the suite runs against the real (shared) Upstash DB and must not leave
// test junk behind.
const createdCardIds = new Set();

async function postOn(base, url, body) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (json && json.id) createdCardIds.add(json.id);
  return { status: res.status, json, text };
}
const post = (url, body) => postOn(BASE, url, body);

async function getOn(base, url, headers = {}) {
  const res = await fetch(base + url, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), headers: res.headers, buf };
}
const get = (url, headers = {}) => getOn(BASE, url, headers);

// Like post(), but lets us replay the server-issued fingerprint cookie so a
// series of requests behaves like one browser. Also returns the cookie value.
async function postWithCookieOn(base, url, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  const sc = res.headers.get('set-cookie') || '';
  const fp = (sc.match(/cardy_fp=([^;]+)/) || [])[1] || '';
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (json && json.id) createdCardIds.add(json.id);
  return { status: res.status, json, text, fp, cookie: sc };
}
const postWithCookie = (url, body, cookie) => postWithCookieOn(BASE, url, body, cookie);

// A raw http.request that lets us send a custom Host header — undici's fetch
// silently drops one, so this is the only way to poke at Host handling.
function rawPost(port, urlPath, hostHeader, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Host: hostHeader,
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Load render-card.js in a bare vm context so we can test it headless.
function render(card) {
  const code = fs.readFileSync(path.join(__dirname, 'public', 'render-card.js'), 'utf8');
  // URL is not a global inside a fresh vm context, but the browser has it —
  // seed it so safeUrl() behaves like it does in production.
  const sandbox = { URL };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const el = { innerHTML: '' };
  sandbox.renderCardData(card, el);
  return el.innerHTML;
}

const XSS = '<script>alert(1)</script>';

// Spawn a server.js instance on a port and wait until it answers HTTP.
function bootServer(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: 'testpass-123', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    server.stderr.on('data', (d) => { stderr += d; });
    const wait = async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        try {
          const res = await fetch(`http://${HOST}:${port}/`);
          if (res.status === 200) return resolve(server);
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 120));
      }
      reject(new Error(`Server on :${port} failed to start. stderr:\n${stderr}`));
    };
    wait();
  });
}

async function main() {
  // Direct Redis access for cleanup + the daily-limit tests.
  const { Redis } = require('@upstash/redis');
  const adminRedis = Redis.fromEnv();
  const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  // Boot the servers. server2 has no PUBLIC_BASE_URL so the Host-header
  // rejection path and the OG rate limiter can be exercised against it.
  const server = await bootServer(PORT);
  const server2 = await bootServer(PORT2, { PUBLIC_BASE_URL: '', OG_LIMIT: '3' });
  console.log('Servers up. Running tests…\n');

  // ---- POST /api/cards ----
  console.log('── POST /api/cards: validation');

  let r = await post('/api/cards', { name: 'jane doe', age: 28, country: 'Canada',
    role: 'job', roleLabel: 'Engineer', aboutMe: 'hi', mbti: 'INFJ', interests: 'photo',
    favoriteSong: 'Billie Jean', favoriteMovie: 'The Matrix' });
  check('valid card → 201', r.status === 201, `got ${r.status}`);
  check('valid card: name echoed', r.json && r.json.name === 'jane doe');
  check('valid card: age echoed', r.json && r.json.age === 28);
  check('valid card: shareUrl has /card/', r.json && /\/card\/[0-9a-f]{6}$/.test(r.json.shareUrl));
  const okCardId = r.json && r.json.id;

  r = await post('/api/cards', { age: 28 });
  check('missing name → 400', r.status === 400 && r.json.error === 'Name is required.', JSON.stringify(r.json));

  r = await post('/api/cards', { name: '   ', age: 28 });
  check('whitespace-only name → 400', r.status === 400 && r.json.error === 'Name is required.');

  r = await post('/api/cards', { name: 'x' });
  check('missing age → 400', r.status === 400 && r.json.error === 'Age is required.', JSON.stringify(r.json));

  for (const bad of ['abc', 0, -5, 131, 25.5, true]) {
    r = await post('/api/cards', { name: 'x', age: bad });
    check(`age ${JSON.stringify(bad)} → 400`, r.status === 400, `got ${r.status}`);
  }

  r = await post('/api/cards', { name: 'x', age: '25' });
  check('age as numeric string → 201', r.status === 201 && r.json.age === 25, `got ${r.status}`);

  r = await post('/api/cards', { name: 'x', age: 1 });
  check('age 1 (lower bound) → 201', r.status === 201 && r.json.age === 1, `got ${r.status}`);
  r = await post('/api/cards', { name: 'x', age: 130 });
  check('age 130 (upper bound) → 201', r.status === 201 && r.json.age === 130, `got ${r.status}`);

  r = await post('/api/cards', {});
  check('empty body → 400', r.status === 400);

  r = await post('/api/cards', '{"name": "x", "age": '); // malformed JSON
  check('malformed JSON → 400 Invalid JSON body', r.status === 400 && r.json && r.json.error === 'Invalid JSON body.', `got ${r.status} ${r.text.slice(0, 60)}`);

  r = await post('/api/cards', 'not json at all');
  check('non-JSON body → 400', r.status === 400);

  console.log('── POST /api/cards: socials');

  r = await post('/api/cards', { name: 'soc', age: 20, socials: [
    { platform: 'discord', handle: '  spaced  ' },
    { platform: 'discord', handle: 'duplicate' },
    { platform: 'x', handle: '@elon' },
    { platform: 'myspace', handle: 'tom' },
    { platform: 'instagram' },          // no handle → dropped
  ] });
  check('socials: dedup + trim + drop unknown/empty', r.status === 201 &&
    JSON.stringify(r.json.socials) === JSON.stringify([
      { platform: 'discord', handle: 'spaced' },
      { platform: 'x', handle: '@elon' },
    ]), JSON.stringify(r.json && r.json.socials));

  r = await post('/api/cards', { name: 'soc2', age: 20, socials: [{ platform: 'spotify', handle: 'legacy' }] });
  check('socials: spotify dropped', r.status === 201 && Array.isArray(r.json.socials) && r.json.socials.length === 0,
    JSON.stringify(r.json && r.json.socials));

  r = await post('/api/cards', { name: 'soc3', age: 20, socials: 'nope' });
  check('socials: non-array → []', r.status === 201 && Array.isArray(r.json.socials) && r.json.socials.length === 0);

  const longHandle = 'a'.repeat(500);
  r = await post('/api/cards', { name: 'soc4', age: 20, socials: [{ platform: 'x', handle: longHandle }] });
  check('socials: handle sliced to 120', r.status === 201 && r.json.socials[0].handle.length === 120);

  console.log('── POST /api/cards: length limits');

  r = await post('/api/cards', { name: 'a'.repeat(200), age: 20 });
  check('length: name truncated to 100', r.status === 201 && r.json.name.length === 100, `got ${r.status}`);

  r = await post('/api/cards', { name: 'x', age: 20, aboutMe: 'b'.repeat(600) });
  check('length: aboutMe truncated to 500', r.status === 201 && r.json.aboutMe.length === 500);

  r = await post('/api/cards', { name: 'x', age: 20, mbti: 'INFJ'.repeat(4), website: 'https://' + 'c'.repeat(300) });
  check('length: mbti → 10, website → 200', r.status === 201 && r.json.mbti.length === 10 && r.json.website.length === 200);

  r = await post('/api/cards', { name: 'x', age: 20,
    country: 'c'.repeat(150), roleLabel: 'r'.repeat(150), favoriteSong: 's'.repeat(250), favoriteMovie: 'm'.repeat(250) });
  check('length: country/roleLabel → 100, favorites → 200', r.status === 201 &&
    r.json.country.length === 100 && r.json.roleLabel.length === 100 &&
    r.json.favoriteSong.length === 200 && r.json.favoriteMovie.length === 200, JSON.stringify(r.json));

  console.log('── POST /api/cards: backward compatibility');

  r = await post('/api/cards', { name: 'bc1', age: 20, aboutMe: 'new', notes: 'old' });
  check('aboutMe beats notes', r.json.aboutMe === 'new');

  r = await post('/api/cards', { name: 'bc2', age: 20, notes: 'only old' });
  check('notes → aboutMe fallback', r.json.aboutMe === 'only old');

  r = await post('/api/cards', { name: 'bc3', age: 20, favoriteSong: 'Billie Jean', favoriteMusic: 'Thriller' });
  check('favoriteSong beats favoriteMusic', r.json.favoriteSong === 'Billie Jean');

  r = await post('/api/cards', { name: 'bc4', age: 20, favoriteMusic: 'Thriller' });
  check('favoriteMusic → favoriteSong fallback', r.json.favoriteSong === 'Thriller');

  r = await post('/api/cards', { name: 'bc5', age: 20, role: 'student' });
  check('role=student stored', r.json.role === 'student');

  r = await post('/api/cards', { name: 'bc6', age: 20, role: 'weird' });
  check('unknown role → job', r.json.role === 'job');

  r = await post('/api/cards', { name: 'bc7', age: 20, website: 'javascript:alert(1)' });
  check('website stored raw (renderer neutralizes)', r.json.website === 'javascript:alert(1)');

  // ---- GET /api/cards ----
  console.log('── GET /api/cards/:id');

  if (okCardId) {
    r = await get(`/api/cards/${okCardId}`);
    check('existing card → 200 with data', r.status === 200 && r.text.includes('jane doe'));
    check('existing card: no fingerprint leaked', !r.text.includes('fingerprint'));
  }
  r = await get('/api/cards/000000');
  check('missing card → 404 Card not found', r.status === 404 && r.text.includes('Card not found.'));
  r = await get('/api/does-not-exist');
  check('unknown API route → 404 JSON Not found', r.status === 404 && r.text.includes('Not found.'));

  // ---- pages & assets ----
  console.log('── Pages & assets');

  r = await get('/');
  check('home → 200', r.status === 200);
  check('home: label is "Name", not "Full name"', r.text.includes('Name <em>*</em>') && !r.text.includes('Full name'));
  check('home: X input present', r.text.includes('name="social_x"') && r.text.includes('/x.png'));
  check('home: no spotify input', !r.text.includes('social_spotify'));
  check('home: age required', r.text.includes('Age <em>*</em>') && r.text.includes('name="age"'));
  check('home: favorite song', r.text.includes('Favorite song') && r.text.includes('name="favoriteSong"'));
  check('home: more-about-you tiles', r.text.includes('More about you') && (r.text.match(/class="tile">/g) || []).length === 4);
  check('home: all 4 social placeholders are "username"', (r.text.match(/placeholder="username"/g) || []).length === 4);
  check('home: photo dropzone present', r.text.includes('id="photo-drop"') && r.text.includes('id="photo-input"'));
  check('home: shared photo.js loaded', r.text.includes('src="/photo.js"'));
  check('home: daily-limit banner present', r.text.includes('id="limit-banner"'));
  check('home: no bitly anywhere', !r.text.toLowerCase().includes('bitly'));
  check('home: photo field is after name', r.text.indexOf('photo-drop') > r.text.indexOf('name="name"'));

  r = await get('/card/000000');
  check('card page serves (even unknown id) → 200', r.status === 200);
  check('card page: has "Create your own card" → /', r.text.includes('Create your own card') && r.text.includes('href="/"'));

  for (const asset of ['style.css', 'render-card.js', 'photo.js', 'cardy.png', 'discord.png', 'x.png',
    'instagram.png', 'tiktok.png']) {
    r = await get('/' + asset);
    check(`asset ${asset} → 200`, r.status === 200, `got ${r.status}`);
  }

  r = await get('/');
  check('security: CSP header present', (r.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  check('security: no X-Powered-By header', !r.headers.has('x-powered-by'));
  check('security: nosniff header', r.headers.get('x-content-type-options') === 'nosniff');
  check('security: referrer-policy same-origin', r.headers.get('referrer-policy') === 'same-origin');

  // Admin pages refuse framing and caching — that protects the login form
  // from clickjacking and stops stale dashboard copies from being served.
  r = await get('/admin');
  check('admin page: X-Frame-Options DENY when logged out', r.headers.get('x-frame-options') === 'DENY');
  check('admin page: Cache-Control no-store when logged out', (r.headers.get('cache-control') || '').includes('no-store'));
  check('admin page: CSP header present', (r.headers.get('content-security-policy') || '').includes("default-src 'self'"));

  // ---- OG meta tags & image ----
  console.log('── OG meta tags & image');

  // Create a test card to verify OG tags against
  r = await post('/api/cards', {
    name: 'OG Test',
    age: 25,
    country: 'Mars',
    role: 'student',
    roleLabel: 'Space cadet',
    aboutMe: 'I <3 rockets & <script>alert(1)</script>',
    socials: [{ platform: 'discord', handle: 'spaceman' }],
    mbti: 'INTJ',
    favoriteSong: 'Space Oddity',
  });
  const ogCardId = r.json.id;

  r = await get(`/card/${ogCardId}`);
  check('card page with valid card → 200', r.status === 200);
  check('card page: has per-card title', r.text.includes('<title>OG Test — cardy</title>'));
  check('card page: has og:title', r.text.includes('property="og:title"') && r.text.includes('OG Test — cardy'));
  check('card page: has og:description', r.text.includes('property="og:description"'));
  check('card page: has og:url', r.text.includes('property="og:url"') && r.text.includes('/card/' + ogCardId));
  check('card page: has og:image → /og/:id.png', r.text.includes('property="og:image"') && r.text.includes('/og/' + ogCardId + '.png'));
  check('card page: has og:image:width/height', r.text.includes('og:image:width') && r.text.includes('og:image:height'));
  check('card page: has twitter:card', r.text.includes('name="twitter:card"') && r.text.includes('summary_large_image'));
  // The page has its own legit <script> tags, so check the payload is escaped,
  // not that the string "<script>" never appears at all.
  check('card page: XSS escaped in og:description',
    r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !r.text.includes('<script>alert(1)</script>'));

  // OG image endpoint
  r = await get(`/og/${ogCardId}.png`);
  check('/og/:id.png → 200', r.status === 200);
  check('/og/:id.png: Content-Type image/png', r.headers.get('content-type') === 'image/png');
  // PNG magic bytes: 89 50 4e 47 0d 0a 1a 0a
  const pngBytes = r.buf.slice(0, 8);
  check('/og/:id.png: valid PNG magic bytes',
    pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47 &&
    pngBytes[4] === 0x0d && pngBytes[5] === 0x0a && pngBytes[6] === 0x1a && pngBytes[7] === 0x0a,
    `got ${pngBytes.toString('hex')}`);
  check('/og/:id.png: long-lived cache header', (r.headers.get('cache-control') || '').includes('immutable'),
    r.headers.get('cache-control') || '(none)');

  // Unknown card → serves brand image without crashing
  r = await get('/og/000000.png');
  check('/og/unknown → 200 (brand fallback)', r.status === 200);
  check('/og/unknown: Content-Type image/png', r.headers.get('content-type') === 'image/png');
  const brandBytes = r.buf.slice(0, 8);
  check('/og/unknown: valid PNG magic bytes',
    brandBytes[0] === 0x89 && brandBytes[1] === 0x50 && brandBytes[2] === 0x4e && brandBytes[3] === 0x47 &&
    brandBytes[4] === 0x0d && brandBytes[5] === 0x0a && brandBytes[6] === 0x1a && brandBytes[7] === 0x0a);

  // Unknown card page → serves plain shell, no meta tags, no crash
  r = await get('/card/000000');
  check('unknown card page → 200', r.status === 200);
  check('unknown card page: no og tags', !r.text.includes('property="og:title"'));
  check('unknown card page: original title', r.text.includes('<title>cardy — your tiny digital card</title>'));

  // ---- profile photo ----
  console.log('── profile photo');

  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  r = await post('/api/cards', { name: 'photo1', age: 20, photo: TINY_PNG });
  check('photo: valid png stored as-is', r.status === 201 && r.json.photo === TINY_PNG, JSON.stringify(r.json && r.json.photo));

  r = await post('/api/cards', { name: 'photo2', age: 20, photo: 'data:text/html;base64,PHNjcmlwdD4=' });
  check('photo: non-image mime dropped', r.status === 201 && !r.json.photo);

  r = await post('/api/cards', { name: 'photo3', age: 20, photo: 'not a data uri' });
  check('photo: garbage dropped', r.status === 201 && !r.json.photo);

  // A photo near/over the 800KB cap already exceeds the 1MB JSON body limit,
  // so the upload must be rejected outright (413), never accepted.
  r = await post('/api/cards', { name: 'photo4', age: 20, photo: 'data:image/png;base64,' + 'A'.repeat(1100000) });
  check('photo: oversized upload rejected → 413', r.status === 413, `got ${r.status} ${JSON.stringify(r.json)}`);

  r = await post('/api/cards', { name: 'photo5', age: 20, photo: 'data:image/jpeg;base64,' + Buffer.from('fakejpegbytes').toString('base64') });
  check('photo: jpeg accepted', r.status === 201 && /^data:image\/jpeg;base64,/.test(r.json.photo));

  // Sanitizer edge cases: only jpeg/png/webp data URIs survive, everything
  // else (including script-capable svg) is dropped silently.
  r = await post('/api/cards', { name: 'photo svg', age: 20, photo: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') });
  check('photo: svg dropped (no script smuggling)', r.status === 201 && !r.json.photo, JSON.stringify(r.json && r.json.photo));

  r = await post('/api/cards', { name: 'photo gif', age: 20, photo: 'data:image/gif;base64,R0lGODlh' });
  check('photo: gif dropped (not in allowlist)', r.status === 201 && !r.json.photo);

  r = await post('/api/cards', { name: 'photo upper', age: 20, photo: 'data:IMAGE/JPEG;base64,' + Buffer.from('fake').toString('base64') });
  check('photo: uppercase mime normalized to lowercase', r.status === 201 && /^data:image\/jpeg;base64,/.test(r.json.photo), JSON.stringify(r.json && r.json.photo));

  r = await post('/api/cards', { name: 'photo ws', age: 20, photo: '  \n ' + TINY_PNG + '  ' });
  check('photo: surrounding whitespace trimmed', r.status === 201 && r.json.photo === TINY_PNG);

  r = await post('/api/cards', { name: 'photo nl', age: 20, photo: TINY_PNG.replace('CAQAAAC1H', 'CAQAA\nAC1H') });
  check('photo: newline inside base64 re-encoded clean', r.status === 201 && r.json.photo === TINY_PNG, JSON.stringify(r.json && r.json.photo));

  r = await post('/api/cards', { name: 'photo empty', age: 20, photo: '' });
  check('photo: empty string dropped', r.status === 201 && !r.json.photo);

  r = await post('/api/cards', { name: 'photo null', age: 20, photo: null });
  check('photo: null dropped', r.status === 201 && !r.json.photo);

  // A large-but-valid photo (well under the 1MB body limit, over half the
  // photo cap) is stored in full and round-trips byte-for-byte.
  const bigPng = 'data:image/png;base64,' + Buffer.alloc(400000, 7).toString('base64');
  r = await post('/api/cards', { name: 'photo big', age: 20, photo: bigPng });
  check('photo: ~400KB photo accepted byte-for-byte', r.status === 201 && r.json.photo === bigPng, `got ${r.status}`);

  // A photo card must still produce a valid OG image (the photo layout).
  r = await post('/api/cards', { name: 'photo OG', age: 22, photo: TINY_PNG });
  const photoOgId = r.json && r.json.id;
  if (photoOgId) {
    r = await get(`/og/${photoOgId}.png`);
    check('/og/:id.png with photo → 200 PNG', r.status === 200 && r.headers.get('content-type') === 'image/png');
    const pb = r.buf.slice(0, 8);
    check('/og/:id.png with photo: valid PNG magic bytes',
      pb[0] === 0x89 && pb[1] === 0x50 && pb[2] === 0x4e && pb[3] === 0x47 &&
      pb[4] === 0x0d && pb[5] === 0x0a && pb[6] === 0x1a && pb[7] === 0x0a);
  }

  // ---- one card per day + editing ----
  console.log('── one card per day + editing');

  // fetch() keeps no cookie jar, so capture the fingerprint the server issues
  // and replay it so a series of requests looks like the same browser.
  let c = await postWithCookie('/api/cards', { name: 'limit user', age: 30, country: 'Egypt' });
  check('daily: first create → 201 + 16-hex fingerprint cookie',
    c.status === 201 && /^[0-9a-f]{16}$/.test(c.fp), `cookie=${c.cookie.slice(0, 40)}`);
  const fp = c.fp;
  const limitCardId = c.json && c.json.id;
  check('daily: response never exposes fingerprint', !('fingerprint' in (c.json || {})));

  r = await postWithCookie('/api/cards', { name: 'second try', age: 31 }, 'cardy_fp=' + fp);
  check('daily: same browser second card → 429 limit', r.status === 429 && r.json.error === 'limit', `got ${r.status} ${JSON.stringify(r.json)}`);
  check('daily: 429 returns the existing card', r.json && r.json.card && r.json.card.id === limitCardId);

  let dl = JSON.parse((await get('/api/daily-limit')).text);
  check('daily-limit: fresh browser not limited', dl.limited === false);

  dl = JSON.parse((await get('/api/daily-limit', { Cookie: 'cardy_fp=' + fp })).text);
  check('daily-limit: created browser is limited', dl.limited === true);
  check('daily-limit: returns the created card', Array.isArray(dl.cards) && dl.cards.some((card) => card.id === limitCardId));
  check('daily-limit: cards never expose fingerprint', Array.isArray(dl.cards) && dl.cards.every((card) => !('fingerprint' in card)));

  // Editing bypasses the daily limit, but only for the card's own browser.
  r = await postWithCookie('/api/cards',
    { name: 'limit user', age: 30, country: 'Egypt', aboutMe: 'edited!', _editId: limitCardId },
    'cardy_fp=' + fp);
  check('edit: same browser → 200 updated, same id', r.status === 200 && r.json.aboutMe === 'edited!' && r.json.id === limitCardId,
    `got ${r.status} ${JSON.stringify(r.json)}`);
  check('edit: response never exposes fingerprint', !('fingerprint' in (r.json || {})));

  // Attach a photo through the edit flow, then confirm it persists publicly.
  r = await postWithCookie('/api/cards',
    { name: 'limit user', age: 30, country: 'Egypt', aboutMe: 'edited!', photo: TINY_PNG, _editId: limitCardId },
    'cardy_fp=' + fp);
  check('edit: photo saved', r.status === 200 && r.json.photo === TINY_PNG);
  r = await get('/api/cards/' + limitCardId);
  check('edit: photo visible via public GET', r.status === 200 && r.text.includes('data:image/png;base64,'));
  check('public GET: no fingerprint leaked', r.status === 200 && !r.text.includes('fingerprint'));

  // The edit flow can remove the photo too — an explicit null or empty string
  // both mean "no photo", and the change shows up on the public API.
  r = await postWithCookie('/api/cards',
    { name: 'limit user', age: 30, country: 'Egypt', aboutMe: 'edited!', photo: TINY_PNG, _editId: limitCardId },
    'cardy_fp=' + fp);
  check('edit: photo re-attached', r.status === 200 && r.json.photo === TINY_PNG, `got ${r.status}`);
  r = await postWithCookie('/api/cards',
    { name: 'limit user', age: 30, country: 'Egypt', aboutMe: 'edited!', photo: null, _editId: limitCardId },
    'cardy_fp=' + fp);
  check('edit: photo removed via photo:null', r.status === 200 && !r.json.photo, `got ${r.status}`);
  r = await get('/api/cards/' + limitCardId);
  check('edit: removed photo gone from public GET', r.status === 200 && !r.text.includes('data:image/png;base64,'));
  r = await postWithCookie('/api/cards',
    { name: 'limit user', age: 30, country: 'Egypt', aboutMe: 'edited!', photo: TINY_PNG, _editId: limitCardId },
    'cardy_fp=' + fp);
  r = await postWithCookie('/api/cards',
    { name: 'limit user', age: 30, country: 'Egypt', aboutMe: 'edited!', photo: '', _editId: limitCardId },
    'cardy_fp=' + fp);
  check('edit: photo removed via photo:""', r.status === 200 && !r.json.photo, `got ${r.status}`);

  // A stranger's browser (no cookie) cannot edit this card.
  r = await postWithCookie('/api/cards', { name: 'hacker', age: 99, _editId: limitCardId });
  check('edit: different browser → 403', r.status === 403);

  r = await postWithCookie('/api/cards', { name: 'x', age: 10, _editId: '000000' }, 'cardy_fp=' + fp);
  check('edit: unknown id → 404', r.status === 404);

  r = await post('/api/cards', { name: 'x', age: 20, _editId: 'nothex!' });
  check('edit: malformed _editId → 400', r.status === 400 && r.json.error === 'Invalid card id.', `got ${r.status} ${JSON.stringify(r.json)}`);

  // Simulate the next day by clearing today's limit key, then create a second
  // card in the same browser and confirm the banner can list both cards.
  const today = new Date().toISOString().slice(0, 10);
  await adminRedis.del('cardy:daily:' + fp + ':' + today);
  r = await postWithCookie('/api/cards', { name: 'second day', age: 32 }, 'cardy_fp=' + fp);
  check('daily: next-day create → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.json)}`);
  const secondDayId = r.json && r.json.id;

  dl = JSON.parse((await get('/api/daily-limit', { Cookie: 'cardy_fp=' + fp })).text);
  check('daily-limit: lists all cards across days',
    dl.limited === true && Array.isArray(dl.cards) && dl.cards.length === 2 &&
    dl.cards.some((card) => card.id === limitCardId) && dl.cards.some((card) => card.id === secondDayId),
    JSON.stringify((dl.cards || []).map((card) => card.id)));
  // Remove the per-browser index so nothing lingers in Redis.
  await adminRedis.del('cardy:fp:' + fp);

  // ---- renderer ----
  console.log('── render-card.js');

  let html = render({ name: 'jane doe', role: 'job', roleLabel: 'Engineer', age: 28, country: 'Canada',
    aboutMe: 'hi there', socials: [{ platform: 'x', handle: '@elon' }, { platform: 'discord', handle: 'spaced' }],
    website: 'example.com', mbti: 'INFJ', interests: 'photo', favoriteSong: 'Billie Jean', favoriteMovie: 'The Matrix' });
  check('full card: name + role + meta', html.includes('jane doe') && html.includes('Engineer') && html.includes('Canada'));
  check('full card: about me section', html.includes('About me') && html.includes('hi there'));
  check('full card: social section', html.includes('Social') && html.includes('@elon'));
  check('full card: x icon used', html.includes('/x.png'));
  check('full card: website link (no scheme → https)', html.includes('href="https://example.com/"'));
  check('full card: personality / interests', html.includes('INFJ') && html.includes('photo'));
  check('full card: favorite song + movie', html.includes('Billie Jean') && html.includes('The Matrix'));

  html = render({ name: XSS, aboutMe: XSS, mbti: XSS, interests: XSS, favoriteSong: XSS, favoriteMovie: XSS,
    socials: [{ platform: 'x', handle: XSS }] });
  check('XSS: all fields escaped', !html.includes('<script>') && (html.match(/&lt;script&gt;/g) || []).length >= 6);

  html = render({ name: 'n', website: 'javascript:alert(1)' });
  check('XSS: javascript: website has no href', !html.includes('href="javascript:') && !html.includes('<script>'));

  html = render({ name: 'legacy', favoriteMusic: 'Thriller' });
  check('legacy favoriteMusic → "Favorite song"', html.includes('Favorite song') && html.includes('Thriller'));

  html = render({ name: 'legacy', socials: [{ platform: 'spotify', handle: 'olduser' }] });
  check('unknown platform (spotify) renders without an icon', !html.includes('/spotify.png') && html.includes('olduser'));
  check('no verified badge anywhere', !html.includes('badge') && !html.includes('Verified'));

  html = render({});
  check('empty card: safe fallbacks, no crash', html.includes('Your name') && !html.includes('undefined'));

  html = render({ name: 'x', socials: [] });
  check('empty socials → no Social section', !html.includes('Social'));

  html = render({ name: 'photo', photo: TINY_PNG });
  check('renderer: photo renders as circular img', html.includes('class="card-photo"') && html.includes('data:image/png;base64,'));

  html = render({ name: 'photo', photo: 'data:image/png;base64,abc" onerror="alert(1)' });
  check('renderer: photo src escaped, no attribute breakout',
    html.includes('src="data:image/png;base64,abc&quot; onerror=&quot;alert(1)"') && !html.includes('" onerror="'),
    html.slice(0, 160));

  html = render({ name: 'plain' });
  check('renderer: no photo → no card-photo img', !html.includes('card-photo'));

  // ---- public/photo.js: ratio-preserving resize + file reading ----
  console.log('── photo.js resize');
  const photoCode = fs.readFileSync(path.join(__dirname, 'public', 'photo.js'), 'utf8');

  // A fresh fake DOM for photo.js. document.createElement('canvas') returns a
  // canvas that records its size and serialises it into a fake JPEG data URI,
  // so we can assert exactly what dimensions the resize chose.
  function photoSandbox() {
    let canvas = null;
    const sandbox = {
      document: {
        createElement: (tag) => {
          if (tag !== 'canvas') return {};
          canvas = {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: () => {} }),
            toDataURL: (type) => 'data:' + type + ';base64,' + canvas.width + 'x' + canvas.height,
          };
          return canvas;
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(photoCode, sandbox);
    return { sandbox, canvas: () => canvas };
  }

  function resizeDims(w, h) {
    const env = photoSandbox();
    env.sandbox.resizeToDataUri({ width: w, height: h }, 400);
    return env.canvas();
  }

  let dims = resizeDims(1200, 600);
  check('photo resize: landscape 1200×600 → 400×200', dims.width === 400 && dims.height === 200, JSON.stringify(dims));
  dims = resizeDims(600, 1200);
  check('photo resize: portrait 600×1200 → 200×400', dims.width === 200 && dims.height === 400, JSON.stringify(dims));
  dims = resizeDims(800, 800);
  check('photo resize: square 800×800 → 400×400', dims.width === 400 && dims.height === 400, JSON.stringify(dims));
  dims = resizeDims(200, 100);
  check('photo resize: small image never upscaled (200×100)', dims.width === 200 && dims.height === 100, JSON.stringify(dims));
  dims = resizeDims(3, 4);
  check('photo resize: tiny image kept (3×4)', dims.width === 3 && dims.height === 4, JSON.stringify(dims));
  dims = resizeDims(400, 300);
  check('photo resize: exactly at cap unchanged (400×300)', dims.width === 400 && dims.height === 300, JSON.stringify(dims));
  dims = resizeDims(4000, 200);
  check('photo resize: very wide 4000×200 → 400×20', dims.width === 400 && dims.height === 20, JSON.stringify(dims));
  dims = resizeDims(200, 4000);
  check('photo resize: very tall 200×4000 → 20×400', dims.width === 20 && dims.height === 400, JSON.stringify(dims));
  dims = resizeDims(1000, 999);
  check('photo resize: ratio kept through rounding (1000×999 → 400×400)', dims.width === 400 && dims.height === 400, JSON.stringify(dims));
  dims = resizeDims(0, 0);
  check('photo resize: degenerate 0×0 doesn’t crash → 1×1', dims.width === 1 && dims.height === 1, JSON.stringify(dims));
  {
    const env = photoSandbox();
    const uri = env.sandbox.resizeToDataUri({ width: 100, height: 50 }, 400);
    check('photo resize: output is a jpeg data uri', /^data:image\/jpeg;base64,/.test(uri), uri);
  }

  // readPhotoFile end-to-end with a fake Image (src assignment fires onload)
  // and a fake FileReader.
  function photoIoSandbox(imgW, imgH) {
    const env = photoSandbox();
    function FakeImage() { this.width = imgW; this.height = imgH; this.onload = null; }
    Object.defineProperty(FakeImage.prototype, 'src', {
      get: function () { return this._src; },
      set: function (v) { this._src = v; if (this.onload) this.onload(); },
    });
    function FakeReader() {}
    FakeReader.prototype.readAsDataURL = function () {
      this.result = 'data:image/png;base64,zzz';
      this.onload();
    };
    env.sandbox.Image = FakeImage;
    env.sandbox.FileReader = FakeReader;
    return env;
  }

  {
    const env = photoIoSandbox(1600, 800);
    let got = 'NOT CALLED';
    env.sandbox.readPhotoFile({ type: 'image/jpeg' }, (uri) => { got = uri; });
    check('photo read: image file resized through callback', got === 'data:image/jpeg;base64,400x200', got);
  }
  {
    const env = photoIoSandbox(100, 50);
    let got = 'NOT CALLED';
    env.sandbox.readPhotoFile({ type: 'text/plain' }, (uri) => { got = uri; });
    check('photo read: non-image file type ignored', got === 'NOT CALLED', got);
  }
  {
    const env = photoIoSandbox(100, 50);
    let got = 'NOT CALLED';
    env.sandbox.readPhotoFile(null, (uri) => { got = uri; });
    check('photo read: null file ignored', got === 'NOT CALLED', got);
  }
  {
    const env = photoIoSandbox(100, 50);
    let got = 'NOT CALLED';
    env.sandbox.readPhotoFile({ type: 'image/png' }, (uri) => { got = uri; });
    check('photo read: small image passed through uncropped', got === 'data:image/jpeg;base64,100x50', got);
  }

  // ---- admin dashboard ----
  console.log('── Admin dashboard');

  const ADMIN_PASS = 'testpass-123';

  // Make admin state deterministic: force the runtime password hash (backing
  // up anything already stored so we can restore it), and clear any stale
  // per-IP login lockout left by a crashed earlier run.
  const prevPassHash = await adminRedis.get('cardy:admin:passhash');
  await adminRedis.del('cardy:admin:login::ffff:127.0.0.1');
  await adminRedis.del('cardy:admin:login:127.0.0.1');
  await adminRedis.set('cardy:admin:passhash', sha256(ADMIN_PASS));

  try {
    // The login-lock key is keyed by whatever IP string Express derives, so
    // clear them all by scanning rather than guessing the IP.
    async function clearLoginLocks() {
      let cursor = 0;
      do {
        const [next, keys] = await adminRedis.scan(cursor, { match: 'cardy:admin:login:*', count: 200 });
        if (keys.length) await adminRedis.del(...keys);
        cursor = Number(next) || 0;
      } while (cursor !== 0);
    }
    await clearLoginLocks();

    async function adminLogin(pw) {
      const res = await fetch(BASE + '/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const sc = res.headers.get('set-cookie') || '';
      const token = (sc.match(/cardy_admin=([^;]+)/) || [])[1] || '';
      return { status: res.status, token, cookie: sc };
    }

    async function adminReq(token, method, url, body, csrf) {
      const headers = {};
      if (token) headers.Cookie = 'cardy_admin=' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(BASE + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, headers: res.headers };
    }

    r = await get('/admin');
    check('admin: /admin shows sign-in when logged out', r.status === 200 && r.text.includes('Admin sign in'));

    let login = await adminLogin('wrong-password');
    check('admin: wrong password → 401', login.status === 401);

    login = await adminLogin(ADMIN_PASS);
    check('admin: correct password → 200 + session cookie', login.status === 200 && login.token.length > 10);
    check('admin: cookie is httpOnly + sameSite=strict', /HttpOnly/i.test(login.cookie) && /SameSite=Strict/i.test(login.cookie));

    r = await adminReq(login.token, 'GET', '/admin');
    check('admin: /admin serves the dashboard when logged in', r.status === 200 && r.text.includes('cards-list'));
    check('admin: edit modal has photo dropzone + shared photo.js',
      r.text.includes('admin-photo-drop') && r.text.includes('src="/photo.js"'), 'photo markup missing');
    check('admin: dashboard X-Frame-Options DENY', r.headers.get('x-frame-options') === 'DENY');
    check('admin: dashboard Cache-Control no-store', (r.headers.get('cache-control') || '').includes('no-store'));

    r = await adminReq(null, 'GET', '/admin/api/cards');
    check('admin: unauthenticated list → 401', r.status === 401);

    // The dashboard shell is gated server-side too — no session, no shell.
    // (redirect: 'manual' so fetch doesn't follow the 302 to the login page.)
    {
      const shell = await fetch(BASE + '/admin.html', { redirect: 'manual' });
      check('admin: /admin.html redirects to the gate when logged out',
        (shell.status === 301 || shell.status === 302) && shell.headers.get('location') === '/admin',
        `got ${shell.status} ${shell.headers.get('location')}`);
    }

    // Every admin route — read or mutation — rejects an unauthenticated caller.
    for (const [m, u, body] of [
      ['GET', '/admin/api/cards/000000', undefined],
      ['POST', '/admin/api/cards', { name: 'x', age: 20 }],
      ['PATCH', '/admin/api/cards/000000', { name: 'x', age: 20 }],
      ['DELETE', '/admin/api/cards/000000', undefined],
      ['POST', '/admin/api/password', { currentPassword: 'x', password: 'newpass123' }],
      ['POST', '/admin/logout', undefined],
    ]) {
      r = await adminReq(null, m, u, body);
      check(`admin: unauth ${m} ${u} → 401`, r.status === 401, `got ${r.status}`);
    }

    r = await adminReq(login.token, 'GET', '/admin/api/me');
    check('admin: /api/me → 200 with csrf', r.status === 200 && typeof r.json.csrf === 'string' && r.json.csrf.length >= 16);
    let csrf = r.json.csrf;

    // Two fresh logins must yield different, unguessable session tokens.
    const secondLogin = await adminLogin(ADMIN_PASS);
    check('admin: distinct session tokens across logins', !!secondLogin.token && secondLogin.token !== login.token);

    // CSRF is required on every mutation, not just PATCH.
    r = await adminReq(login.token, 'POST', '/admin/api/cards', { name: 'x', age: 20 });
    check('admin: POST without csrf → 403', r.status === 403);
    r = await adminReq(login.token, 'DELETE', '/admin/api/cards/000000');
    check('admin: DELETE without csrf → 403', r.status === 403);

    r = await adminReq(login.token, 'GET', '/admin/api/cards');
    check('admin: list cards → 200 array', r.status === 200 && Array.isArray(r.json));
    check('admin: list is not empty', Array.isArray(r.json) && r.json.length > 0);
    check('admin: owner card present with owner flag', Array.isArray(r.json) &&
      r.json.some((c) => c.name === 'Costa' && c.owner === true));

    r = await adminReq(login.token, 'POST', '/admin/api/cards',
      { name: 'admin test', age: 33, country: 'Egypt', owner: true, socials: [{ platform: 'x', handle: '@admin' }] }, csrf);
    check('admin: create card → 201', r.status === 201);
    check('admin: create honors owner flag', r.json && r.json.owner === true);
    const adminCardId = r.json && r.json.id;

    r = await adminReq(login.token, 'GET', '/admin/api/cards');
    check('admin: list strips fingerprint', !r.text.includes('fingerprint'));
    r = await adminReq(login.token, 'GET', '/admin/api/cards/' + adminCardId);
    check('admin: detail strips fingerprint', !r.text.includes('fingerprint'));

    r = await adminReq(login.token, 'GET', '/admin/api/cards/000000');
    check('admin: detail missing card → 404', r.status === 404, `got ${r.status}`);

    r = await adminReq(login.token, 'GET', '/admin/api/cards');
    check('admin: created card appears in list', r.status === 200 && Array.isArray(r.json) &&
      r.json.some((c) => c.id === adminCardId && c.name === 'admin test'));

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + adminCardId, { name: 'admin test', age: 33 });
    check('admin: mutation without csrf → 403', r.status === 403);

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + adminCardId,
      { name: 'admin test', age: 34, country: 'Egypt', owner: false, socials: [{ platform: 'x', handle: '@admin' }] }, csrf);
    check('admin: edit card → age updated, owner off', r.status === 200 && r.json.age === 34 && r.json.owner === false);

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + adminCardId,
      { name: 'admin test', age: 34, country: 'Egypt', owner: true, socials: [{ platform: 'x', handle: '@admin' }] }, csrf);
    check('admin: owner back on', r.status === 200 && r.json.owner === true);
    check('admin: PATCH response strips fingerprint', !r.text.includes('fingerprint'));

    r = await get('/api/cards/' + adminCardId);
    check('admin: edited card visible publicly with owner', r.status === 200 && r.text.includes('"owner":true'));

    html = render({ name: 'Costa', age: 17, owner: true });
    check('renderer: owner card shows gold badge', html.includes('owner-badge') && html.includes('Owner'));
    html = render({ name: 'Costa', age: 17 });
    check('renderer: normal card has no owner badge', !html.includes('owner-badge'));

    r = await post('/api/cards', { name: 'public owner probe', age: 22, owner: true });
    check('public POST cannot mark owner', r.status === 201 && !('owner' in r.json));
    const publicProbeId = r.json && r.json.id;

    r = await adminReq(login.token, 'POST', '/admin/api/cards', { name: 'x', age: 200 }, csrf);
    check('admin: age 200 → 400', r.status === 400 && r.json.error === 'Age must be a whole number between 1 and 130.');

    r = await adminReq(login.token, 'DELETE', '/admin/api/cards/' + adminCardId, undefined, csrf);
    check('admin: delete card → 200', r.status === 200);
    r = await get('/api/cards/' + adminCardId);
    check('admin: deleted card gone → 404', r.status === 404);

    // bulk multi-select delete
    const bulkIds = [];
    for (let i = 0; i < 3; i++) {
      const cr = await adminReq(login.token, 'POST', '/admin/api/cards', { name: 'bulk test ' + i, age: 20 + i }, csrf);
      if (cr.status === 201) bulkIds.push(cr.json.id);
    }
    check('admin: bulk setup — 3 cards created', bulkIds.length === 3, JSON.stringify(bulkIds));

    r = await adminReq(login.token, 'POST', '/admin/api/cards/bulk-delete', { ids: ['nothex', ...bulkIds.slice(0, 2)] }, csrf);
    check('admin: bulk-delete skips bad ids, deletes 2', r.status === 200 && r.json.deleted === 2, JSON.stringify(r.json));

    r = await adminReq(login.token, 'POST', '/admin/api/cards/bulk-delete', { ids: bulkIds.slice(0, 2) }, csrf);
    check('admin: bulk-delete idempotent → 0 deleted', r.status === 200 && r.json.deleted === 0, JSON.stringify(r.json));

    r = await adminReq(login.token, 'POST', '/admin/api/cards/bulk-delete', { ids: [] }, csrf);
    check('admin: bulk-delete empty ids → 400', r.status === 400);

    r = await adminReq(login.token, 'POST', '/admin/api/cards/bulk-delete', { ids: ['zzzzzz'] }, csrf);
    check('admin: bulk-delete all-invalid ids → 400', r.status === 400);

    r = await adminReq(login.token, 'POST', '/admin/api/cards/bulk-delete', { ids: [bulkIds[2]] });
    check('admin: bulk-delete without csrf → 403', r.status === 403);

    r = await adminReq(login.token, 'GET', '/admin/api/cards');
    check('admin: bulk-deleted cards gone, survivor remains',
      r.status === 200 &&
      !r.json.some((c) => bulkIds.slice(0, 2).includes(c.id)) &&
      r.json.some((c) => c.id === bulkIds[2]),
      'missing survivor: ' + (bulkIds[2] || 'none'));
    if (bulkIds[2]) await adminReq(login.token, 'DELETE', '/admin/api/cards/' + bulkIds[2], undefined, csrf);

    if (publicProbeId) await adminReq(login.token, 'DELETE', '/admin/api/cards/' + publicProbeId, undefined, csrf);

    // change password flow
    r = await adminReq(login.token, 'POST', '/admin/api/password', { currentPassword: 'nope', password: 'newpass123' }, csrf);
    check('admin: change password rejects wrong current → 401', r.status === 401);

    r = await adminReq(login.token, 'POST', '/admin/api/password', { currentPassword: ADMIN_PASS, password: 'newpass123' }, csrf);
    check('admin: change password → 200', r.status === 200);

    login = await adminLogin('newpass123');
    check('admin: login with new password → 200', login.status === 200 && !!login.token);
    login = await adminLogin(ADMIN_PASS);
    check('admin: old password rejected → 401', login.status === 401);

    // restore the runtime password now, so the lockout test below uses ADMIN_PASS
    if (prevPassHash) await adminRedis.set('cardy:admin:passhash', prevPassHash);
    else await adminRedis.del('cardy:admin:passhash');

    // lockout after too many failures; unlock, then a correct login succeeds
    await clearLoginLocks();
    let last = null;
    for (let i = 0; i < 10; i++) last = await adminLogin('bruteforce-' + i);
    check('admin: 10th wrong attempt still 401', last.status === 401);
    last = await adminLogin('bruteforce-final');
    check('admin: locked out → 429', last.status === 429);
    await clearLoginLocks();

    login = await adminLogin(ADMIN_PASS);
    check('admin: correct login works once unlocked', login.status === 200 && !!login.token);
    const me2 = await adminReq(login.token, 'GET', '/admin/api/me'); // new session → new CSRF
    csrf = me2.json.csrf;

    // Admins bypass the one-per-day limit on the public form (session cookie).
    let ac = await postWithCookie('/api/cards', { name: 'admin public1', age: 20 }, 'cardy_admin=' + login.token);
    check('admin bypass: first public card → 201', ac.status === 201, `got ${ac.status}`);
    const adminFp = ac.fp;
    const adminPublic1 = ac.json && ac.json.id;
    ac = await postWithCookie('/api/cards', { name: 'admin public2', age: 21 }, 'cardy_admin=' + login.token + '; cardy_fp=' + adminFp);
    check('admin bypass: second card same day → 201', ac.status === 201, `got ${ac.status}`);
    check('admin bypass: distinct ids', ac.json && ac.json.id !== adminPublic1, `${adminPublic1} vs ${ac.json && ac.json.id}`);
    let dlAdmin = JSON.parse((await get('/api/daily-limit', { Cookie: 'cardy_admin=' + login.token + '; cardy_fp=' + adminFp })).text);
    check('admin bypass: daily-limit reports limited:false', dlAdmin.limited === false, JSON.stringify(dlAdmin));
    await adminRedis.del('cardy:fp:' + adminFp);

    // Admin photo editing: create with a photo, replace it, remove it, and
    // confirm an absent/blank photo field behaves the right way.
    const PHOTO_A = 'data:image/jpeg;base64,' + Buffer.from('photo-a-bytes').toString('base64');
    const PHOTO_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    let photoCardId = null;
    r = await adminReq(login.token, 'POST', '/admin/api/cards', { name: 'photo admin', age: 25, photo: PHOTO_A }, csrf);
    check('admin photo: create with photo → 201 + stored', r.status === 201 && r.json.photo === PHOTO_A, JSON.stringify(r.json));
    photoCardId = r.json && r.json.id;
    check('admin photo: create response strips fingerprint', photoCardId && !r.text.includes('fingerprint'));

    // PATCH bodies carry the whole card (the dashboard always sends every
    // field), so each test body starts from the full card and overrides it.
    const fullPatch = (over) => ({ name: 'photo admin', age: 25, ...(over || {}) });

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: PHOTO_B }), csrf);
    check('admin photo: PATCH replaces photo', r.status === 200 && r.json.photo === PHOTO_B, JSON.stringify(r.json));

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch(), csrf);
    check('admin photo: PATCH without photo keeps it', r.status === 200 && r.json.photo === PHOTO_B, JSON.stringify(r.json));

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: null }), csrf);
    check('admin photo: PATCH photo:null removes it', r.status === 200 && !r.json.photo, JSON.stringify(r.json));

    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: PHOTO_B }), csrf);
    check('admin photo: photo re-added', r.status === 200 && r.json.photo === PHOTO_B, JSON.stringify(r.json));
    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: '' }), csrf);
    check('admin photo: PATCH photo:"" removes it', r.status === 200 && !r.json.photo, JSON.stringify(r.json));

    // A malformed photo is ignored — the existing photo survives untouched.
    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: PHOTO_B }), csrf);
    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: 'garbage not a data uri' }), csrf);
    check('admin photo: invalid photo keeps existing', r.status === 200 && r.json.photo === PHOTO_B, JSON.stringify(r.json));

    // Removal is visible on the public API, and the OG renderer falls back.
    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/' + photoCardId, fullPatch({ photo: null }), csrf);
    check('admin photo: final remove before public checks', r.status === 200 && !r.json.photo, JSON.stringify(r.json));
    r = await get('/api/cards/' + photoCardId);
    check('admin photo: public GET reflects removed photo', r.status === 200 && !r.text.includes('data:image/'), `got ${r.status}`);
    r = await get('/og/' + photoCardId + '.png');
    check('admin photo: OG renders after photo removed', r.status === 200 && r.headers.get('content-type') === 'image/png', `got ${r.status}`);

    // PATCHing a card that doesn't exist still 404s.
    r = await adminReq(login.token, 'PATCH', '/admin/api/cards/000000', fullPatch({ photo: PHOTO_A }), csrf);
    check('admin photo: PATCH missing card → 404', r.status === 404, `got ${r.status}`);

    if (photoCardId) await adminReq(login.token, 'DELETE', '/admin/api/cards/' + photoCardId, undefined, csrf);

    // A legacy sha-256 hash still verifies, and upgrades to scrypt in place.
    await adminRedis.set('cardy:admin:passhash', sha256('migrate-pass'));
    let mlogin = await adminLogin('migrate-pass');
    check('migration: legacy sha256 login succeeds', mlogin.status === 200 && !!mlogin.token, `got ${mlogin.status}`);
    const migrated = await adminRedis.get('cardy:admin:passhash');
    check('migration: hash upgraded to scrypt (salt:hash)', typeof migrated === 'string' && migrated.includes(':'), JSON.stringify(migrated));
    mlogin = await adminLogin('migrate-pass');
    check('migration: scrypt hash still verifies', mlogin.status === 200, `got ${mlogin.status}`);
    mlogin = await adminLogin('migrate-pass-wrong');
    check('migration: wrong password rejected after upgrade', mlogin.status === 401, `got ${mlogin.status}`);

    // logout invalidates the session
    r = await adminReq(login.token, 'POST', '/admin/logout', undefined, csrf);
    check('admin: logout → 200', r.status === 200);
    r = await adminReq(login.token, 'GET', '/admin/api/me');
    check('admin: session invalid after logout → 401', r.status === 401);
  } finally {
    // Restore the real admin password hash (deleting the key → env fallback).
    if (prevPassHash) await adminRedis.set('cardy:admin:passhash', prevPassHash);
    else await adminRedis.del('cardy:admin:passhash');
  }

  // ---- og-image.js: the SVG that becomes each card's link preview ----
  console.log('── og-image.js');

  const { cardSvg } = require('./og-image');
  {
    const svg = cardSvg(null);
    check('og svg: brand fallback renders', svg.includes('<svg') && svg.includes('your tiny digital card'));
  }
  {
    const svg = cardSvg({ name: 'a<b&c', age: 20, role: 'job' });
    check('og svg: name XML-escaped', svg.includes('a&lt;b&amp;c') && !svg.includes('a<b'));
  }
  {
    const svg = cardSvg({ name: 'Student Card', age: 20, role: 'student', roleLabel: 'CS', aboutMe: 'hi' });
    check('og svg: minimal layout (no photo)', svg.includes('text-anchor="middle"') && svg.includes('CS'));
    check('og svg: no pfp clip without photo', !svg.includes('clipPath'));
  }
  {
    const svg = cardSvg({ name: 'With Photo', age: 20, role: 'job', roleLabel: 'Dev', aboutMe: 'hello',
      photo: TINY_PNG, socials: [{ platform: 'x', handle: '@spaceman' }] });
    check('og svg: photo layout has pfp clip', svg.includes('clipPath id="pfp"'));
    check('og svg: photo embedded as data uri', svg.includes(TINY_PNG.slice(0, 30)));
    check('og svg: social pill rendered', svg.includes('@spaceman'));
  }
  {
    // A long owner name must not shove the Owner badge past the card's right
    // edge (inner right edge is x=940).
    const svg = cardSvg({ name: 'Very Long Owner Name Here', age: 30, role: 'job', owner: true, photo: TINY_PNG });
    const m = svg.match(/<rect x="(\d+)" y="222" width="86"/);
    const badgeX = m ? Number(m[1]) : 9999;
    check('og svg: owner badge fits inside card (x+86 ≤ 940)', badgeX + 86 <= 940, `badge at ${badgeX}`);
  }

  // ---- Host header hardening + OG rate limiting (server2, no PUBLIC_BASE_URL) ----
  console.log('── Host header + OG rate limit');

  // A malicious Host header must never poison a share URL.
  let hr = await rawPost(PORT2, '/api/cards', 'evil.example', { name: 'host evil', age: 20 });
  check('host: malicious Host rejected → 500 + clear error',
    hr.status === 500 && /PUBLIC_BASE_URL/.test(hr.json.error || ''), `got ${hr.status} ${hr.text}`);

  // A loopback Host builds the share URL from the actual host.
  let r2 = await postWithCookieOn(BASE2, '/api/cards', { name: 'host ok', age: 20 });
  check('host: localhost Host builds shareUrl from host',
    r2.status === 201 && /^http:\/\/127\.0\.0\.1:4124\/card\/[0-9a-f]{6}$/.test(r2.json.shareUrl), JSON.stringify(r2.json));
  if (r2.fp) {
    await adminRedis.del('cardy:fp:' + r2.fp);
    await adminRedis.del('cardy:daily:' + r2.fp + ':' + new Date().toISOString().slice(0, 10));
  }

  // The OG renderer is capped per IP. server2 runs with OG_LIMIT=3 so a burst
  // of a few renders finishes well inside the window no matter how slow the
  // machine is; the limit logic being exercised is identical to production's.
  for (let i = 0; i < 3; i++) {
    const og = await getOn(BASE2, '/og/000000.png');
    if (i === 2) check('og: 3rd request within a minute → 200 PNG', og.status === 200, `got ${og.status}`);
  }
  const og4 = await getOn(BASE2, '/og/000000.png');
  check('og: 4th request within a minute → 429', og4.status === 429, `got ${og4.status}`);

  // Cleanup: delete every card this run created (never touch the owner).
  const ids = [...createdCardIds];
  for (let i = 0; i < ids.length; i += 100) {
    await adminRedis.del(...ids.slice(i, i + 100).map((id) => 'cardy:card:' + id));
  }
  // The owner card (Costa) must still be present and marked owner, and none of
  // our test-created cards may remain.
  const remaining = (await adminRedis.scan(0, { match: 'cardy:card:*', count: 500 }))[1];
  let leftCards = [];
  if (remaining.length) {
    const vals = await adminRedis.mget(...remaining);
    leftCards = remaining
      .map((k, i) => (vals[i] ? { key: k, ...vals[i] } : null))
      .filter(Boolean);
  }
  const ownerCard = leftCards.find((c) => c.owner === true);
  const noTestLeftovers = !leftCards.some((c) => createdCardIds.has(c.key.slice('cardy:card:'.length)));
  check('cleanup: owner card intact, no test cards left',
    !!ownerCard && ownerCard.name === 'Costa' && ownerCard.owner === true && noTestLeftovers,
    'cards: ' + JSON.stringify(leftCards.map((c) => ({ id: c.key.slice(13), name: c.name, owner: c.owner }))));

  server2.kill('SIGTERM');
  server.kill('SIGTERM');
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
