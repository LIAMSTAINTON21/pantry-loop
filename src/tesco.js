export const TESCO_SEARCH_BASE = "https://www.tesco.com/shop/en-GB/search?query=";

function quantity(item) {
  return Number.isSafeInteger(item?.qty) && item.qty > 0 ? item.qty : 1;
}

export function tescoSearchTerm(item) {
  return [item?.name, item?.size].map(value => String(value ?? "").trim()).filter(Boolean).join(" ");
}

export function tescoSearchUrl(item) {
  return `${TESCO_SEARCH_BASE}${encodeURIComponent(tescoSearchTerm(item))}`;
}

export function formatFullShoppingList(items) {
  return items.map(item => `${quantity(item)} × ${String(item?.name ?? "Unnamed item").trim() || "Unnamed item"}${item?.size ? ` · ${String(item.size).trim()}` : ""}`).join("\n");
}

export function normaliseTescoProgress(items, progress = {}) {
  const available = new Set(items.map(item => item.barcode));
  const uniqueAvailable = values => [...new Set(Array.isArray(values) ? values : [])].filter(value => available.has(value));
  const addedBarcodes = uniqueAvailable(progress.addedBarcodes);
  const added = new Set(addedBarcodes);
  const skippedBarcodes = uniqueAvailable(progress.skippedBarcodes).filter(value => !added.has(value));
  return {
    confirmedAt: typeof progress.confirmedAt === "string" ? progress.confirmedAt : null,
    currentBarcode: available.has(progress.currentBarcode) ? progress.currentBarcode : null,
    openedBarcodes: uniqueAvailable(progress.openedBarcodes),
    addedBarcodes,
    skippedBarcodes,
    history: uniqueAvailable(progress.history)
  };
}

export function nextTescoItem(items, progress) {
  const done = new Set([...(progress?.addedBarcodes ?? []), ...(progress?.skippedBarcodes ?? [])]);
  const current = items.find(item => item.barcode === progress?.currentBarcode && !done.has(item.barcode));
  return current ?? items.find(item => !done.has(item.barcode)) ?? null;
}

export function updateTescoProgress(items, progress, barcode, status) {
  const next = normaliseTescoProgress(items, progress);
  if (!items.some(item => item.barcode === barcode)) return next;
  next.addedBarcodes = next.addedBarcodes.filter(value => value !== barcode);
  next.skippedBarcodes = next.skippedBarcodes.filter(value => value !== barcode);
  if (status === "opened") {
    next.currentBarcode = barcode;
    if (!next.openedBarcodes.includes(barcode)) next.openedBarcodes.push(barcode);
  } else if (status === "added" || status === "skipped") {
    next[status === "added" ? "addedBarcodes" : "skippedBarcodes"].push(barcode);
    next.history = [...next.history.filter(value => value !== barcode), barcode];
    next.currentBarcode = null;
  }
  return next;
}

export function undoTescoProgress(items, progress) {
  const next = normaliseTescoProgress(items, progress);
  const barcode = next.history.pop();
  if (!barcode) return next;
  next.addedBarcodes = next.addedBarcodes.filter(value => value !== barcode);
  next.skippedBarcodes = next.skippedBarcodes.filter(value => value !== barcode);
  next.currentBarcode = barcode;
  return next;
}

export function openTescoSearch(item, openWindow = globalThis.open) {
  if (typeof openWindow !== "function") return null;
  const opened = openWindow(tescoSearchUrl(item), "_blank", "noopener,noreferrer");
  if (opened) {
    try { opened.opener = null; } catch { /* noopener is also requested in the feature string */ }
  }
  return opened;
}
