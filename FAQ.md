# cardy — FAQ & Guide

## What is cardy?

A tiny digital card app. You fill out a short form (name, age, role, socials, etc.) and get a shareable card at a unique URL like `cardy-ten.vercel.app/card/88603c`.

---

## How do I run it locally?

```bash
# from the cardy/ directory
npm install
cp .env.example .env     # fill in your Upstash + Bitly credentials
npm start                # starts at http://localhost:3000
```

Your `.env` needs:
- `ADMIN_PASSWORD` — the admin dashboard password
- `UPSTASH_REDIS_REST_URL` — from your Upstash console
- `UPSTASH_REDIS_REST_TOKEN` — from your Upstash console
- `BITLY_ACCESS_TOKEN` — optional, for shortlinks
- `PUBLIC_BASE_URL` — optional, e.g. `https://cardy-ten.vercel.app`

---

## How do I deploy?

Just push to `main`. The Vercel GitHub App auto-deploys on every push. No manual steps needed.

```bash
git add .
git commit --author="AODO123 <71036089+AODO123@users.noreply.github.com>" -m "Your message"
git push origin main
```

Check the result at https://cardy-ten.vercel.app

---

## How does admin work?

1. Go to `/admin`
2. Log in with the `ADMIN_PASSWORD` from your `.env`
3. You see the dashboard: list of all cards, search, create/edit/delete

**Password change:** Click "Change password" in the top bar. You need the current password.

**Security notes:**
- Login is rate-limited (10 attempts per 15 minutes per IP)
- Sessions last 7 days, stored in Redis
- All admin API calls require a CSRF token (the dashboard handles this automatically)
- Admin pages have `X-Frame-Options: DENY` and `Cache-Control: no-store`

---

## How do I create a card without the form?

```bash
curl -X POST https://cardy-ten.vercel.app/api/cards \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John",
    "age": 25,
    "country": "US",
    "role": "job",
    "roleLabel": "Developer",
    "socials": [{"platform": "discord", "handle": "john#1234"}]
  }'
```

Required fields: `name`, `age`. Everything else is optional.

---

## How do I edit a card?

Via the admin dashboard — log in, find the card, click Edit.

Or via API (you need a valid admin session + CSRF token):

```bash
# First, log in to get the session cookie
curl -c cookies.txt -X POST https://cardy-ten.vercel.app/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password": "YOUR_PASSWORD"}'

# Get the CSRF token
curl -b cookies.txt https://cardy-ten.vercel.app/admin/api/me

# Update the card (use the CSRF token from the previous step)
curl -b cookies.txt -X PATCH https://cardy-ten.vercel.app/admin/api/cards/CARD_ID \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -d '{"name": "Updated Name", "age": 26}'
```

---

## How do I delete a card?

Admin dashboard: find the card, click Delete, confirm.

Or via API (same auth as editing):

```bash
curl -b cookies.txt -X DELETE https://cardy-ten.vercel.app/admin/api/cards/CARD_ID \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN"
```

---

## What social platforms are supported?

Discord, X (Twitter), Instagram, and TikTok. That's it — no Spotify, no others.

The server drops any platform not in that list, so even if you send extra data, it gets stripped.

---

## What does the "owner" flag do?

It gives the card a gold-colored name and an "Owner" badge. Only the admin dashboard can set this. The public form never sets `owner: true`.

In production, only one card should have this: `88603c` (Costa's card).

---

## What's in the database?

Just cards. Each card is stored as `cardy:card:<id>` in Redis. The admin password hash is at `cardy:admin:passhash`. Sessions live at `cardy:admin:session:<token>` with a 7-day TTL.

---

## How do I add a new social platform?

1. Add the icon to `public/` (e.g. `spotify.png`)
2. Add the platform name to `KNOWN_PLATFORMS` in `server.js`
3. Add it to `PLATFORMS` in `public/index.html`, `views/admin.html`
4. Add the icon HTML to `SOCIAL_ICONS` and `SOCIAL_NAMES` in `public/render-card.js`
5. Add the input row in `public/index.html`
6. Run tests: `npm test`

---

## Tests are failing. What do I do?

Run `npm test` and read the output. The test suite has 105 assertions covering:
- Card creation and validation
- Social platform filtering
- Backward compatibility (old field names)
- Card retrieval
- Page and asset serving
- render-card.js logic
- Admin dashboard routes

If you broke something, the test output tells you exactly which assertion failed.

---

## Can I change the theme?

Yes. Edit the CSS variables at the top of `public/style.css`:

```css
:root {
  --accent: #8b7bff;      /* main purple accent */
  --accent-soft: #a99bff; /* lighter accent for hovers */
  --bg: #0d0f17;          /* page background */
  --panel: #151a28;       /* card/panel background */
  /* ... etc */
}
```

---

## Common gotchas

- **Don't commit `.env`** — it's in `.gitignore` but double-check
- **Don't create extra cards in prod** — the test suite uses its own server instance, not production
- **Commit author must be `Costa <71036089+AODO123@users.noreply.github.com>`** — anything else blocks the Vercel deploy
- **The noreply email can't receive verification codes** — don't try to verify it, the GitHub App bypasses this
- **`/admin` is not a static file** — it's a server route that checks your session and serves the right HTML. Don't try to access `admin.html` directly
- **Old cards with `favoriteMusic` or `notes` still work** — the server normalizes them to `favoriteSong` and `aboutMe`

---

## Project structure

```
cardy/
├── server.js              # Express app (all routes, auth, Redis)
├── api/index.js           # Vercel serverless entry
├── vercel.json            # Rewrites everything to /api/index
├── test.js                # 105-test suite
├── .env.example           # Template for .env
├── .gitignore
├── FAQ.md                 # ← you are here
├── public/
│   ├── index.html         # Main form + live preview
│   ├── card.html          # Shared card page
│   ├── style.css          # Theme CSS
│   ├── render-card.js     # Shared card renderer
│   ├── admin.css          # Admin styles
│   ├── cardy.png          # App icon
│   ├── job.png            # Role icon (work)
│   ├── student.png        # Role icon (study)
│   ├── discord.png        # Platform icon
│   ├── x.png              # Platform icon
│   ├── instagram.png      # Platform icon
│   └── tiktok.png         # Platform icon
└── views/
    ├── admin.html         # Admin dashboard
    └── admin-login.html   # Admin sign-in page
```
