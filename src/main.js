// Coordinate authentication, routes, barcode review, and local saves. The database
// is the source of durable stock; sessionRows is only this tab's editable scan list.
import { correctEvent, getMeta, getSettings, localDate, openDatabase, recordEvent, saveProduct, setMeta, updateSettings, voidEvent } from "./db.js";
import { requireAuthentication } from "./auth.js";
import { startSynchronization, synchronizeNow } from "./sync.js";
import { showScanConfirmation, showRemovalConfirmation } from "./confirmation.js";
import { showIdentificationFallback } from "./identification.js";
import { identifyBarcode, processLookupQueue } from "./lookup.js";
import { renderScan } from "./views/scan.js";
import { renderList } from "./views/list.js";
import { renderCatalogue } from "./views/catalogue.js";
import { renderSettings } from "./views/settings.js";
import { renderStock } from "./views/stock.js";
import { RepeatGate } from "./scanner.js";

const app = document.querySelector("#app");
const title = document.querySelector("#page-title");
const toastRegion = document.querySelector("#toast-region");
const networkStatus = document.querySelector("#network-status");
const offlineStatus = document.querySelector("#offline-status");
const syncStatus = document.querySelector("#sync-status");
const views = { scan: renderScan, list: renderList, stock: renderStock, catalogue: renderCatalogue, settings: renderSettings };
const labels = { scan: "Scan", list: "Shopping list", stock: "In Stock", catalogue: "Catalogue", settings: "Settings" };
let cleanup = null;
let activeRoute = null;
let savingBlocked = false;
let backupReminderShown = false;
let waitingWorker = null;
let reloadForUpdate = false;
let confirmationOpen = false;
let resumeScanAfterConfirmation = false;
let appAuthenticated = false;
const sessionId = crypto.randomUUID();
const sessionRows = new Map();
// Keep barcode suppression across camera restarts; holding the same pack must not
// create another entry after closing a dialog or returning from a hidden tab.
const scanGate = new RepeatGate();
let routeVersion = 0;

function toast(message, { error = false, action = null, actionLabel = "Undo", duration = 10000 } = {}) {
  toastRegion.replaceChildren();
  const node = document.createElement("div"); node.className = `toast${error ? " error" : ""}`;
  const text = document.createElement("span"); text.textContent = message; node.append(text);
  if (action) { const control = document.createElement("button"); control.type = "button"; control.textContent = actionLabel; control.addEventListener("click", async () => { await action(); node.remove(); }); node.append(control); }
  toastRegion.append(node); if (duration) setTimeout(() => node.remove(), duration);
}

function updateNetwork() {
  networkStatus.textContent = navigator.onLine ? "Online" : "Offline";
  if (appAuthenticated && navigator.onLine) processLookupQueue();
}

function offerUpdate() {
  if (!waitingWorker || activeRoute === "scan" || savingBlocked) return;
  toast("An app update is ready", { actionLabel: "Update", duration: 0, action: () => { reloadForUpdate = true; cleanup?.(); waitingWorker.postMessage({ type: "SKIP_WAITING" }); } });
}

async function registerWorker() {
  if (!("serviceWorker" in navigator)) { offlineStatus.textContent = "Offline unavailable"; return; }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js?release=scan-4", { scope: "./", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    waitingWorker = registration.waiting;
    offlineStatus.textContent = navigator.serviceWorker.controller ? "Ready offline" : "Reload once for offline";
    navigator.serviceWorker.addEventListener("controllerchange", () => { offlineStatus.textContent = "Ready offline"; if (reloadForUpdate) location.reload(); });
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => { if (worker.state === "installed" && navigator.serviceWorker.controller) { waitingWorker = worker; offerUpdate(); } });
    });
  } catch { offlineStatus.textContent = "Offline setup failed · retry later"; }
}

async function acceptCode(detection) {
  if (confirmationOpen) return;
  confirmationOpen = true;
  try { await reviewCode(detection); }
  finally {
    await finishConfirmation();
  }
}

async function finishConfirmation() {
  confirmationOpen = false;
  window.dispatchEvent(new Event("sessionchange"));
  if (resumeScanAfterConfirmation && !document.hidden) {
    resumeScanAfterConfirmation = false;
    await renderRoute();
  }
}

