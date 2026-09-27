import { replayStock } from "./inventory.js";

export const APP_ID = "pantry-loop";
export const SCHEMA_VERSION = 1;
const DB_NAME = "pantry-loop-data";
const STORES = ["products", "purchases", "depletions", "meta"];
let databasePromise;
let generation = 0;

const defaultSettings = {
  timezone: "Europe/London",
  categoryOrder: ["Fruit & veg", "Bakery", "Dairy", "Meat & fish", "Cupboard", "Frozen", "Household"],
  planningHorizonDays: 7,
  onlineLookup: true,
  catalogueProxyUrl: "",
  visionProxyUrl: "",
  lastMode: "buy",
  forceFallback: false
};

export function getDatabaseGeneration() { return generation; }

export async function openDatabase() {
  databasePromise ??= globalThis.idb.openDB(DB_NAME, SCHEMA_VERSION, {
    upgrade(db) {
      const products = db.createObjectStore("products", { keyPath: "barcode" });
      products.createIndex("lookupState", "lookup.state");
      const purchases = db.createObjectStore("purchases", { keyPath: "id" });
      purchases.createIndex("barcode", "barcode"); purchases.createIndex("sessionId", "sessionId"); purchases.createIndex("listId", "listId"); purchases.createIndex("seq", "seq");
      const depletions = db.createObjectStore("depletions", { keyPath: "id" });
      depletions.createIndex("barcode", "barcode"); depletions.createIndex("sessionId", "sessionId"); depletions.createIndex("seq", "seq");
      db.createObjectStore("meta", { keyPath: "key" });
    },
    blocked() { window.dispatchEvent(new CustomEvent("dbblocked")); },
    blocking() { databasePromise?.then(db => db.close()); databasePromise = null; }
  });
  const db = await databasePromise;
  const tx = db.transaction("meta", "readwrite");
  const meta = tx.objectStore("meta");
  if (!await meta.get("schemaVersion")) await meta.put({ key: "schemaVersion", value: SCHEMA_VERSION });
  if (!await meta.get("nextSeq")) await meta.put({ key: "nextSeq", value: 1 });
  if (!await meta.get("settings")) await meta.put({ key: "settings", value: defaultSettings });
  await tx.done;
  return db;
}

export async function getMeta(key, fallback = null) {
  const db = await openDatabase();
  return (await db.get("meta", key))?.value ?? fallback;
}

export async function setMeta(key, value) {
  const db = await openDatabase();
  await db.put("meta", { key, value });
  return value;
}

export async function getSettings() {
  return { ...defaultSettings, ...(await getMeta("settings", {})) };
}

export async function updateSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await setMeta("settings", settings);
  return settings;
}

