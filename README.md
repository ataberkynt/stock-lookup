# Warehouse Stock Search

A tiny internal web app for store staff. Search a product by name or scan a
barcode and see the available stock **at one single location** (your warehouse),
so nobody accidentally ships from another store.

- Search by product name → every size listed with its stock at that location.
- Search by barcode → jumps straight to the matching variant.
- The location name is pinned to the top of the screen at all times.

Read-only. It never edits inventory or creates orders.

## Setup

### 1. Create a Shopify custom app
In your Shopify admin: **Settings → Apps and sales channels → Develop apps →
Create an app**. Under **Configuration → Admin API scopes**, enable:

- `read_products`
- `read_inventory`
- `read_locations`

Install the app and copy the **Admin API access token** (`shpat_...`).

### 2. Find your location id
In Shopify admin go to **Settings → Locations**, open your warehouse, and copy
the number at the end of the URL (`.../locations/1234567890`). Either the number
or the full `gid://shopify/Location/1234567890` works.

### 3. Environment variables
See `.env.example`. Required: `SHOPIFY_STORE`, `SHOPIFY_ACCESS_TOKEN`,
`SHOPIFY_LOCATION_ID`. Optional: `SHOPIFY_API_VERSION`, `APP_PASSWORD`.

## Run locally
```bash
npm install
cp .env.example .env   # then fill in your values
node --env-file=.env server.js
# open http://localhost:3000
```

## Deploy on Railway
1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick it.
3. Under **Variables**, add `SHOPIFY_STORE`, `SHOPIFY_ACCESS_TOKEN`,
   `SHOPIFY_LOCATION_ID` (and optionally `APP_PASSWORD`).
4. Railway runs `npm start` and injects `PORT` automatically. Generate a public
   domain under **Settings → Networking**.

## Notes
- If a variant isn't stocked at the location at all, it shows "—  not stocked".
- Set `APP_PASSWORD` if you don't want the stock numbers publicly reachable by
  anyone who has the URL.
