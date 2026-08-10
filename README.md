# cardy

A tiny digital card about yourself, created once and shared with one link.

No account, no app, no setup on the visitor's side. You fill in a short form — name, age, a couple of socials, a favorite song if you feel like it — and cardy gives you a page at a short URL like `/card/a1b2c3`. Send that link to anyone; they see a clean summary of who you are. If they like it, there's a button right there to make their own card.

Live at **[cardy-ten.vercel.app](https://cardy-ten.vercel.app)**.

## What's on a card

- **Name and age** (both required) plus an optional country
- **Job or student**, with a title or field of study
- **About me**, website, MBTI, interests, favorite song, favorite movie
- **Socials as plain usernames** — Discord, X, Instagram, TikTok. No OAuth dance, no verification; you just type your handle
- A shareable link to the page, and a bit.ly short link when Bitly is configured

One card can be flagged as the **owner** card from the admin dashboard — it gets a gold name and a small badge. That's it, kept deliberately simple.

## Run it locally

You need Node.js 18+ and a free [Upstash Redis](https://console.upstash.com) database (the REST URL and token are all that matter).

```bash
npm install
cp .env.example .env    # then fill in UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
npm start
```

Open http://localhost:3000, submit the form, and you get the card's URL back.

A note on bit.ly: it only shortens URLs it can actually reach. For local testing, run a tunnel (`ngrok http 3000`) and set `PUBLIC_BASE_URL` to the tunnel's address.

## How it works

Cards are stored in Upstash Redis as `cardy:card:<id>` JSON blobs. The server keeps no state of its own, which is what lets it run as a single serverless function on Vercel.

- `POST /api/cards` validates and saves a card, then returns its `shareUrl`
- `GET /card/:id` serves the card page, which loads its data from `GET /api/cards/:id`
- Bitly shortening happens server-side, so your token never reaches the browser. If it fails — quota's the usual culprit — the card still works, you just get the full link

Cards are rendered by escaping everything user-supplied and only ever linking http/https URLs, so a card can't smuggle in scripts or `javascript:` links.

## Admin dashboard

`/admin` is a password-protected panel where the site owner can list, search, create, edit, and delete every card, and mark one as the owner. The password comes from `ADMIN_PASSWORD`, and it can be changed later from the dashboard itself (the new hash is stored in Redis and takes over from the env var).

On top of the password:

- sessions live in Redis and travel as `httpOnly`, `SameSite=Strict` cookies
- every mutation has to echo a per-session CSRF token
- login is rate-limited per IP — 10 failed attempts locks you out for 15 minutes — and password checks run in constant time
- the dashboard HTML isn't in `public/`, so it can't be served statically without a session; admin responses are also `X-Frame-Options: DENY` and `Cache-Control: no-store` to stop clickjacking and caching
- the public card form can never set the owner flag. That's admin-only

The admin API — for scripted use or building on top of it:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/admin/login` | sign in with the password |
| `POST` | `/admin/logout` | sign out |
| `GET` | `/admin/api/me` | current session + CSRF token |
| `GET` | `/admin/api/cards` | list all cards (newest first) |
| `GET` | `/admin/api/cards/:id` | one card |
| `POST` | `/admin/api/cards` | create a card (may set `owner`) |
| `PATCH` | `/admin/api/cards/:id` | edit a card (may set `owner`) |
| `DELETE` | `/admin/api/cards/:id` | delete a card |
| `POST` | `/admin/api/password` | change the admin password (needs `currentPassword`) |

Every route needs the admin session cookie, and every mutation also needs an `X-CSRF-Token` header (fetch it from `/admin/api/me`).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Required. Upstash Redis REST URL. |
| `UPSTASH_REDIS_REST_TOKEN` | Required. Upstash Redis REST token. |
| `ADMIN_PASSWORD` | Required for the dashboard. Password for `/admin`. |
| `BITLY_ACCESS_TOKEN` | Optional. Enables bit.ly short links. |
| `PUBLIC_BASE_URL` | Optional. Public base URL used to build card links. Unset → links are built from the incoming request. |
| `PORT` | Local dev port (default 3000). Ignored on Vercel. |

## Deploy to Vercel

The repo is already wired up: `api/index.js` exports the Express app and `vercel.json` routes every path through it.

```bash
vercel login
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel env add ADMIN_PASSWORD
vercel env add BITLY_ACCESS_TOKEN     # optional
vercel env add PUBLIC_BASE_URL        # your https://<project>.vercel.app URL
vercel --prod
```

Or skip the CLI and import the repo through the [Vercel dashboard](https://vercel.com/new), setting the same variables under **Settings → Environment Variables**.

## API

### `POST /api/cards` — create a card

JSON body:

```json
{
  "name": "john doe",
  "age": 28,
  "country": "Canada",
  "role": "job",
  "roleLabel": "Engineer",
  "aboutMe": "…",
  "socials": [
    { "platform": "discord", "handle": "user" },
    { "platform": "x", "handle": "@user" }
  ],
  "website": "https://example.com",
  "mbti": "INFJ",
  "interests": "photography",
  "favoriteSong": "Billie Jean",
  "favoriteMovie": "The Matrix"
}
```

`name` and `age` (a whole number, 1–130) are required; everything else is optional. Known platforms are deduped, handles are trimmed to 120 characters, and unknown ones are dropped. Returns `201` with the stored card, including `shareUrl` and — when Bitly is configured and has quota — `bitlyUrl`.

### `GET /api/cards/:id`

Returns the card, or `404 { "error": "Card not found." }`.

## Tests

```bash
npm test
```

The suite boots a real server against your Redis and runs a bit over a hundred checks: API validation, backward compatibility (old cards used `notes` and `favoriteMusic` — both still read), the renderer including XSS escaping, every page and asset, and the whole admin flow (auth, CSRF, rate limiting, owner flag). It creates its own cards and deletes them at the end, so it won't leave junk in your database.

## Project layout

```
server.js          Express app — Redis, Bitly, API, admin auth
api/index.js       Vercel serverless entry point
views/             Session-gated pages: admin dashboard + login
public/            Static site: form, card view, styles, icons
test.js            The test suite
.env.example       Env var template
```
