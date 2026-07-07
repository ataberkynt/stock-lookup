import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from environment ----------------------------------------------

const RAW_STORE = process.env.SHOPIFY_STORE || "";
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || "";
const RAW_LOCATION_ID = process.env.SHOPIFY_LOCATION_ID || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";
// Optional: if set, the whole app is protected behind this shared password.
const APP_PASSWORD = process.env.APP_PASSWORD || "";
// Idle timeout in minutes before the session expires (only used with APP_PASSWORD).
const SESSION_MINUTES = (() => {
  const n = parseInt(process.env.SESSION_TIMEOUT_MINUTES || "3", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

// Normalize "mystore", "mystore.myshopify.com" or a full URL into a hostname.
function shopHost(raw) {
  let s = raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return "";
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return s;
}

// Accept either a numeric location id or a full gid.
function locationGID(raw) {
  const s = String(raw).trim();
  if (!s) return "";
  return s.startsWith("gid://") ? s : `gid://shopify/Location/${s}`;
}

const SHOP_HOST = shopHost(RAW_STORE);
const LOCATION_GID = locationGID(RAW_LOCATION_ID);
const GRAPHQL_URL = `https://${SHOP_HOST}/admin/api/${API_VERSION}/graphql.json`;

function configError() {
  const missing = [];
  if (!SHOP_HOST) missing.push("SHOPIFY_STORE");
  if (!ACCESS_TOKEN) missing.push("SHOPIFY_ACCESS_TOKEN");
  if (!LOCATION_GID) missing.push("SHOPIFY_LOCATION_ID");
  return missing.length ? `Missing environment variables: ${missing.join(", ")}` : null;
}

// ---- Optional shared-password gate (cookie session, idle timeout) ----------

function signValue(value) {
  return crypto.createHmac("sha256", APP_PASSWORD).update(value).digest("hex");
}
function makeToken() {
  const exp = String(Date.now() + SESSION_MINUTES * 60 * 1000);
  return `${exp}.${signValue(exp)}`;
}
function tokenValid(token) {
  if (!token || !token.includes(".")) return false;
  const [exp, sig] = token.split(".");
  const expected = signValue(exp);
  if (!sig || sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res) {
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  const parts = [
    `ssid=${makeToken()}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_MINUTES * 60}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function loginPage(showError) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Stock Search</title>
<link rel="icon" href="/favicon.ico" />
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:24px;background:#eef0f4;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#14181f}
  .logo{height:64px;width:auto;max-width:70vw;object-fit:contain}
  form{background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 24px rgba(20,24,31,.08);
    width:min(340px,90vw)}
  h1{font-size:18px;margin:0 0 4px}
  p{margin:0 0 18px;color:#5b6472;font-size:14px}
  input{width:100%;box-sizing:border-box;font-size:16px;padding:13px;border:1px solid #dfe3ea;
    border-radius:11px;margin-bottom:12px}
  input:focus{outline:2px solid #1b4db1;border-color:transparent}
  button{width:100%;border:0;background:#1b4db1;color:#fff;font-size:16px;font-weight:600;
    padding:13px;border-radius:11px;cursor:pointer}
  .err{color:#b42318;font-size:13px;margin:-4px 0 12px}
  .foot{color:#5b6472;font-size:12px}
</style></head><body>
<img class="logo" src="/logo.png" alt="Mavi" onerror="this.style.display='none'" />
<form method="POST" action="/login">
  <h1>Warehouse Stock Search</h1>
  <p>Enter the access password to continue.</p>
  ${showError ? '<div class="err">Incorrect password. Try again.</div>' : ""}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
</form>
<footer class="foot">© ${new Date().getFullYear()} Ataberk Yanut @Mavi Jeans · Internal use only</footer>
</body></html>`;
}

if (APP_PASSWORD) {
  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: false }));

  app.get("/login", (req, res) => {
    res.type("html").send(loginPage(req.query.error === "1"));
  });
  app.post("/login", (req, res) => {
    if ((req.body.password || "") === APP_PASSWORD) {
      setSessionCookie(req, res);
      return res.redirect("/?k=1"); // marks a fresh login so a later refresh signs out
    }
    return res.redirect("/login?error=1");
  });
  app.get("/logout", (req, res) => {
    res.append("Set-Cookie", "ssid=; HttpOnly; Path=/; Max-Age=0");
    res.redirect("/login");
  });

  app.use((req, res, next) => {
    if (tokenValid(readCookie(req, "ssid"))) {
      setSessionCookie(req, res); // sliding refresh on every request
      return next();
    }
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Session expired. Please sign in again.", auth: true });
    }
    return res.redirect("/login");
  });
}

// ---- Shopify helper --------------------------------------------------------

async function shopifyGraphQL(query, variables) {
  const resp = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned a non-JSON response (HTTP ${resp.status}).`);
  }
  if (!resp.ok) {
    throw new Error(`Shopify API error (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

// Escape a value so it is safe inside a Shopify search query string.
function escapeQuery(v) {
  return String(v).replace(/["\\]/g, "\\$&");
}

// Pull the "available" quantity out of an inventoryLevel node.
// Returns null when the variant is not stocked at this location at all.
function availableAt(inventoryItem) {
  const level = inventoryItem?.inventoryLevel;
  if (!level) return null;
  const q = (level.quantities || []).find((x) => x.name === "available");
  return q ? q.quantity : 0;
}

const INVENTORY_FRAGMENT = `
  inventoryItem {
    inventoryLevel(locationId: $locationId) {
      quantities(names: ["available"]) {
        name
        quantity
      }
    }
  }
`;

// ---- API routes ------------------------------------------------------------

let cachedLocationName = null;

async function getLocationName() {
  if (cachedLocationName) return cachedLocationName;
  const data = await shopifyGraphQL(
    `query Loc($id: ID!) { location(id: $id) { name } }`,
    { id: LOCATION_GID }
  );
  cachedLocationName = data.location?.name || null;
  return cachedLocationName;
}

app.get("/api/config", async (req, res) => {
  const err = configError();
  let locationName = null;
  if (!err) {
    try {
      locationName = await getLocationName();
    } catch {
      /* non-fatal: banner just shows the store instead */
    }
  }
  res.json({
    configured: !err,
    error: err,
    store: SHOP_HOST || null,
    location: locationName,
    sessionTimeoutMinutes: APP_PASSWORD ? SESSION_MINUTES : 0,
  });
});

// Search by product name -> list of products, each with its variants (sizes).
app.get("/api/search", async (req, res) => {
  const err = configError();
  if (err) return res.status(500).json({ error: err });

  const term = (req.query.q || "").toString().trim();
  if (!term) return res.status(400).json({ error: "Enter a product name to search." });

  const query = `
    query Search($q: String!, $locationId: ID!) {
      products(first: 20, query: $q) {
        edges {
          node {
            id
            title
            featuredImage { url altText }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  ${INVENTORY_FRAGMENT}
                }
              }
            }
          }
        }
      }
    }`;

  try {
    const data = await shopifyGraphQL(query, {
      q: escapeQuery(term),
      locationId: LOCATION_GID,
    });

    const products = data.products.edges.map(({ node }) => ({
      id: node.id,
      title: node.title,
      image: node.featuredImage?.url || null,
      variants: node.variants.edges.map(({ node: v }) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        barcode: v.barcode,
        available: availableAt(v.inventoryItem),
      })),
    }));

    res.json({ products });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Search by barcode -> go straight to the matching variant(s).
app.get("/api/barcode", async (req, res) => {
  const err = configError();
  if (err) return res.status(500).json({ error: err });

  const code = (req.query.code || "").toString().trim();
  if (!code) return res.status(400).json({ error: "Enter a barcode to search." });

  const query = `
    query Barcode($q: String!, $locationId: ID!) {
      productVariants(first: 10, query: $q) {
        edges {
          node {
            id
            title
            sku
            barcode
            product { title featuredImage { url altText } }
            ${INVENTORY_FRAGMENT}
          }
        }
      }
    }`;

  try {
    const data = await shopifyGraphQL(query, {
      q: `barcode:${escapeQuery(code)}`,
      locationId: LOCATION_GID,
    });

    const variants = data.productVariants.edges.map(({ node: v }) => ({
      id: v.id,
      productTitle: v.product?.title || "",
      image: v.product?.featuredImage?.url || null,
      title: v.title,
      sku: v.sku,
      barcode: v.barcode,
      available: availableAt(v.inventoryItem),
    }));

    res.json({ variants });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- Static frontend -------------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Stock search running on port ${PORT}`);
  console.log(`Store: ${SHOP_HOST || "(not set)"} | Location: ${LOCATION_GID || "(not set)"}`);
});
