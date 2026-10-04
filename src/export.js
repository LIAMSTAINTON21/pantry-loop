import { APP_ID, SCHEMA_VERSION, getState, replaceAll, setMeta } from "./db.js";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const isoDateTime = value => typeof value === "string" && !Number.isNaN(Date.parse(value));
const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const nullableIso = value => value === null || isoDateTime(value);

export function validateBackup(data) {
  if (!data || typeof data !== "object" || data.appId !== APP_ID) throw new Error("This is not a Pantry Loop backup");
  if (!Number.isSafeInteger(data.schemaVersion) || data.schemaVersion > SCHEMA_VERSION) throw new Error("This backup needs a newer app version");
  if (data.schemaVersion !== SCHEMA_VERSION) throw new Error("This older backup format is not supported yet");
  for (const key of ["products", "purchases", "depletions", "meta"]) if (!Array.isArray(data[key])) throw new Error(`Missing ${key} records`);

  const productKeys = new Set();
  for (const product of data.products) {
    if (!product || typeof product.barcode !== "string" || !product.barcode || productKeys.has(product.barcode)) throw new Error("Product keys must be unique strings");
    if (typeof product.name !== "string" || !isoDateTime(product.createdAt)) throw new Error(`Invalid product ${product.barcode}`);
    if (!Number.isSafeInteger(product.defaultQty) || product.defaultQty <= 0) throw new Error(`Invalid default quantity for ${product.barcode}`);
    if (product.snoozeUntil !== null && !day(product.snoozeUntil)) throw new Error(`Invalid snooze date for ${product.barcode}`);
    productKeys.add(product.barcode);
  }

  const ids = new Set(); const activeSeq = new Set(); const eventTypes = new Map();
  const allEvents = [...data.purchases.map(event => [event, "purchase"]), ...data.depletions.map(event => [event, "depletion"])];
  for (const [event, type] of allEvents) {
    if (!event || typeof event.id !== "string" || !event.id || ids.has(event.id)) throw new Error("Event IDs must be unique strings");
    if (!positiveInt(event.seq) || !positiveInt(event.qty) || !productKeys.has(event.barcode)) throw new Error(`Invalid event ${event.id}`);
    if (typeof event.sessionId !== "string" || !nullableIso(event.voidedAt) || (event.replacesId !== null && typeof event.replacesId !== "string")) throw new Error(`Invalid event metadata ${event.id}`);
    if (type === "purchase") {
      if (!isoDateTime(event.purchasedAt) || !day(event.purchasedOn) || !["scan", "manual", "list", "opening_stock"].includes(event.source) || (event.listId !== null && typeof event.listId !== "string")) throw new Error(`Invalid purchase ${event.id}`);
    } else if (!isoDateTime(event.finishedAt)) throw new Error(`Invalid depletion ${event.id}`);
    if (!event.voidedAt) {
      if (activeSeq.has(event.seq)) throw new Error(`More than one active event uses sequence ${event.seq}`);
      activeSeq.add(event.seq);
    }
    ids.add(event.id); eventTypes.set(event.id, type);
  }
  for (const [event, type] of allEvents) {
    if (event.replacesId && !ids.has(event.replacesId)) throw new Error(`Replacement ${event.id} refers to a missing event`);
    if (event.replacesId && eventTypes.get(event.replacesId) !== type) throw new Error(`Replacement ${event.id} crosses event types`);
    const seen = new Set([event.id]); let cursor = event;
    while (cursor.replacesId) {
      if (seen.has(cursor.replacesId)) throw new Error(`Replacement cycle at ${event.id}`);
      seen.add(cursor.replacesId);
      cursor = allEvents.find(([candidate]) => candidate.id === cursor.replacesId)?.[0];
      if (!cursor) break;
      if (cursor.seq !== event.seq || cursor.barcode !== event.barcode) throw new Error(`Replacement ${event.id} changes identity or sequence`);
    }
  }
  const metaKeys = new Set();
  for (const row of data.meta) {
    if (!row || typeof row.key !== "string" || !("value" in row) || metaKeys.has(row.key)) throw new Error("Invalid settings record");
    metaKeys.add(row.key);
    if (row.key === "shoppingDraft" && row.value !== null) {
      const draft = row.value;
      if (!draft || typeof draft.id !== "string" || typeof draft.sessionId !== "string" || !Array.isArray(draft.items)) throw new Error("Invalid shopping draft");
      const draftCodes = new Set();
      for (const item of draft.items) {
        if (!item || !productKeys.has(item.barcode) || draftCodes.has(item.barcode) || !positiveInt(item.qty) || typeof item.checked !== "boolean") throw new Error("Invalid shopping draft item");
        draftCodes.add(item.barcode);
      }
    }
  }
  const meta = structuredClone(data.meta).map(row => {
    if (row.key !== "settings" || !row.value || typeof row.value !== "object") return row;
    const { catalogueProxyUrl: _catalogue, visionProxyUrl: _vision, ...safeSettings } = row.value;
    return { ...row, value: safeSettings };
  });
  return { products: structuredClone(data.products), purchases: structuredClone(data.purchases), depletions: structuredClone(data.depletions), meta };
}

