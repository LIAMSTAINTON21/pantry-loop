// IndexedDB stores products plus an append-only purchase/depletion history.
// Stock is rebuilt from active events after each change, keeping undo and edits consistent.
import { replayStock } from "./inventory.js";
import { calculateMeal, validateFood } from "./nutrition.js";

export const APP_ID = "pantry-loop";
export const SCHEMA_VERSION = 1;
const LEGACY_DB_NAME = "pantry-loop-data";
// Only the original, server-verified owner may reuse the pre-account cache.
// Other accounts always start in their own database; no old data is copied/deleted.
const LEGACY_OWNER_HASH = "cb324df3465be7f5779dbf7fded73b6668ab34a919c6d6b4862c1c7edb230992";
let databaseName = null;
let databaseAccountId = null;
const STORES = ["products", "purchases", "depletions", "meta"];
let databasePromise;
let generation = 0;
let dataChangeVersion = 0;
let changeChannel = null;

function ensureChangeChannel() {
  // Notify other tabs, which keep their own database connection and sync version.
  if (!databaseName || changeChannel || typeof window === "undefined" || typeof BroadcastChannel === "undefined") return changeChannel;
  changeChannel = new BroadcastChannel(`${databaseName}-changes`);
  changeChannel.addEventListener("message", () => {
    dataChangeVersion += 1;
    window.dispatchEvent(new Event("pantry:data-changed"));
  });
  return changeChannel;
}

function notifyDataChanged() {
  dataChangeVersion += 1;
  if (typeof window !== "undefined") {
    ensureChangeChannel()?.postMessage({ changed: true });
    window.dispatchEvent(new Event("pantry:data-changed"));
  }
}

const defaultSettings = {
  timezone: "Europe/London",
  categoryOrder: ["Fruit & veg", "Bakery", "Dairy", "Meat & fish", "Cupboard", "Frozen", "Household"],
  planningHorizonDays: 7,
  onlineLookup: true,
  lastMode: "buy",
  forceFallback: false
};

export function getDatabaseGeneration() { return generation; }
export function getDataChangeVersion() { return dataChangeVersion; }
export function getDatabaseAccountId() { return databaseAccountId; }

export async function bindDatabaseAccount(user) {
  if (!user?.id || !/^[a-zA-Z0-9-]{1,128}$/.test(user.id)) throw new Error("A verified account is required.");
  if (databaseAccountId && databaseAccountId !== user.id) throw new Error("Account changed. Reload before opening another pantry.");
  const startingGeneration = generation;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(user.email ?? "").trim().toLowerCase()));
  if (startingGeneration !== generation) throw new Error("Sign-in changed while opening the pantry.");
  if (databaseAccountId && databaseAccountId !== user.id) throw new Error("Account changed. Reload before opening another pantry.");
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  databaseAccountId = user.id;
  databaseName = user.email_confirmed_at && hash === LEGACY_OWNER_HASH ? LEGACY_DB_NAME : `${LEGACY_DB_NAME}-user-${user.id}`;
}

export async function releaseDatabaseAccount() {
  // Revoke access synchronously, even while an older connection is still opening.
  const pending = databasePromise;
  databasePromise = null; databaseName = null; databaseAccountId = null;
  generation++; dataChangeVersion++; changeChannel?.close(); changeChannel = null;
  try { (await pending)?.close(); } catch { /* failed opening needs no cleanup */ }
}