export function localDate(timezone = "Europe/London", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function newProduct(barcode, barcodeFormat, name = null) {
  return {
    barcode, barcodeFormat,
    name: name || `Unknown item · ${barcode.replace(/^code128:/, "")}`,
    brand: null, size: null, price: null, currency: "GBP", imageUrl: null, category: null, userEditedFields: name ? ["name"] : [],
    lookup: { state: barcodeFormat === "manual" || barcode.startsWith("code128:") ? "manual" : "pending", source: null, checkedAt: null, nextRetryAt: null },
    onHandQty: null, status: "unknown", isStaple: false, staplePeriodDays: null,
    defaultQty: 1, snoozeUntil: null, neverSuggest: false, createdAt: new Date().toISOString()
  };
}

async function updateStockInTransaction(tx, barcode) {
  const productStore = tx.objectStore("products");
  const product = await productStore.get(barcode);
  if (!product) return;
  const purchases = await tx.objectStore("purchases").index("barcode").getAll(barcode);
  const depletions = await tx.objectStore("depletions").index("barcode").getAll(barcode);
  const stock = replayStock(barcode, purchases, depletions);
  await productStore.put({ ...product, onHandQty: stock.onHandQty, status: stock.status });
}

export async function recordEvent({ type, barcode, barcodeFormat, qty = 1, source = "scan", sessionId, listId = null, actionId = crypto.randomUUID(), name = null }) {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("Quantity must be a positive whole number");
  if (!new Set(["purchase", "depletion"]).has(type)) throw new Error("Invalid event type");
  const db = await openDatabase();
  const tx = db.transaction(STORES, "readwrite");
  const eventStore = tx.objectStore(type === "purchase" ? "purchases" : "depletions");
  const existing = await eventStore.get(actionId);
  if (existing) { await tx.done; return { event: existing, duplicate: true, product: await db.get("products", barcode) }; }

  const productStore = tx.objectStore("products");
  let product = await productStore.get(barcode);
  if (!product) { product = newProduct(barcode, barcodeFormat, name); await productStore.add(product); }
  const sequenceRow = await tx.objectStore("meta").get("nextSeq");
  const seq = sequenceRow?.value ?? 1;
  await tx.objectStore("meta").put({ key: "nextSeq", value: seq + 1 });
  const now = new Date().toISOString();
  const settings = (await tx.objectStore("meta").get("settings"))?.value ?? defaultSettings;
  const common = { id: actionId, seq, barcode, qty, sessionId, voidedAt: null, replacesId: null };
  const event = type === "purchase"
    ? { ...common, purchasedAt: now, purchasedOn: localDate(settings.timezone), source, listId, clearedSnoozeUntil: product.snoozeUntil ?? null }
    : { ...common, finishedAt: now };
  await eventStore.add(event);
  if (type === "purchase" && product.snoozeUntil) await productStore.put({ ...product, snoozeUntil: null });
  if (type === "purchase" && listId) {
    const draftRow = await tx.objectStore("meta").get("shoppingDraft");
    if (draftRow?.value?.id === listId && !draftRow.value.completedAt) {
      await tx.objectStore("meta").put({ key: "shoppingDraft", value: { ...draftRow.value, lastLinkedPurchaseAt: now } });
    }
  }
  await updateStockInTransaction(tx, barcode);
  await tx.done;
  return { event, duplicate: false, product: await db.get("products", barcode) };
}

export async function voidEvent(storeName, id) {
  if (!new Set(["purchases", "depletions"]).has(storeName)) throw new Error("Invalid event store");
  const db = await openDatabase();
  const tx = db.transaction([storeName, "products", storeName === "purchases" ? "depletions" : "purchases"], "readwrite");
  const store = tx.objectStore(storeName); const event = await store.get(id);
  if (!event || event.voidedAt) { await tx.done; return false; }
  await store.put({ ...event, voidedAt: new Date().toISOString() });
  if (storeName === "purchases" && event.clearedSnoozeUntil) {
    const later = (await store.index("barcode").getAll(event.barcode)).some(item => !item.voidedAt && item.seq > event.seq);
    const product = await tx.objectStore("products").get(event.barcode);
    if (!later && product?.snoozeUntil === null) await tx.objectStore("products").put({ ...product, snoozeUntil: event.clearedSnoozeUntil });
  }
  await updateStockInTransaction(tx, event.barcode); await tx.done; return true;
}

export async function correctEvent(storeName, id, qty) {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("Quantity must be positive");
  const other = storeName === "purchases" ? "depletions" : "purchases";
  const db = await openDatabase(); const tx = db.transaction([storeName, other, "products"], "readwrite");
  const store = tx.objectStore(storeName); const original = await store.get(id);
  if (!original || original.voidedAt) throw new Error("That event is no longer active");
  const voidedAt = new Date().toISOString(); const replacement = { ...original, id: crypto.randomUUID(), qty, replacesId: original.id, voidedAt: null };
  await store.put({ ...original, voidedAt }); await store.add(replacement); await updateStockInTransaction(tx, original.barcode); await tx.done;
  return replacement;
}

export async function undoCorrection(storeName, replacementId) {
  if (!new Set(["purchases", "depletions"]).has(storeName)) throw new Error("Invalid event store");
  const other = storeName === "purchases" ? "depletions" : "purchases";
  const db = await openDatabase(); const tx = db.transaction([storeName, other, "products"], "readwrite");
  const store = tx.objectStore(storeName); const replacement = await store.get(replacementId);
  if (!replacement || replacement.voidedAt || !replacement.replacesId) throw new Error("This correction cannot be undone");
  const original = await store.get(replacement.replacesId);
  if (!original) throw new Error("Original event is missing");
  await store.put({ ...replacement, voidedAt: new Date().toISOString() });
  await store.put({ ...original, voidedAt: null });
  await updateStockInTransaction(tx, replacement.barcode); await tx.done; return true;
}

export async function saveProduct(barcode, patch, userFields = []) {
  const db = await openDatabase(); const product = await db.get("products", barcode);
  if (!product) throw new Error("Product not found");
  const userEditedFields = [...new Set([...(product.userEditedFields ?? []), ...userFields])];
  const updated = { ...product, ...patch, userEditedFields };
  await db.put("products", updated); return updated;
}

export async function getState() {
  const db = await openDatabase();
  const tx = db.transaction(STORES, "readonly");
  const [products, purchases, depletions, meta] = await Promise.all(STORES.map(name => tx.objectStore(name).getAll()));
  await tx.done;
  return { products, purchases, depletions, meta };
}

export async function getRecentActivity(limit = 30) {
  const { products, purchases, depletions } = await getState();
  const names = new Map(products.map(product => [product.barcode, product.name]));
  return [...purchases.map(event => ({ ...event, type: "purchase", occurredAt: event.purchasedAt })), ...depletions.map(event => ({ ...event, type: "depletion", occurredAt: event.finishedAt }))]
    .sort((a, b) => b.seq - a.seq).slice(0, limit).map(event => ({ ...event, name: names.get(event.barcode) ?? event.barcode }));
}

export async function replaceAll(validated) {
  const db = await openDatabase(); generation += 1;
  const tx = db.transaction(STORES, "readwrite");
  for (const name of STORES) await tx.objectStore(name).clear();
  for (const product of validated.products) await tx.objectStore("products").put(product);
  for (const event of validated.purchases) await tx.objectStore("purchases").put(event);
  for (const event of validated.depletions) await tx.objectStore("depletions").put(event);
  for (const row of validated.meta) await tx.objectStore("meta").put(row);
  const maxSeq = Math.max(0, ...validated.purchases.map(e => e.seq), ...validated.depletions.map(e => e.seq));
  await tx.objectStore("meta").put({ key: "schemaVersion", value: SCHEMA_VERSION });
  await tx.objectStore("meta").put({ key: "nextSeq", value: maxSeq + 1 });
  for (const product of validated.products) await updateStockInTransaction(tx, product.barcode);
  await tx.done;
}

export async function logCheckedDraft(draft) {
  const db = await openDatabase();
  const tx = db.transaction(STORES, "readwrite");
  const metaStore = tx.objectStore("meta");
  const saved = (await metaStore.get("shoppingDraft"))?.value;
  if (!saved || saved.id !== draft.id || saved.completedAt) { await tx.done; return { alreadyCompleted: true, count: 0 }; }
  const linked = await tx.objectStore("purchases").index("listId").getAll(draft.id);
  const linkedByBarcode = new Map(); linked.filter(e => !e.voidedAt).forEach(e => linkedByBarcode.set(e.barcode, (linkedByBarcode.get(e.barcode) ?? 0) + e.qty));
  let nextSeq = (await metaStore.get("nextSeq"))?.value ?? 1; let count = 0;
  const settings = (await metaStore.get("settings"))?.value ?? defaultSettings;
  for (const row of draft.items.filter(item => item.checked)) {
    const remaining = Math.max(0, row.qty - (linkedByBarcode.get(row.barcode) ?? 0));
    if (!remaining) continue;
    const now = new Date().toISOString();
    await tx.objectStore("purchases").add({ id: crypto.randomUUID(), seq: nextSeq++, barcode: row.barcode, qty: remaining, purchasedAt: now, purchasedOn: localDate(settings.timezone), source: "list", sessionId: draft.sessionId, listId: draft.id, voidedAt: null, replacesId: null });
    await updateStockInTransaction(tx, row.barcode); count += remaining;
  }
  await metaStore.put({ key: "nextSeq", value: nextSeq });
  const completedAt = new Date().toISOString();
  await metaStore.put({ key: "shoppingDraft", value: { ...draft, completedAt, completionMode: "manual" } });
  await metaStore.put({ key: "lastCompletedShopAt", value: completedAt });
  await tx.done; return { alreadyCompleted: false, count };
}