export async function buildBackup() {
  const state = await getState();
  return { appId: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...validateBackup({ appId: APP_ID, schemaVersion: SCHEMA_VERSION, ...state }) };
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportJson() {
  const backup = await buildBackup(); const stamp = backup.exportedAt.slice(0, 10);
  download(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }), `pantry-loop-backup-${stamp}.json`);
  await setMeta("lastJsonBackupRequest", backup.exportedAt);
}

const excelText = value => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};

function sheet(rows, columns) {
  const values = [columns, ...rows.map(row => columns.map(column => excelText(row[column])))];
  const worksheet = globalThis.XLSX.utils.aoa_to_sheet(values);
  for (const address of Object.keys(worksheet)) if (address[0] !== "!") worksheet[address].t = "s";
  return worksheet;
}

export async function exportExcel() {
  if (!globalThis.XLSX) throw new Error("Excel export library unavailable");
  const state = await getState(); const metaMap = new Map(state.meta.map(row => [row.key, row.value]));
  const workbook = globalThis.XLSX.utils.book_new();
  const productCols = ["barcode", "barcodeFormat", "name", "brand", "size", "price", "currency", "imageUrl", "category", "userEditedFields", "lookup", "onHandQty", "status", "isStaple", "staplePeriodDays", "defaultQty", "snoozeUntil", "neverSuggest", "createdAt"];
  const purchaseCols = ["id", "seq", "barcode", "qty", "purchasedAt", "purchasedOn", "source", "sessionId", "listId", "voidedAt", "replacesId", "clearedSnoozeUntil"];
  const depletionCols = ["id", "seq", "barcode", "qty", "finishedAt", "sessionId", "voidedAt", "replacesId"];
  const draft = metaMap.get("shoppingDraft");
  const listRows = (draft?.items ?? []).map(item => ({ listId: draft.id, createdAt: draft.createdAt, completedAt: draft.completedAt, barcode: item.barcode, name: item.name, checked: item.checked, qty: item.qty, reasons: item.reasons }));
  globalThis.XLSX.utils.book_append_sheet(workbook, sheet(state.products, productCols), "Products");
  globalThis.XLSX.utils.book_append_sheet(workbook, sheet(state.purchases, purchaseCols), "Purchases");
  globalThis.XLSX.utils.book_append_sheet(workbook, sheet(state.depletions, depletionCols), "Depletions");
  globalThis.XLSX.utils.book_append_sheet(workbook, sheet(listRows, ["listId", "createdAt", "completedAt", "barcode", "name", "checked", "qty", "reasons"]), "List");
  globalThis.XLSX.utils.book_append_sheet(workbook, sheet(state.meta.map(row => ({ key: row.key, value: row.value })), ["key", "value"]), "Settings");
  globalThis.XLSX.writeFile(workbook, `pantry-loop-${new Date().toISOString().slice(0, 10)}.xlsx`, { cellDates: false, bookType: "xlsx" });
}

export async function readBackupFile(file) {
  if (!file || file.size > MAX_IMPORT_BYTES) throw new Error("Choose a JSON backup smaller than 50 MiB");
  let data; try { data = JSON.parse(await file.text()); } catch { throw new Error("The selected file is not valid JSON"); }
  return validateBackup(data);
}

export async function restoreBackup(validated) {
  await replaceAll(validated);
  await setMeta("cloudResetAt", new Date().toISOString());
  await setMeta("cloudReplacePending", true);
}
