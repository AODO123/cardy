# cardy

Create a tiny digital card about yourself and share it with one link. Add your social usernames (Discord, X, Instagram, TikTok), pick a song, drop your MBTI — anyone who opens your card sees a clean summary of who you are. Cards are stored in **Upstash Redis**, so they survive restarts and run on serverless hosting (Vercel).

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Create a free Upstash Redis database
#    - Go to https://console.upstash.com → create a database (free tier is fine)
#    - Copy the REST URL and REST Token
cp .env.example .env
# edit .env: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN

# 3. Run it
npm start
```

Open http://localhost:3000, fill in the form, hit **Create card**, and you get:
- the card's own URL, e.g. `http://localhost:3000/card/a1b2c3`
- a bit.ly link automatically (when `BITLY_ACCESS_TOKEN` is set)

> **Note:** bit.ly only shortens *publicly reachable* URLs. For local testing, run a tunnel like `ngrok http 3000` and set `PUBLIC_BASE_URL` to its URL.

## Card fields

Name (required), age (required, 1–130), job/student role, job title or field of study, country, **About me**, social usernames (Discord / X / Instagram / TikTok), website link, personality / MBTI, interests, favorite song, and favorite movie or series. Optional fields can be left blank.

## Social media

No OAuth, no verification — you simply type each platform's username. The form offers **Discord, X, Instagram, and TikTok**. Cards created before the switch to X may still carry a **Spotify** handle, and those render as before.

## Deploying to Vercel (free)

The app is already wired for Vercel: `api/index.js` exports the Express app and `vercel.json` rewrites all traffic to it.

```bash
# 1. Install the Vercel CLI and log in once
npm install -g vercel
vercel login          # opens your browser

# 2. Add the environment variables (matches your .env)
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel env add BITLY_ACCESS_TOKEN
vercel env add PUBLIC_BASE_URL      # set to your https://<project>.vercel.app URL after first deploy

# 3. Deploy
vercel --prod
```

Or skip the CLI and import the repo through the [Vercel dashboard](https://vercel.com/new) — set the same env vars under **Settings → Environment Variables**.

## Environment variables

| Variable                  | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis REST URL (required).                                          |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token (required).                                        |
| `BITLY_ACCESS_TOKEN`      | Bitly access token. Without it, cards still work — you just get the full link. |
| `PUBLIC_BASE_URL`         | Public base URL of the site, e.g. `https://cardy.vercel.app`. If unset, card links are built from the incoming request. |
| `ADMIN_PASSWORD`          | Password for the `/admin` dashboard (see below). If unset, the dashboard reports it isn't configured. |
| `PORT`                    | Port for local development (default `3000`). Vercel ignores this.           |

## API

### `POST /api/cards` — create a card

Body (JSON):

```json
{
  "name": "john doe",              // required
  "age": 28,                       // required, whole number 1–130
  "country": "Canada",             // optional
  "role": "job" | "student",       // optional, default "job"
  "roleLabel": "Engineer",         // optional
  "aboutMe": "…",                  // optional ("notes" is accepted for older cards)
  "socials": [                     // optional
    { "platform": "discord", "handle": "user" },
    { "platform": "x", "handle": "@user" }
  ],
  "website": "https://example.com",// optional
  "mbti": "INFJ",                  // optional
  "interests": "photography",      // optional
  "favoriteSong": "Billie Jean",   // optional ("favoriteMusic" accepted for older cards)
  "favoriteMovie": "The Matrix"    // optional
}
```

Returns `201` with the stored card, including `shareUrl` and (when Bitly is configured and has quota) `bitlyUrl`. Known platforms are deduplicated, handles are trimmed to 120 characters, and unknown platforms are dropped.

### `GET /api/cards/:id` — fetch a card

Returns the card, or `404 { "error": "Card not found." }`.

## Admin dashboard

Visit `/admin` to manage the site. It's protected by a single password set with `ADMIN_PASSWORD`, and it follows security best practices:

- sessions live in **Upstash Redis** (so they survive serverless restarts) and are sent as `httpOnly`, `SameSite=Strict` cookies
- every state-changing request must echo a per-session **CSRF token**
- login is **rate-limited per IP** (10 failed attempts → locked for 15 minutes) and the password hash is compared in constant time
- the password can be **changed from the dashboard** — the new sha-256 hash is stored in Redis and then wins over the env var
- the public card form can **never** set the owner flag
- the dashboard shell is only served to a live session: hitting `/admin.html` without one is redirected through the login gate (and every admin API route returns `401`)
- admin pages are sent with `X-Frame-Options: DENY` (no clickjacking of the login form) and `Cache-Control: no-store`; all responses get `X-Content-Type-Options: nosniff`

From the dashboard you can **list, search, create, edit, and delete** every card, and mark any card as the **owner** card. Owner cards get a gold name and a small "Owner" badge when rendered (this is how Costa's card is flagged).

Set the password on Vercel with `vercel env add ADMIN_PASSWORD`.

### Admin API

All routes require the admin session cookie; every mutation also requires an `X-CSRF-Token` header (fetch it from `/admin/api/me`).

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/admin/login` | sign in with the password |
| `POST` | `/admin/logout` | sign out |
| `GET` | `/admin/api/me` | current session + CSRF token |
| `GET` | `/admin/api/cards` | list all cards (newest first) |
| `GET` | `/admin/api/cards/:id` | one card |
| `POST` | `/admin/api/cards` | create a card (may set `owner`) |
| `PATCH` | `/admin/api/cards/:id` | edit a card (full body, may set `owner`) |
| `DELETE` | `/admin/api/cards/:id` | delete a card |
| `POST` | `/admin/api/password` | change the admin password (needs `currentPassword`) |

## How it works

- **Backend:** a small Express app. Cards are stored in Upstash Redis as `cardy:card:<id>` keys (JSON), so storage is stateless and serverless-friendly.
- **Create:** `POST /api/cards` — saves the card and returns `shareUrl` (and `bitlyUrl` when configured).
- **View:** `GET /card/:id` serves the card page, which loads its data from `GET /api/cards/:id`. The card page links back to the form so visitors can make their own card.
- **Bitly:** the server calls Bitly's `/v4/shorten` API, so your token never ends up in the browser. If Bitly fails (e.g. quota), the card still works — it just keeps the full link.
- **Security:** user content is HTML-escaped at render time and website URLs are restricted to `http`/`https`, so malicious input can't inject markup or `javascript:` links. The `/admin` dashboard is password-protected with Redis-backed sessions, CSRF tokens, and per-IP login rate limiting (see above).

## Tests

```bash
npm test
```

Runs an automated suite that exercises the API validation rules, backward compatibility, the card renderer (including XSS escaping), and every page/asset.

## Project layout

```
cardy/
├── server.js            # Express app + Redis storage + Bitly + API + admin auth
├── api/index.js         # Vercel serverless entry point (exports the app)
├── vercel.json          # rewrites all traffic to the serverless function
├── test.js              # automated test suite (npm test)
├── views/               # session-gated HTML (NOT in public/, so Vercel can't serve it statically)
│   ├── admin.html       #   admin dashboard (list / edit / delete / owner / password)
│   └── admin-login.html #   password gate for the dashboard
├── public/
│   ├── index.html       # create form + live preview + share links
│   ├── card.html        # the shared card view (+ "create your own card" link)
│   ├── render-card.js   # shared card renderer (preview + view, owner badge)
│   ├── style.css        # shared styling (dark theme)
│   └── admin.css        # dashboard styling
└── .env.example
