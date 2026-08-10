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

require('dotenv').config({ quiet: true }); // load UPSTASH/REDIS env for the test process too

const HOST = '127.0.0.1';
const PORT = 4123;
const BASE = `http://${HOST}:${PORT}`;

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

async function post(url, body) {
  const res = await fetch(BASE + url, {
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

async function get(url) {
  const res = await fetch(BASE + url);
  return { status: res.status, text: await res.text() };
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

async function main() {
  // Boot the server.
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'testpass-123' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });

  const ready = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        const res = await fetch(BASE + '/');
        if (res.status === 200) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  })();

  if (!ready) {
    console.error('Server failed to start. stderr:\n' + stderr);
    server.kill('SIGTERM');
    process.exit(1);
  }
  console.log('Server up. Running tests…\n');

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

  r = await get('/card/000000');
  check('card page serves (even unknown id) → 200', r.status === 200);
  check('card page: has "Create your own card" → /', r.text.includes('Create your own card') && r.text.includes('href="/"'));

  for (const asset of ['style.css', 'render-card.js', 'cardy.png', 'discord.png', 'x.png',
    'instagram.png', 'tiktok.png']) {
    r = await get('/' + asset);
    check(`asset ${asset} → 200`, r.status === 200, `got ${r.status}`);
  }

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

  // ---- admin dashboard ----
  console.log('── Admin dashboard');

  const ADMIN_PASS = 'testpass-123';
  const { Redis } = require('@upstash/redis');
  const adminRedis = Redis.fromEnv();
  const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

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
      return { status: res.status, json, text };
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