async function reviewCode(detection) {
  // Capture the mode and shopping-list link before opening any dialogs, so one
  // review always produces one event with a consistent meaning.
  if (savingBlocked) throw new Error("Resolve the unsaved item before scanning more");
  const settings = await getSettings(); const type = settings.lastMode === "buy" ? "purchase" : "depletion";
  const draft = await getMeta("shoppingDraft");
  const listId = type === "purchase" && draft?.scanningActive && !draft.completedAt ? draft.id : null;
  const actionId = crypto.randomUUID(); const qty = detection.qty ?? 1;
  let details = detection.details ?? null;
  let scannerPausedForFallback = false;
  if (!details) {
    const identified = await identifyBarcode(detection.code, settings);
    details = identified.match;
    if (!details) {
      if (activeRoute === "scan" && cleanup) { cleanup(); cleanup = null; scannerPausedForFallback = true; }
      resumeScanAfterConfirmation = scannerPausedForFallback;
      details = await showIdentificationFallback({ barcode: detection.code, barcodeFormat: detection.format, initialImage: detection.image, autoIdentify: true, settings, toast });
    }
    if (!details) return;
    // The identification dialog can scan a corrected barcode; save its details
    // against that code rather than the code which first opened the dialog.
    detection = { ...detection, code: details.barcode ?? detection.code, format: details.barcodeFormat ?? detection.format };
  }
  const write = async chosenQty => {
    const editable = ["name", "brand", "size", "price", "category"].filter(field => details[field] !== null && details[field] !== undefined && details[field] !== "");
    const productPatch = {
      ...Object.fromEntries(["name", "brand", "size", "price", "currency", "imageUrl", "category"].filter(field => details[field] != null).map(field => [field, details[field]])),
      lookup: { state: details.source === "Manual entry" || details.source === "Vision identification" ? "manual" : "resolved", source: details.source, checkedAt: new Date().toISOString(), nextRetryAt: null }
    };
    return recordEvent({ type, barcode: detection.code, barcodeFormat: detection.format, qty: chosenQty, source: detection.source ?? "scan", sessionId, listId, actionId, name: details.name, productPatch, userFields: details.source === "Manual entry" ? editable : [] });
  };
  await showScanConfirmation({
    name: details.name, qty, mode: type,
    message: type === "purchase" ? "Choose how many packs to add to your stock." : "Choose how many packs you have used up.",
    onRename: async name => { details = { ...details, name, source: "Manual entry" }; },
    onRemove: async () => {},
    onConfirm: async chosenQty => {
      const result = await write(chosenQty);
      sessionRows.set(result.event.id, { id: result.event.id, barcode: detection.code, type, name: result.product.name, qty: result.event.qty,
        message: type === "purchase" ? "Added to stock" : "Used up" });
      try { navigator.vibrate?.(55); } catch { /* feedback must never make a saved scan appear to fail */ }
    }
  });
}

async function editSessionItem(item, removeOnly = false) {
  // Corrections replace one event in history; they do not overwrite total stock.
  if (confirmationOpen) return;
  confirmationOpen = true;
  const store = item.type === "purchase" ? "purchases" : "depletions";
  const remove = async () => { await voidEvent(store, item.id); sessionRows.delete(item.id); };
  try {
    if (removeOnly) { if (await showRemovalConfirmation(item.name, "Remove only this saved session entry? Earlier stock is kept.")) await remove(); }
    else await showScanConfirmation({ name: item.name, qty: item.qty, mode: item.type, message: "Edit this saved session entry. Zero removes this entry, not earlier stock.",
      removalMessage: "This saved entry will be removed from your stock history. Earlier entries are kept.",
      onRename: async name => { await saveProduct(item.barcode, { name }, ["name"]); for (const row of sessionRows.values()) if (row.barcode === item.barcode) row.name = name; },
      onRemove: remove,
      onConfirm: async qty => { if (qty === item.qty) return; const replacement = await correctEvent(store, item.id, qty); sessionRows.delete(item.id); sessionRows.set(replacement.id, { ...item, id: replacement.id, qty }); }
    });
  } catch (error) { toast(error.message || "Could not change this item", { error: true }); }
  finally { await finishConfirmation(); }
}

async function identifyWithoutBarcode() {
  if (savingBlocked || confirmationOpen) return;
  confirmationOpen = true;
  // Camera cleanup and the modal lock span both identification and quantity review.
  cleanup?.(); cleanup = null; resumeScanAfterConfirmation = true;
  try {
    const settings = await getSettings();
    const details = await showIdentificationFallback({ settings, toast });
    if (!details) return;
    await reviewCode({ code: details.barcode ?? `manual:${crypto.randomUUID()}`, format: details.barcodeFormat ?? "manual", qty: 1, source: "manual", details });
  } catch (error) { toast(error.message || "Could not identify this item", { error: true }); }
  finally { await finishConfirmation(); }
}

