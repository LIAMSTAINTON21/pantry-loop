import { canLookup } from "./barcode.js";
import { getDatabaseGeneration, getSettings, getState, saveProduct } from "./db.js";

const API = "https://world.openfoodfacts.org/api/v3/product/";
let running = false;
let lastStart = 0;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function openFoodFactsAdapter(data, requested) {
  const product = data?.product;
  const returned = String(product?.code ?? data?.code ?? "");
  if (!product || !returned || returned.replace(/^0+(?=\d)/, "") !== requested.replace(/^0+(?=\d)/, "")) return null;
  const name = product.product_name_en || product.product_name || "";
  if (!name.trim()) return null;
  return {
    name: name.trim(), brand: (product.brands || "").trim() || null,
    size: (product.quantity || "").trim() || null,
    category: (product.categories || "").split(",")[0]?.trim() || null,
    imageUrl: product.image_front_url || null,
    price: null, currency: "GBP", source: "Open Food Facts v3"
  };
}

function clean(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }

export function catalogueAdapter(data) {
  const item = data?.product ?? data?.result ?? data;
  if (!item || typeof item !== "object" || item.found === false) return null;
  const name = clean(item.product_name) ?? clean(item.name) ?? clean(item.names?.en);
  if (!name) return null;
  let price = Number(item.price);
  if (!Number.isFinite(price)) price = null;
  else if (Number.isInteger(price) && price >= 50 && item.names && item.quantity_str && (item.currency === "GBP" || item.currency === "gbp")) price /= 100;
  return {
    name,
    brand: clean(item.brand) ?? clean(item.brands),
    size: clean(item.quantity) ?? clean(item.quantity_str) ?? clean(item.size),
    price,
    currency: clean(item.currency)?.toUpperCase() ?? "GBP",
    imageUrl: clean(item.image_url) ?? clean(item.imageUrl) ?? clean(item.image),
    category: clean(item.category) ?? clean(item.entity_name),
    source: clean(item.source) ?? "Tesco GB catalogue"
  };
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

export async function identifyBarcode(barcode, settings = null) {
  settings ??= await getSettings();
  const local = (await getState()).products.find(product => product.barcode === barcode);
  if (local && !local.name.startsWith("Unknown item") && ["resolved", "manual"].includes(local.lookup?.state)) {
    return { match: { name: local.name, brand: local.brand, size: local.size, price: local.price, currency: local.currency, imageUrl: local.imageUrl, category: local.category, source: local.lookup.source ?? "Saved on this device" }, provider: "local" };
  }
  if (!settings.onlineLookup || !canLookup(barcode) || !navigator.onLine) return { match: null, reason: navigator.onLine ? "disabled" : "offline" };
  if (settings.catalogueProxyUrl) {
    try {
      const data = await fetchJson(settings.catalogueProxyUrl, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ barcode, retailer: "tesco-gb" })
      });
      const match = catalogueAdapter(data);
      if (match) return { match, provider: "tesco" };
      return { match: null, reason: "not-found", provider: "tesco" };
    } catch (error) { return { match: null, reason: error.name === "AbortError" ? "timeout" : "error", provider: "tesco", error }; }
  }
  try {
    const fields = "code,product_name,product_name_en,brands,quantity,categories,image_front_url";
    const data = await fetchJson(`${API}${encodeURIComponent(barcode)}?product_type=all&fields=${fields}`, { headers: { Accept: "application/json" } });
    return { match: openFoodFactsAdapter(data, barcode), provider: "open-food-facts", reason: "not-found" };
  } catch (error) { return { match: null, reason: error.name === "AbortError" ? "timeout" : "error", provider: "open-food-facts", error }; }
}

async function lookupOne(product) {
  const generation = getDatabaseGeneration();
  const elapsed = Date.now() - lastStart; if (elapsed < 5000) await wait(5000 - elapsed);
  lastStart = Date.now();
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${API}${encodeURIComponent(product.barcode)}?product_type=all&fields=code,product_name,product_name_en,brands,quantity,categories,image_front_url`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if ([429, 503].includes(response.status)) {
      const retrySeconds = Math.max(60, Number(response.headers.get("Retry-After")) || 60);
      await saveProduct(product.barcode, { lookup: { ...product.lookup, state: "pending", checkedAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + retrySeconds * 1000).toISOString() } }); return;
    }
    if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
    const match = openFoodFactsAdapter(await response.json(), product.barcode);
    if (getDatabaseGeneration() !== generation) return;
    const current = (await getState()).products.find(item => item.barcode === product.barcode); if (!current) return;
    if (!match) {
      await saveProduct(product.barcode, { lookup: { state: "missing", source: "Open Food Facts v3", checkedAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + 7 * 86400000).toISOString() } }); return;
    }
    const patch = {};
    for (const field of ["name", "brand", "size", "category", "imageUrl"]) if (!(current.userEditedFields ?? []).includes(field)) patch[field] = match[field];
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
