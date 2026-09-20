import { getMeta, getSettings, localDate, openDatabase, recordEvent, setMeta, updateSettings, voidEvent } from "./db.js";
import { processLookupQueue } from "./lookup.js";
import { renderScan } from "./views/scan.js";
import { renderList } from "./views/list.js";
import { renderCatalogue } from "./views/catalogue.js";
import { renderSettings } from "./views/settings.js";

const app = document.querySelector("#app");
const title = document.querySelector("#page-title");
const toastRegion = document.querySelector("#toast-region");
const networkStatus = document.querySelector("#network-status");
const offlineStatus = document.querySelector("#offline-status");
const views = { scan: renderScan, list: renderList, catalogue: renderCatalogue, settings: renderSettings };
const labels = { scan: "Scan", list: "Shopping list", catalogue: "Catalogue", settings: "Settings" };
let cleanup = null;
let activeRoute = null;
let savingBlocked = false;
let backupReminderShown = false;
let waitingWorker = null;
let reloadForUpdate = false;
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
  if (navigator.onLine) processLookupQueue();
}
window.addEventListener("online", updateNetwork); window.addEventListener("offline", updateNetwork); updateNetwork();

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
  const write = () => recordEvent({ type, barcode: detection.code, barcodeFormat: detection.format, qty, source: detection.source ?? "scan", sessionId, listId, actionId });
  try {
    const result = await write();
    const row = sessionRows.get(detection.code) ?? { name: result.product.name, qty: 0, ids: [], type };
    row.qty += qty; row.ids.push(result.event.id);
    row.message = type === "purchase" ? `${result.product.onHandQty} estimated on hand` : (result.product.onHandQty > 0 ? `Finished one · ${result.product.onHandQty} left` : (result.product.neverSuggest ? "Suggestions off" : result.product.snoozeUntil && result.product.snoozeUntil > localDate(settings.timezone) ? "Snoozed" : "Ran out · added to list"));
    sessionRows.set(detection.code, row);
    navigator.vibrate?.(55);
    toast(`${row.name} · ${row.message}`, { action: async () => { await voidEvent(type === "purchase" ? "purchases" : "depletions", result.event.id); row.qty -= qty; if (row.qty <= 0) sessionRows.delete(detection.code); await renderRoute(); } });
    window.dispatchEvent(new Event("sessionchange"));
    processLookupQueue();
  } catch (error) {
    savingBlocked = true;
    toast("Not saved · retry", { error: true, actionLabel: "Retry", duration: 0, action: async () => { try { await write(); savingBlocked = false; toast("Saved on retry"); await renderRoute(); } catch { toast("Still not saved · retry", { error: true, duration: 0, actionLabel: "Retry", action: async () => { savingBlocked = false; await acceptCode(detection); } }); } } });
    throw error;
  }
}

async function renderRoute() {
  cleanup?.(); cleanup = null;
  const route = location.hash.slice(1) || "scan"; activeRoute = views[route] ? route : "scan";
  document.querySelectorAll(".bottom-nav a").forEach(link => link.toggleAttribute("aria-current", link.dataset.route === activeRoute));
  title.textContent = labels[activeRoute];
  const settings = await getSettings();
  const activeDraft = await getMeta("shoppingDraft");
  const context = {
    settings, activeDraft, toast, acceptCode,
    setMode: async mode => { await updateSettings({ lastMode: mode }); await setMeta("activeSession", { id: sessionId, startedAt: (await getMeta("activeSession"))?.startedAt ?? new Date().toISOString(), mode }); settings.lastMode = mode; },
    sessionEvents: () => [...sessionRows.values()],
    today: (timezone, date) => localDate(timezone, date),
    refresh: renderRoute,
    finishScanDraft: async () => {
      if (activeDraft?.scanningActive && !activeDraft.completedAt) {
        const completedAt = new Date().toISOString();
        await setMeta("shoppingDraft", { ...activeDraft, scanningActive: false, completedAt, completionMode: "scan" });
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

window.addEventListener("hashchange", renderRoute);
document.addEventListener("visibilitychange", () => { if (document.hidden) cleanup?.(); else if (activeRoute === "scan") renderRoute(); });
window.addEventListener("dbblocked", () => toast("Close other Pantry Loop tabs to finish the update", { error: true, duration: 0 }));

await openDatabase();
await setMeta("activeSession", { id: sessionId, startedAt: new Date().toISOString(), mode: (await getSettings()).lastMode });
await registerWorker();
await renderRoute();
processLookupQueue();
