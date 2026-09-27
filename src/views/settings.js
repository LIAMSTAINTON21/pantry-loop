import { exportExcel, exportJson, readBackupFile, restoreBackup } from "../export.js";
import { correctEvent, getRecentActivity, getSettings, getState, setMeta, undoCorrection, updateSettings, voidEvent } from "../db.js";
import { el, empty, sectionTitle, button, field } from "../ui.js";

export async function renderSettings(context) {
  const settings = await getSettings(); const state = await getState(); const root = el("div", { class: "stack" });
  root.append(sectionTitle("Keep it yours.", "Control online naming, storage, backups, and scanner diagnostics."));
  const preferences = el("section", { class: "card stack" }, [el("h2", { text: "Preferences" })]);
  const online = el("input", { type: "checkbox" }); online.checked = settings.onlineLookup;
  const fallback = el("input", { type: "checkbox" }); fallback.checked = settings.forceFallback;
  const timezone = el("input", { value: settings.timezone, placeholder: "Europe/London" });
  preferences.append(el("label", { class: "row" }, [online, document.createTextNode("Online product details (barcode only)")]), el("label", { class: "row" }, [fallback, document.createTextNode("Force offline scanner fallback")]), field("Shopping timezone", timezone), button("Save preferences", "secondary", async () => { await updateSettings({ onlineLookup: online.checked, forceFallback: fallback.checked, timezone: timezone.value.trim() || "Europe/London" }); context.toast("Preferences saved"); }));
  root.append(preferences);

  const integrations = el("section", { class: "card stack" }, [el("h2", { text: "Product identification" }), el("p", { class: "meta", text: "Use HTTPS proxy endpoints that keep Tesco/Pepesto and Vision API keys on a server. Never paste an API key here." })]);
  const catalogueProxyUrl = el("input", { type: "url", value: settings.catalogueProxyUrl ?? "", placeholder: "https://your-proxy.example/tesco-product" });
  const visionProxyUrl = el("input", { type: "url", value: settings.visionProxyUrl ?? "", placeholder: "https://your-proxy.example/identify-product" });
  integrations.append(field("Tesco catalogue proxy URL", catalogueProxyUrl), field("Vision identification proxy URL", visionProxyUrl), el("p", { class: "meta", text: "Without a Tesco proxy, barcode lookup uses Open Food Facts. Without a Vision proxy, the photo option moves safely to manual entry." }), button("Save integrations", "secondary", async () => {
    const validate = value => { const clean = value.trim(); if (!clean) return ""; const url = new URL(clean); if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("Proxy URLs must use HTTPS"); return url.href; };
    try { await updateSettings({ catalogueProxyUrl: validate(catalogueProxyUrl.value), visionProxyUrl: validate(visionProxyUrl.value) }); context.toast("Integration settings saved"); }
    catch (error) { context.toast(error.message, { error: true }); }
  }));
  root.append(integrations);

  const storage = el("section", { class: "card stack" }, [el("h2", { text: "Device storage" })]);
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  storage.append(el("p", { class: "meta", text: persisted ? "Persistent storage is granted." : "The browser may clear this app’s data when space is low. Backups remain important." }));
  if (!persisted && navigator.storage?.persist) storage.append(button("Ask for persistent storage", "secondary", async () => { const granted = await navigator.storage.persist(); await setMeta("storagePersistent", granted); context.toast(granted ? "Persistent storage granted" : "Browser did not grant persistent storage"); context.refresh(); }));
  root.append(storage);

  const backup = el("section", { class: "card stack" }, [el("h2", { text: "Export" }), el("p", { class: "meta", text: "JSON is the complete restorable backup. Excel is a readable snapshot. Each button downloads one file." }), button("Download JSON backup", "primary", async () => { await exportJson(); context.toast("JSON backup requested"); }), button("Download Excel workbook", "secondary", async () => { await exportExcel(); context.toast("Excel export requested"); })]);
  root.append(backup);

  const restore = el("section", { class: "card stack" }, [el("h2", { text: "Restore JSON" }), el("p", { class: "meta", text: "Validation happens before any current data changes. A restore replaces everything on this device." })]);
  const file = el("input", { type: "file", accept: ".json,application/json" }); const summary = el("div", { class: "callout", hidden: "" }); const confirm = button("Replace current data", "danger"); confirm.disabled = true; let validated = null;
  file.addEventListener("change", async () => { try { validated = await readBackupFile(file.files[0]); summary.hidden = false; summary.textContent = `${validated.products.length} products, ${validated.purchases.length} purchases, ${validated.depletions.length} depletions. Download a current backup before replacing data.`; confirm.disabled = false; } catch (error) { validated = null; confirm.disabled = true; context.toast(error.message, { error: true }); } });
  confirm.addEventListener("click", async () => { if (!validated || !window.confirm("Replace all current Pantry Loop data with this backup?")) return; context.stopScanner(); await restoreBackup(validated); context.toast("Backup restored"); context.refresh(); });
  restore.append(file, summary, confirm); root.append(restore);

  const activity = await getRecentActivity(); root.append(el("h2", { text: "Recent activity" }));
  if (!activity.length) root.append(empty("No activity yet"));
  else for (const item of activity) {
    const card = el("article", { class: "activity-item" }, [el("p", { class: "item-title", text: item.name }), el("p", { class: "meta", text: `${item.type === "purchase" ? "Bought" : "Finished"} · ${item.qty} pack${item.qty === 1 ? "" : "s"} · ${new Date(item.occurredAt).toLocaleString()}${item.voidedAt ? " · Undone" : ""}` })]);
    if (!item.voidedAt) {
      const store = item.type === "purchase" ? "purchases" : "depletions";
      const qty = el("input", { type: "number", min: "1", step: "1", value: item.qty, "aria-label": `Correct quantity for ${item.name}` });
      card.append(el("div", { class: "row wrap" }, [qty, button("Correct quantity", "secondary", async () => { const replacement = await correctEvent(store, item.id, Number(qty.value)); context.toast("Quantity corrected", { action: async () => { await undoCorrection(store, replacement.id); context.toast("Correction undone"); context.refresh(); } }); context.refresh(); }), button(item.replacesId ? "Restore original" : "Undo this entry", "ghost", async () => { if (item.replacesId) await undoCorrection(store, item.id); else await voidEvent(store, item.id); context.toast(item.replacesId ? "Original restored" : "Entry undone"); context.refresh(); })]));
    }
    root.append(card);
  }
  root.append(el("section", { class: "card stack" }, [el("h2", { text: "About" }), el("p", { class: "meta", text: `Pantry Loop 1.2.1 · ${state.products.length} products · Barcode details use your Tesco proxy or Open Food Facts. Product photos are uploaded only when you deliberately take one and a Vision proxy is configured.` })]));
  return { root };
}
