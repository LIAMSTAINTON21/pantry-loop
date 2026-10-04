import { getMeta, getSettings, localDate, openDatabase, recordEvent, saveProduct, setMeta, updateSettings, voidEvent } from "./db.js";
import { requireAuthentication } from "./auth.js";
import { startSynchronization, synchronizeNow } from "./sync.js";
import { showScanConfirmation } from "./confirmation.js";
import { showIdentificationFallback } from "./identification.js";
import { identifyBarcode, processLookupQueue } from "./lookup.js";
import { renderScan } from "./views/scan.js";
import { renderList } from "./views/list.js";
import { renderCatalogue } from "./views/catalogue.js";
import { renderSettings } from "./views/settings.js";

const app = document.querySelector("#app");
const title = document.querySelector("#page-title");
const toastRegion = document.querySelector("#toast-region");
const networkStatus = document.querySelector("#network-status");
const offlineStatus = document.querySelector("#offline-status");
const syncStatus = document.querySelector("#sync-status");
const views = { scan: renderScan, list: renderList, catalogue: renderCatalogue, settings: renderSettings };
const labels = { scan: "Scan", list: "Shopping list", catalogue: "Catalogue", settings: "Settings" };
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
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
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
      details = await showIdentificationFallback({ barcode: detection.code, barcodeFormat: detection.format, settings, toast });
    }
    if (!details) { if (scannerPausedForFallback && !document.hidden) await renderRoute(); return; }
  }
  const write = async () => {
    const saved = await recordEvent({ type, barcode: detection.code, barcodeFormat: detection.format, qty, source: detection.source ?? "scan", sessionId, listId, actionId, name: details.name });
    const editable = ["name", "brand", "size", "price", "category"].filter(field => details[field] !== null && details[field] !== undefined && details[field] !== "");
    const product = await saveProduct(detection.code, {
      ...Object.fromEntries(["name", "brand", "size", "price", "currency", "imageUrl", "category"].map(field => [field, details[field] ?? saved.product[field] ?? null])),
      lookup: { state: details.source === "Manual entry" || details.source === "Vision identification" ? "manual" : "resolved", source: details.source, checkedAt: new Date().toISOString(), nextRetryAt: null }
    }, details.source === "Manual entry" ? editable : []);
    return { ...saved, product };
  };
  try {
    const result = await write();
    const row = sessionRows.get(detection.code) ?? { name: result.product.name, qty: 0, ids: [], type };
    row.qty += qty; row.ids.push(result.event.id);
    row.message = type === "purchase" ? `${result.product.onHandQty} estimated on hand` : (result.product.onHandQty > 0 ? `Finished one · ${result.product.onHandQty} left` : (result.product.neverSuggest ? "Suggestions off" : result.product.snoozeUntil && result.product.snoozeUntil > localDate(settings.timezone) ? "Snoozed" : "Ran out · added to list"));
    sessionRows.set(detection.code, row);
    navigator.vibrate?.(55);
    confirmationOpen = true;
    try {
      await showScanConfirmation({
        name: row.name, message: row.message, mode: type,
        onRename: async nextName => { await saveProduct(detection.code, { name: nextName, lookup: { ...result.product.lookup, state: "manual" } }, ["name"]); row.name = nextName; },
        onRemove: async () => { await voidEvent(type === "purchase" ? "purchases" : "depletions", result.event.id); row.qty -= qty; row.ids = row.ids.filter(id => id !== result.event.id); if (row.qty <= 0) sessionRows.delete(detection.code); }
      });
    } finally {
      confirmationOpen = false;
      window.dispatchEvent(new Event("sessionchange"));
      if ((resumeScanAfterConfirmation || scannerPausedForFallback) && !document.hidden) { resumeScanAfterConfirmation = false; renderRoute(); }
    }
  } catch (error) {
    savingBlocked = true;
    toast("Not saved · retry", { error: true, actionLabel: "Retry", duration: 0, action: async () => { try { await write(); savingBlocked = false; toast("Saved on retry"); await renderRoute(); } catch { toast("Still not saved · retry", { error: true, duration: 0, actionLabel: "Retry", action: async () => { savingBlocked = false; await acceptCode(detection); } }); } } });
    throw error;
  }
}

async function identifyWithoutBarcode() {
  if (savingBlocked) return;
  const settings = await getSettings();
  const details = await showIdentificationFallback({ settings, toast });
  if (!details) return;
  await acceptCode({ code: details.barcode ?? `manual:${crypto.randomUUID()}`, format: details.barcodeFormat ?? "manual", qty: 1, source: "manual", details });
}

async function renderRoute() {
  if (!appAuthenticated) return;
  cleanup?.(); cleanup = null;
  const route = location.hash.slice(1) || "scan"; activeRoute = views[route] ? route : "scan";
  document.querySelectorAll(".bottom-nav a").forEach(link => link.toggleAttribute("aria-current", link.dataset.route === activeRoute));
  title.textContent = labels[activeRoute];
  const settings = await getSettings();
  const activeDraft = await getMeta("shoppingDraft");
  const context = {
    settings, activeDraft, toast, acceptCode, identifyWithoutBarcode,
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
    const rendered = await views[activeRoute](context); app.replaceChildren(rendered.root); cleanup = rendered.cleanup ?? null; app.focus({ preventScroll: true });
  } catch (error) {
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