async function renderRoute() {
  if (!appAuthenticated) return;
  if (confirmationOpen) { resumeScanAfterConfirmation = true; return; }
  const version = ++routeVersion;
  cleanup?.(); cleanup = null;
  const route = location.hash.slice(1) || "scan"; activeRoute = views[route] ? route : "scan";
  const renderingRoute = activeRoute;
  document.querySelectorAll(".bottom-nav a").forEach(link => { if (link.dataset.route === activeRoute) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); });
  title.textContent = labels[activeRoute];
  const settings = await getSettings();
  const activeDraft = await getMeta("shoppingDraft");
  if (version !== routeVersion || !appAuthenticated) return;
  if (confirmationOpen) { resumeScanAfterConfirmation = true; return; }
  const context = {
    settings, activeDraft, toast, acceptCode, identifyWithoutBarcode, editSessionItem, scanGate,
    setMode: async mode => { await updateSettings({ lastMode: mode }); await setMeta("activeSession", { id: sessionId, startedAt: (await getMeta("activeSession"))?.startedAt ?? new Date().toISOString(), mode }); settings.lastMode = mode; },
    sessionEvents: () => [...sessionRows.values()],
    today: (timezone, date) => localDate(timezone, date),
    refresh: renderRoute,
    finishScanDraft: async () => {
      if (activeDraft?.scanningActive && !activeDraft.completedAt) {
        const completedAt = new Date().toISOString();
        await setMeta("shoppingDraft", { ...activeDraft, scanningActive: false, completedAt, updatedAt: completedAt, completionMode: "scan" });
        await setMeta("lastCompletedShopAt", completedAt); backupReminderShown = false;
      }
    },
    stopScanner: () => cleanup?.()
  };
  try {
    const rendered = await views[renderingRoute](context);
    // A slower old route must release its camera rather than replace the newer view.
    if (version !== routeVersion || !appAuthenticated) { rendered.cleanup?.(); return; }
    app.replaceChildren(rendered.root); cleanup = rendered.cleanup ?? null; app.focus({ preventScroll: true });
  } catch (error) {
    if (version !== routeVersion || !appAuthenticated) return;
    const heading = document.createElement("h1"); heading.textContent = "This view couldn’t open."; const detail = document.createElement("p"); detail.className = "callout error"; detail.textContent = error.message; app.replaceChildren(heading, detail); console.error(error);
  }
  checkBackupReminder();
  offerUpdate();
}

async function checkBackupReminder() {
  if (backupReminderShown) return;
  const completed = await getMeta("lastCompletedShopAt"); if (!completed) return;
  const lastBackup = await getMeta("lastJsonBackupRequest");
  if (!lastBackup || Date.now() - Date.parse(lastBackup) >= 30 * 86400000) {
    backupReminderShown = true;
    toast(lastBackup ? "Your JSON backup is over 30 days old" : "Your first shop is recorded · make a JSON backup", { duration: 0, actionLabel: "Back up", action: () => { location.hash = "#settings"; } });
  }
}

const handleVisibilityChange = () => {
  if (!appAuthenticated) return;
  if (document.hidden) { if (activeRoute === "scan") { cleanup?.(); if (confirmationOpen) resumeScanAfterConfirmation = true; } }
  else if (activeRoute === "scan") { if (confirmationOpen) resumeScanAfterConfirmation = true; else renderRoute(); }
};
window.addEventListener("dbblocked", () => toast("Close other Pantry Loop tabs to finish the update", { error: true, duration: 0 }));

let stopSynchronization = async () => {};
let prepareLogout = async () => false;
const stopAppActivity = async () => {
  if (!appAuthenticated) return;
  appAuthenticated = false;
  routeVersion++;
  window.removeEventListener("online", updateNetwork); window.removeEventListener("offline", updateNetwork);
  window.removeEventListener("hashchange", renderRoute);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  await stopSynchronization(); cleanup?.();
};
window.addEventListener("pantrylogout", stopAppActivity);
await requireAuthentication({ beforeLogout: () => prepareLogout() });
appAuthenticated = true;
window.addEventListener("online", updateNetwork); window.addEventListener("offline", updateNetwork); updateNetwork();
window.addEventListener("hashchange", renderRoute);
document.addEventListener("visibilitychange", handleVisibilityChange);
await openDatabase();
let initialSyncError = null;
try { await synchronizeNow(); syncStatus.textContent = "Cloud synced"; }
catch (error) { initialSyncError = error; syncStatus.textContent = "Sync unavailable"; }
stopSynchronization = startSynchronization({ onStatus: (status, error) => {
  syncStatus.textContent = status === "syncing" ? "Syncing…" : status === "synced" ? "Cloud synced" : "Sync unavailable";
  if (status === "error") console.warn("Cloud synchronization failed", error);
} });
prepareLogout = async () => {
  await stopAppActivity();
  try { await synchronizeNow(); return true; }
  catch (error) { console.warn("Local data retained because final synchronization failed", error); return false; }
};
await setMeta("activeSession", { id: sessionId, startedAt: new Date().toISOString(), mode: (await getSettings()).lastMode });
await registerWorker();
await renderRoute();
if (initialSyncError) toast("Signed in, but cloud synchronization is temporarily unavailable", { error: true });
processLookupQueue();