export async function openDatabase() {
  if (!databaseName || !databaseAccountId) throw new Error("Sign in before opening pantry data.");
  const openingGeneration = generation;
  // Reuse one connection, creating stores only during the first schema upgrade.
  ensureChangeChannel();
  databasePromise ??= globalThis.idb.openDB(databaseName, SCHEMA_VERSION, {
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
  if (openingGeneration !== generation || !databaseAccountId) throw new Error("The pantry session has ended.");
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
  notifyDataChanged();
  return value;
}

export async function getSettings() {
  return { ...defaultSettings, ...(await getMeta("settings", {})) };
}

export async function updateSettings(patch) {
  const settings = { ...(await getSettings()), ...patch, updatedAt: new Date().toISOString() };
  await setMeta("settings", settings);
  return settings;
}

export function localDate(timezone = "Europe/London", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function newProduct(barcode, barcodeFormat, name = null) {
  const createdAt = new Date().toISOString();
  return {
    barcode, barcodeFormat,
    name: name || `Unknown item · ${barcode.replace(/^code128:/, "")}`,
    brand: null, size: null, price: null, currency: "GBP", imageUrl: null, category: null, userEditedFields: name ? ["name"] : [],
    lookup: { state: barcodeFormat === "manual" || barcode.startsWith("code128:") ? "manual" : "pending", source: null, checkedAt: null, nextRetryAt: null },
    onHandQty: null, status: "unknown", isStaple: false, staplePeriodDays: null,
    defaultQty: 1, snoozeUntil: null, neverSuggest: false, createdAt, updatedAt: createdAt
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

// Save the scan, its product details, and the derived stock in one transaction.
// A failure therefore leaves nothing saved, so reviewing a different quantity is safe.
export async function recordEvent({ type, barcode, barcodeFormat, qty = 1, source = "scan", sessionId, listId = null, actionId = crypto.randomUUID(), name = null, productPatch = {}, userFields = [] }) {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("Quantity must be a positive whole number");
  if (!new Set(["purchase", "depletion"]).has(type)) throw new Error("Invalid event type");
  const db = await openDatabase();
  const tx = db.transaction(STORES, "readwrite");
  try {
  const eventStore = tx.objectStore(type === "purchase" ? "purchases" : "depletions");
  const existing = await eventStore.get(actionId);
  if (existing) {
    if (existing.barcode !== barcode || existing.qty !== qty || existing.voidedAt) throw new Error("This scan was already saved with different details");
    const product = await tx.objectStore("products").get(barcode);
    await tx.done; return { event: existing, duplicate: true, product };
  }

  const productStore = tx.objectStore("products");
  let product = await productStore.get(barcode);
  product ??= newProduct(barcode, barcodeFormat, name);
  product = { ...product, ...productPatch, userEditedFields: [...new Set([...(product.userEditedFields ?? []), ...userFields])], updatedAt: new Date().toISOString() };
  await productStore.put(product);
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
  if (type === "purchase" && product.snoozeUntil) await productStore.put({ ...product, snoozeUntil: null, updatedAt: now });
  if (type === "purchase" && listId) {
    const draftRow = await tx.objectStore("meta").get("shoppingDraft");
    if (draftRow?.value?.id === listId && !draftRow.value.completedAt) {
      await tx.objectStore("meta").put({ key: "shoppingDraft", value: { ...draftRow.value, lastLinkedPurchaseAt: now, updatedAt: now } });
    }
  }
  await updateStockInTransaction(tx, barcode);
  const savedProduct = await productStore.get(barcode);
  await tx.done;
  notifyDataChanged();
  return { event, duplicate: false, product: savedProduct };
  } catch (error) {
    // JavaScript validation errors do not automatically abort IndexedDB transactions.
    try { tx.abort(); } catch { /* already committed or aborted */ }
    try { await tx.done; } catch { /* report the original error below */ }
    throw error;
  }
}

export async function voidEvent(storeName, id) {
  // Mark the event inactive so sync and backups retain the history of its removal.
  if (!new Set(["purchases", "depletions"]).has(storeName)) throw new Error("Invalid event store");
  const db = await openDatabase();
  const tx = db.transaction([storeName, "products", storeName === "purchases" ? "depletions" : "purchases"], "readwrite");
  const store = tx.objectStore(storeName); const event = await store.get(id);
  if (!event || event.voidedAt) { await tx.done; return false; }
  await store.put({ ...event, voidedAt: new Date().toISOString() });
  if (storeName === "purchases" && event.clearedSnoozeUntil) {
    const later = (await store.index("barcode").getAll(event.barcode)).some(item => !item.voidedAt && item.seq > event.seq);
    const product = await tx.objectStore("products").get(event.barcode);
    if (!later && product?.snoozeUntil === null) await tx.objectStore("products").put({ ...product, snoozeUntil: event.clearedSnoozeUntil, updatedAt: new Date().toISOString() });
  }
  await updateStockInTransaction(tx, event.barcode); await tx.done; notifyDataChanged(); return true;
}

// Sets the total quantity of a group of events in one transaction: keeps the first still-active event (corrected if needed)
// and voids the rest, or voids all of them when qty is 0. Ids already voided elsewhere are ignored.
export async function setEventsQuantity(storeName, ids, qty) {
  if (!new Set(["purchases", "depletions"]).has(storeName)) throw new Error("Invalid event store");
  if (!Number.isSafeInteger(qty) || qty < 0) throw new Error("Quantity must be zero or more");
  const other = storeName === "purchases" ? "depletions" : "purchases";
  const db = await openDatabase(); const tx = db.transaction([storeName, other, "products"], "readwrite");
  const store = tx.objectStore(storeName); const now = new Date().toISOString();
  const active = (await Promise.all(ids.map(id => store.get(id)))).filter(event => event && !event.voidedAt);
  if (!active.length) { await tx.done; return { ids: [], qty: 0 }; }
  const [first, ...rest] = qty > 0 ? active : [null, ...active];
  for (const event of rest) await store.put({ ...event, voidedAt: now });
  let keptId = null;
  if (first && first.qty !== qty) {
    const replacement = { ...first, id: crypto.randomUUID(), qty, replacesId: first.id, voidedAt: null };
    await store.put({ ...first, voidedAt: now }); await store.add(replacement); keptId = replacement.id;
  } else if (first) keptId = first.id;
  if (!keptId && storeName === "purchases") {
    const earliest = active.reduce((a, b) => (a.seq < b.seq ? a : b));
    const later = (await store.index("barcode").getAll(earliest.barcode)).some(item => !item.voidedAt && item.seq > earliest.seq && !active.some(event => event.id === item.id));
    const product = await tx.objectStore("products").get(earliest.barcode);
    const snooze = active.map(event => event.clearedSnoozeUntil).find(Boolean);
    if (snooze && !later && product?.snoozeUntil === null) await tx.objectStore("products").put({ ...product, snoozeUntil: snooze, updatedAt: now });
  }
  await updateStockInTransaction(tx, active[0].barcode); await tx.done; notifyDataChanged();
  return { ids: keptId ? [keptId] : [], qty: keptId ? qty : 0 };
}

export async function correctEvent(storeName, id, qty) {
  // Keep the original sequence position: changing quantity must not reorder
  // purchases relative to later depletions when stock is replayed.
  if (!new Set(["purchases", "depletions"]).has(storeName)) throw new Error("Invalid event store");
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("Quantity must be positive");
  const other = storeName === "purchases" ? "depletions" : "purchases";
  const db = await openDatabase(); const tx = db.transaction([storeName, other, "products"], "readwrite");
  const store = tx.objectStore(storeName); const original = await store.get(id);
  if (!original || original.voidedAt) throw new Error("That event is no longer active");
  if (original.food) throw new Error("Edit food amounts in the Food diary so calories and stock stay linked.");
  const voidedAt = new Date().toISOString(); const replacement = { ...original, id: crypto.randomUUID(), qty, replacesId: original.id, voidedAt: null };
  await store.put({ ...original, voidedAt }); await store.add(replacement); await updateStockInTransaction(tx, original.barcode); await tx.done;
  notifyDataChanged(); return replacement;
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
  await updateStockInTransaction(tx, replacement.barcode); await tx.done; notifyDataChanged(); return true;
}

// Nutrition is embedded in the depletion, not a separate mutable diary table.
// Existing backup/sync/void logic therefore keeps calories and stock inseparable.
export async function recordMeal({ barcode, profile, amount, date, replacesId = null, actionId = crypto.randomUUID() }) {
  const { qty, totals } = calculateMeal(profile, amount);
  const db = await openDatabase();
  const tx = db.transaction(STORES, "readwrite");
  try {
    const store = tx.objectStore("depletions");
    const duplicate = await store.get(actionId);
    if (duplicate) {
      const saved = duplicate.food;
      if (duplicate.voidedAt || duplicate.barcode !== barcode || !saved || saved.date !== date || saved.amount !== amount || ["unit", "basis", "packSize", "kcal", "protein", "carbs", "fat"].some(key => (saved.profile[key] ?? null) !== (profile[key] ?? null))) throw new Error("This food entry was already saved with different details. Reopen the diary.");
      await tx.done; return duplicate;
    }
    const product = await tx.objectStore("products").get(barcode);
    if (!product) throw new Error("Add this product to your pantry first.");
    const original = replacesId ? await store.get(replacesId) : null;
    if (replacesId && (!original?.food || original.voidedAt || original.barcode !== barcode)) throw new Error("This food entry has changed. Reopen the diary.");
    const available = (product.onHandQty ?? 0) + (original?.qty ?? 0);
    if (qty > available + 1e-8) throw new Error("Not enough stock. Add the missing packs in In stock first.");
    const now = new Date().toISOString();
    const food = { name: product.name, date, amount, profile: structuredClone(profile), totals };
    validateFood(food, qty);
    const sequenceRow = await tx.objectStore("meta").get("nextSeq");
    const seq = original?.seq ?? sequenceRow?.value ?? 1;
    if (!original) await tx.objectStore("meta").put({ key: "nextSeq", value: seq + 1 });
    if (original) await store.put({ ...original, voidedAt: now });
    const event = { id: actionId, barcode, qty, seq, sessionId: "food-diary", finishedAt: original?.finishedAt ?? now, updatedAt: now, replacesId, voidedAt: null, food };
    await store.add(event);
    await tx.objectStore("products").put({ ...product, nutrition: structuredClone(profile), userEditedFields: [...new Set([...(product.userEditedFields ?? []), "nutrition"])], updatedAt: now });
    await updateStockInTransaction(tx, barcode);
    await tx.done; notifyDataChanged(); return event;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    try { await tx.done; } catch { /* preserve original error */ }
    throw error;
  }
}

export async function saveProduct(barcode, patch, userFields = []) {
  // Read and write under the same lock so a rename cannot overwrite a concurrent scan.
  const db = await openDatabase(); const tx = db.transaction("products", "readwrite");
  const store = tx.objectStore("products"); const product = await store.get(barcode);
  if (!product) throw new Error("Product not found");
  const userEditedFields = [...new Set([...(product.userEditedFields ?? []), ...userFields])];
  const updated = { ...product, ...patch, userEditedFields, updatedAt: new Date().toISOString() };
  await store.put(updated); await tx.done; notifyDataChanged(); return updated;
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

export async function replaceAll(validated, { notify = true, expectedVersion = null } = {}) {
  const db = await openDatabase(); generation += 1;
  const tx = db.transaction(STORES, "readwrite");
  // This first request runs only after earlier read/write transactions have
  // finished. Recheck while holding the transaction so an in-flight local edit
  // cannot be cleared by the snapshot captured before the network round-trip.
  await tx.objectStore("meta").get("schemaVersion");
  if (expectedVersion !== null && dataChangeVersion !== expectedVersion) {
    tx.abort(); try { await tx.done; } catch { /* intentional abort */ }
    return false;
  }
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
  if (notify) notifyDataChanged();
  return true;
}

export async function clearLocalData() {
  const db = await databasePromise;
  db?.close(); databasePromise = null; generation += 1;
  if (!databaseName) throw new Error("No signed-in account to clear.");
  await globalThis.idb.deleteDB(databaseName);
  dataChangeVersion += 1;
}

export async function logCheckedDraft(draft) {
  // Scanned purchases may already cover a checked row; record only the remainder
  // and complete the draft in the same transaction to make retries harmless.
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
  await metaStore.put({ key: "shoppingDraft", value: { ...draft, completedAt, updatedAt: completedAt, completionMode: "manual" } });
  await metaStore.put({ key: "lastCompletedShopAt", value: completedAt });
  await tx.done; notifyDataChanged(); return { alreadyCompleted: false, count };
}
