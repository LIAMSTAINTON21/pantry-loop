import { canLookup } from "./barcode.js";
import { getDatabaseGeneration, getSettings, getState, saveProduct } from "./db.js";

const API = "https://world.openfoodfacts.org/api/v3/product/";
let running = false;
let lastStart = 0;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function adapter(data, requested) {
  const product = data?.product;
  const returned = String(product?.code ?? data?.code ?? "");
  if (!product || !returned || returned.replace(/^0+(?=\d)/, "") !== requested.replace(/^0+(?=\d)/, "")) return null;
  const name = product.product_name_en || product.product_name || "";
  if (!name.trim()) return null;
  return { name: name.trim(), brand: (product.brands || "").trim() || null, size: (product.quantity || "").trim() || null };
}

async function lookupOne(product) {
  const generation = getDatabaseGeneration();
  const elapsed = Date.now() - lastStart; if (elapsed < 5000) await wait(5000 - elapsed);
  lastStart = Date.now();
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${API}${encodeURIComponent(product.barcode)}?product_type=all&fields=code,product_name,product_name_en,brands,quantity`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if ([429, 503].includes(response.status)) {
      const retrySeconds = Math.max(60, Number(response.headers.get("Retry-After")) || 60);
      await saveProduct(product.barcode, { lookup: { ...product.lookup, state: "pending", checkedAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + retrySeconds * 1000).toISOString() } }); return;
    }
    if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
    const match = adapter(await response.json(), product.barcode);
    if (getDatabaseGeneration() !== generation) return;
    const current = (await getState()).products.find(item => item.barcode === product.barcode); if (!current) return;
    if (!match) {
      await saveProduct(product.barcode, { lookup: { state: "missing", source: "Open Food Facts v3", checkedAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + 7 * 86400000).toISOString() } }); return;
    }
    const patch = {};
    for (const field of ["name", "brand", "size"]) if (!(current.userEditedFields ?? []).includes(field)) patch[field] = match[field];
    patch.lookup = { state: "resolved", source: "Open Food Facts v3", checkedAt: new Date().toISOString(), nextRetryAt: null };
    await saveProduct(product.barcode, patch);
  } catch (error) {
    if (getDatabaseGeneration() !== generation) return;
    await saveProduct(product.barcode, { lookup: { ...product.lookup, state: "pending", checkedAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + 15 * 60000).toISOString() } }).catch(() => {});
  } finally { clearTimeout(timeout); }
}

export async function processLookupQueue() {
  if (running || !navigator.onLine) return;
  const settings = await getSettings(); if (!settings.onlineLookup) return;
  running = true;
  try {
    const now = new Date().toISOString();
    const state = await getState();
    const queue = state.products.filter(product => canLookup(product.barcode) && ["pending", "missing"].includes(product.lookup?.state) && (!product.lookup.nextRetryAt || product.lookup.nextRetryAt <= now));
    for (const product of queue) { if (!navigator.onLine) break; await lookupOne(product); }
  } finally { running = false; }
}

export async function retryLookup(barcode) {
  const state = await getState(); const product = state.products.find(item => item.barcode === barcode);
  if (!product || !canLookup(barcode)) return;
  await saveProduct(barcode, { lookup: { ...product.lookup, state: "pending", nextRetryAt: null } }); processLookupQueue();
}
