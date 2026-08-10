# cardy

Create a tiny digital card about yourself and share it with a link — optionally shortened with **bit.ly**. Cards are stored in **Upstash Redis**, so they survive restarts and work on serverless hosting (Vercel).

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Create a free Upstash Redis database
#    - Go to https://console.upstash.com → create a database (free tier is fine)
#    - Copy the REST URL and REST Token
cp .env.example .env
# edit .env: set UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, BITLY_ACCESS_TOKEN

# 3. Run it
npm start
```

Open http://localhost:3000, fill in the form, hit **Create card**, and you get:
- the card's own URL, e.g. `http://localhost:3000/card/a1b2c3`
- a bit.ly link automatically (when the token is set)

> **Note:** bit.ly only shortens *publicly reachable* URLs. For local testing, run a tunnel like `ngrok http 3000` and set `PUBLIC_BASE_URL` to its URL.

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

| Variable                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis REST URL (required).                                          |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token (required).                                        |
| `BITLY_ACCESS_TOKEN`    | Bitly access token. Without it, cards still work — you just get the full link. |
| `PUBLIC_BASE_URL`       | Public base URL of the site, e.g. `https://cardy.vercel.app`. If unset, card links are built from the incoming request. |
| `PORT`                  | Port for local development (default `3000`). Vercel ignores this.           |

## How it works

- **Backend:** a small Express app. Cards are stored in Upstash Redis as `cardy:card:<id>` keys (JSON), so storage is stateless and serverless-friendly.
- **Create:** `POST /api/cards` — saves the card and returns `shareUrl` (and `bitlyUrl` when configured).
- **View:** `GET /card/:id` serves the card page, which loads its data from `GET /api/cards/:id`.
- **Bitly:** the server calls Bitly's `/v4/shorten` API, so your token never ends up in the browser.

## Project layout

```
cardy/
├── server.js          # Express app + Redis storage + Bitly
├── api/index.js       # Vercel serverless entry point (exports the app)
├── vercel.json        # rewrites all traffic to the serverless function
├── public/
│   ├── index.html     # create form + live preview + share links
│   ├── card.html      # the shared card view
│   └── style.css      # shared styling
└── .env.example
```
