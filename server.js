import express from "express";
import path from "node:path";
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

// ---- Optional shared-password gate -----------------------------------------

if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (pass === APP_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Stock Search"');
    return res.status(401).send("Authentication required.");
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
