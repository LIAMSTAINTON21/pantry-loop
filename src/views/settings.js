import { exportExcel, exportJson, readBackupFile, restoreBackup } from "../export.js";
import { correctEvent, getRecentActivity, getSettings, getState, setMeta, undoCorrection, updateSettings, voidEvent } from "../db.js";
import { el, empty, sectionTitle, button, field } from "../ui.js";
import { confirmSheet, openSheet, stepper } from "../sheet.js";
import { icon } from "../icons.js";

function showActivitySheet(item, context) {
  const store = item.type === "purchase" ? "purchases" : "depletions";
  const error = el("p", { class: "confirm-error", role: "alert" });
  let save = null;
  const qty = stepper({ value: item.qty, min: 1, label: `${item.name} quantity`, unit: item.type === "purchase" ? "packs bought" : "packs finished", onChange: value => { if (save) save.disabled = value === item.qty; } });
  save = button("Save quantity", "primary", () => sheet.run(async () => {
    const replacement = await correctEvent(store, item.id, qty.value);
    context.toast("Quantity corrected", { action: async () => { await undoCorrection(store, replacement.id); context.toast("Correction undone"); context.refresh(); } });
    context.refresh();
  }, { error }));
  save.disabled = true;
  const undo = button(item.replacesId ? "Restore the original entry" : "Undo this entry", "danger", () => sheet.run(async () => {
    if (item.replacesId) await undoCorrection(store, item.id); else await voidEvent(store, item.id);
    context.toast(item.replacesId ? "Original restored" : "Entry undone"); context.refresh();
  }, { error }));
  const sheet = openSheet({ title: item.name, subtitle: `${item.type === "purchase" ? "Bought" : "Finished"} · ${new Date(item.occurredAt).toLocaleString()}`, content: [qty.node, save, undo, error, button("Cancel", "ghost", () => sheet.close())] });
}

export async function renderSettings(context) {
  const settings = await getSettings(); const state = await getState(); const root = el("div", { class: "stack" });
  root.append(sectionTitle("Keep it yours.", "Control online naming, storage, backups, and scanner diagnostics."));
  const preferences = el("section", { class: "card stack" }, [el("h2", { text: "Preferences" })]);
  const online = el("input", { type: "checkbox", class: "switch", role: "switch" }); online.checked = settings.onlineLookup;
  const fallback = el("input", { type: "checkbox", class: "switch", role: "switch" }); fallback.checked = settings.forceFallback;
  const timezone = el("input", { value: settings.timezone, placeholder: "Europe/London" });
  preferences.append(el("div", { class: "switch-group" }, [el("label", { class: "switch-row" }, [el("span", { class: "switch-text" }, [el("span", { text: "Look up product names online" }), el("span", { class: "meta", text: "Sends only the barcode" })]), online]), el("label", { class: "switch-row" }, [el("span", { class: "switch-text" }, [el("span", { text: "Use the offline scanner" }), el("span", { class: "meta", text: "Try this if scanning is unreliable" })]), fallback])]), field("Shopping timezone", timezone), button("Save preferences", "secondary", async () => { await updateSettings({ onlineLookup: online.checked, forceFallback: fallback.checked, timezone: timezone.value.trim() || "Europe/London" }); context.toast("Preferences saved"); }));
  root.append(preferences);

  root.append(el("section", { class: "card stack" }, [el("h2", { text: "Product identification" }), el("p", { class: "meta", text: "Product photos use the signed-in app’s protected AI service. API keys and service addresses cannot be entered or exported from this screen." })]));

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
  confirm.addEventListener("click", async () => { if (!validated || !await confirmSheet({ title: "Replace all data?", message: "Everything on this phone is replaced by the backup. Download a current backup first if you might need it.", confirmLabel: "Replace my data", danger: true })) return; context.stopScanner(); await restoreBackup(validated); context.toast("Backup restored"); context.refresh(); });
  restore.append(file, summary, confirm); root.append(restore);

  const activity = await getRecentActivity();
  root.append(el("h2", { class: "list-section" }, ["Recent activity", activity.length ? el("span", { class: "list-count", text: "Tap to fix a mistake" }) : null]));
  if (!activity.length) root.append(empty("No activity yet"));
  else {
    const list = el("div", { class: "product-list" });
    const rowFor = item => {
      const when = new Date(item.occurredAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      const meta = el("span", { class: "meta", text: `${item.qty} pack${item.qty === 1 ? "" : "s"} · ${when}${item.voidedAt ? " · Undone" : ""}` });
      const badge = el("span", { class: item.voidedAt ? "badge quiet" : item.type === "purchase" ? "badge" : "badge warn", text: item.type === "purchase" ? "Bought" : "Used" });
      if (item.voidedAt) return el("div", { class: "activity-row is-undone" }, [el("span", { class: "product-main" }, [el("span", { class: "item-title", text: item.name }), meta]), badge]);
      const row = el("button", { type: "button", class: "activity-row" }, [el("span", { class: "product-main" }, [el("span", { class: "item-title", text: item.name }), meta]), badge, icon("chevron", { size: 18 })]);
      row.addEventListener("click", () => showActivitySheet(item, context));
      return row;
    };
    const SHOWN = 8;
    list.append(...activity.slice(0, SHOWN).map(rowFor));
    root.append(list);
    if (activity.length > SHOWN) {
      const more = button(`Show ${activity.length - SHOWN} more`, "ghost", () => { list.append(...activity.slice(SHOWN).map(rowFor)); more.remove(); });
      root.append(more);
    }
  }
  root.append(el("section", { class: "card stack" }, [el("h2", { text: "About" }), el("p", { class: "meta", text: `Pantry Loop 1.5.0 · ${state.products.length} products · Barcode details use Open Food Facts. Product photos are uploaded only when you deliberately take one while signed in.` })]));
  return { root };
}
