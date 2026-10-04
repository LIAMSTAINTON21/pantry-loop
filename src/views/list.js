import { generateList } from "../list.js";
import { getMeta, getSettings, getState, logCheckedDraft, setMeta, saveProduct } from "../db.js";
import { formatFullShoppingList, nextTescoItem, normaliseTescoProgress, openTescoSearch, undoTescoProgress, updateTescoProgress } from "../tesco.js";
import { el, empty, sectionTitle, button } from "../ui.js";
import { confirmSheet, openSheet } from "../sheet.js";
import { icon } from "../icons.js";

function showItemSheet(item, { onSnooze }) {
  const error = el("p", { class: "confirm-error", role: "alert" });
  const weeks = [1, 2, 4].map(count => el("button", { type: "button", class: "secondary", text: `${count} week${count > 1 ? "s" : ""}`, onclick: () => sheet.run(() => onSnooze(count), { error }) }));
  const sheet = openSheet({
    title: item.name,
    subtitle: [item.size, ...item.reasons.map(reason => reason.label)].filter(Boolean).join(" · "),
    content: [el("p", { class: "sheet-label", text: "Not needed right now? Hide it for:" }), el("div", { class: "choice-row" }, weeks), error, button("Close", "ghost", () => sheet.close())]
  });
}

function mergeDraft(generated, current) {
  const old = new Map((current?.items ?? []).map(item => [item.barcode, item]));
  return generated.map(item => ({ ...item, qty: old.get(item.barcode)?.qty ?? item.qty, checked: old.get(item.barcode)?.checked ?? false }));
}

export async function renderList(context) {
  const state = await getState(); const settings = await getSettings(); const today = context.today(settings.timezone);
  const generated = generateList(state.products, state.purchases, state.depletions, today, settings);
  let draft = await getMeta("shoppingDraft");
  if (!draft || draft.completedAt) { const createdAt = new Date().toISOString(); draft = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), createdAt, updatedAt: createdAt, completedAt: null, completionMode: null, items: [] }; }
  const mergedItems = mergeDraft(generated, draft);
  if (JSON.stringify(mergedItems) !== JSON.stringify(draft.items)) {
    draft.items = mergedItems;
    draft.updatedAt = new Date().toISOString();
    await setMeta("shoppingDraft", draft);
  }

  const root = el("div", { class: "stack list-view" }); root.append(sectionTitle("Your next shop.", "Tick things off as you shop. Tap an item to snooze it."));
  if (!draft.items.length) { root.append(empty("Nothing to buy right now", "Finish a pack, add a staple, or build purchase history to get suggestions.")); return { root }; }

  const renderSection = (title, items) => {
    if (!items.length) return;
    root.append(el("h2", { class: "list-section" }, [title, el("span", { class: "list-count", text: `${items.length} item${items.length === 1 ? "" : "s"}` })]));
    let currentCategory = null; let group = null;
    for (const item of items) {
      const categoryLabel = item.category || "Uncategorised";
      if (categoryLabel !== currentCategory) { currentCategory = categoryLabel; group = el("div", { class: "aisle-group" }, [el("h3", { class: "aisle-label", text: categoryLabel })]); root.append(group); }
      const checkbox = el("input", { type: "checkbox", "aria-label": `Mark ${item.name} checked` }); checkbox.checked = item.checked;
      const quantity = el("output", { text: String(item.qty), "aria-label": `${item.qty} packs` });
      const save = async () => { draft.updatedAt = new Date().toISOString(); return setMeta("shoppingDraft", draft); };
      checkbox.addEventListener("change", () => { item.checked = checkbox.checked; save(); updateShopBar(); });
      const minus = button("−", "secondary", () => { item.qty = Math.max(1, item.qty - 1); quantity.textContent = String(item.qty); save(); }); minus.setAttribute("aria-label", `Reduce ${item.name} quantity`);
      const plus = button("+", "secondary", () => { item.qty += 1; quantity.textContent = String(item.qty); save(); }); plus.setAttribute("aria-label", `Increase ${item.name} quantity`);
      const snooze = async weeks => {
        const until = new Date(); until.setDate(until.getDate() + weeks * 7);
        await saveProduct(item.barcode, { snoozeUntil: context.today(settings.timezone, until) }); context.toast(`Snoozed ${item.name} for ${weeks} week${weeks > 1 ? "s" : ""}`); context.refresh();
      };
      const note = item.reasons.find(reason => reason.note)?.note;
      const main = el("button", { type: "button", class: "list-main", "aria-haspopup": "dialog" }, [el("span", { class: "item-title", text: item.name }), el("span", { class: "meta", text: [item.size, ...item.reasons.map(reason => reason.label)].filter(Boolean).join(" · ") }), note && el("span", { class: "badge warn", text: note })]);
      main.addEventListener("click", () => showItemSheet(item, { onSnooze: snooze }));
      group.append(el("article", { class: "list-item" }, [checkbox, main, el("div", { class: "quantity" }, [minus, quantity, plus])]));
    }
  };
  renderSection("Ran out", draft.items.filter(item => item.section === "ran_out"));
  renderSection("Other suggestions", draft.items.filter(item => item.section !== "ran_out"));

  let tescoProgress = normaliseTescoProgress(draft.items, draft.tescoExport);
  draft.tescoExport = tescoProgress;
  const tesco = el("details", { class: "card tesco-export" });
  const tescoMeta = el("span", { class: "meta" });
  const tescoBody = el("div", { class: "stack tesco-body" });
  const tescoStatus = el("div", { class: "stack" });
  const saveTescoProgress = async () => { draft.tescoExport = tescoProgress; draft.updatedAt = new Date().toISOString(); await setMeta("shoppingDraft", draft); };
  const confirmation = (kind, onConfirm) => {
    const isCopy = kind === "copy";
    const panel = el("div", { class: "export-warning stack", role: "alert" }, [
      el("p", { class: "item-title", text: isCopy ? "Copy the full list?" : "Start the Tesco handoff?" }),
      el("p", { text: isCopy
        ? "This replaces your current clipboard contents. If you then open Tesco, actions there cannot be undone by Pantry Loop."
        : "Each item opens Tesco in a new tab. Opening external tabs and anything you add on Tesco cannot be undone here." }),
      el("p", { class: "meta", text: "You can undo or reset only the local Tesco progress marks shown in Pantry Loop." })
    ]);
    const cancel = button("Cancel", "ghost", () => panel.remove());
    const confirm = button(isCopy ? "Yes, copy full list" : "I understand, continue", "primary", async () => {
      confirm.disabled = true;
      try { await onConfirm(); panel.remove(); } catch (error) { context.toast(error.message || "That did not work", { error: true }); confirm.disabled = false; }
    });
    panel.append(el("div", { class: "row wrap" }, [confirm, cancel]));
    tesco.querySelector(".export-warning")?.remove();
    tescoBody.append(panel); confirm.focus();
  };
  const renderTescoStatus = () => {
    const added = new Set(tescoProgress.addedBarcodes);
    const skipped = new Set(tescoProgress.skippedBarcodes);
    const opened = new Set(tescoProgress.openedBarcodes);
    const next = nextTescoItem(draft.items, tescoProgress);
    const completed = added.size + skipped.size;
    tescoMeta.textContent = !tescoProgress.confirmedAt ? "Copy the list, or add items one at a time" : next ? `${completed} of ${draft.items.length} done · next: ${next.name}` : "All items reviewed";
    const undoProgress = button("Undo last mark", "ghost", async () => { tescoProgress = undoTescoProgress(draft.items, tescoProgress); await saveTescoProgress(); renderTescoStatus(); });
    undoProgress.disabled = !tescoProgress.history.length;
    tescoStatus.replaceChildren(...[
      el("div", { class: "row spread wrap" }, [
        el("p", { class: "meta", text: tescoProgress.confirmedAt ? `${completed} of ${draft.items.length} reviewed locally` : "Not started" }),
        tescoProgress.confirmedAt && el("div", { class: "row wrap" }, [
          undoProgress,
          button("Reset local progress", "ghost", async () => {
            if (!await confirmSheet({ title: "Reset Tesco progress?", message: "This only clears the marks in Pantry Loop. It can’t close Tesco tabs or change your Tesco basket.", confirmLabel: "Reset progress", danger: true })) return;
            tescoProgress = normaliseTescoProgress(draft.items); await saveTescoProgress(); renderTescoStatus();
          })
        ])
      ]),
      tescoProgress.confirmedAt && el("ol", { class: "tesco-progress-list" }, draft.items.map(item => el("li", { class: added.has(item.barcode) ? "is-added" : skipped.has(item.barcode) ? "is-skipped" : "" }, [
        el("span", { text: `${item.qty} × ${item.name}` }),
        el("span", { class: "meta", text: added.has(item.barcode) ? "Marked added" : skipped.has(item.barcode) ? "Skipped" : opened.has(item.barcode) ? "Opened · confirm below" : item.barcode === next?.barcode ? "Next" : "Waiting" })
      ]))),
      tescoProgress.confirmedAt && next && el("div", { class: "tesco-next stack" }, [
        el("p", { class: "item-title", text: `Next: ${next.qty} × ${next.name}` }),
        el("p", { class: "meta", text: "Choose the product and add it yourself on Tesco. Pantry Loop never signs in or changes your Tesco basket." }),
        el("div", { class: "row wrap" }, [
          button("Open next item in Tesco", "primary", () => {
            openTescoSearch(next, window.open.bind(window));
            tescoProgress = updateTescoProgress(draft.items, tescoProgress, next.barcode, "opened");
            saveTescoProgress(); renderTescoStatus(); context.toast("Tesco search requested · allow pop-ups if no tab appeared");
          }),
          button("Mark added", "secondary", async () => { tescoProgress = updateTescoProgress(draft.items, tescoProgress, next.barcode, "added"); await saveTescoProgress(); renderTescoStatus(); }),
          button("Skip", "ghost", async () => { tescoProgress = updateTescoProgress(draft.items, tescoProgress, next.barcode, "skipped"); await saveTescoProgress(); renderTescoStatus(); })
        ])
      ]),
      tescoProgress.confirmedAt && !next && el("p", { class: "callout success", text: "All items have been reviewed locally. Check your Tesco basket before checkout." })
    ].filter(Boolean));
  };
  tesco.append(el("summary", { class: "tesco-summary" }, [el("span", { class: "tesco-summary-text" }, [el("span", { class: "item-title", text: "Send to Tesco" }), tescoMeta]), icon("chevron", { size: 18 })]), tescoBody);
  tescoBody.append(
    el("p", { class: "meta", text: "Tesco has no basket import, so copy the full list or open one Tesco search at a time." }),
    el("div", { class: "row wrap" }, [
      button("Copy full list", "secondary", () => confirmation("copy", async () => {
        await navigator.clipboard.writeText(formatFullShoppingList(draft.items)); context.toast("Full shopping list copied");
      })),
      button(tescoProgress.confirmedAt ? "Continue Tesco handoff" : "Start Tesco handoff", "primary", () => {
        if (tescoProgress.confirmedAt) { renderTescoStatus(); tescoStatus.querySelector("button.primary")?.focus(); return; }
        confirmation("handoff", async () => { tescoProgress.confirmedAt = new Date().toISOString(); await saveTescoProgress(); renderTescoStatus(); });
      })
    ]),
    tescoStatus
  );
  renderTescoStatus();
  if (tescoProgress.confirmedAt && nextTescoItem(draft.items, tescoProgress)) tesco.open = true;
  root.append(tesco);

  // "Done shopping" stays reachable above the nav instead of sitting at the bottom of the page.
  const logChecked = button("Log ticked", "secondary", async () => { const result = await logCheckedDraft(draft); context.toast(result.alreadyCompleted ? "This shop is already recorded" : `Recorded ${result.count} pack${result.count === 1 ? "" : "s"}`); context.refresh(); });
  const scanBags = button("Scan the bags", "primary", async () => { draft.scanningActive = true; draft.completionMode = "scan"; draft.updatedAt = new Date().toISOString(); await setMeta("shoppingDraft", draft); location.hash = "#scan"; });
  function updateShopBar() {
    const ticked = draft.items.filter(item => item.checked).length;
    // With nothing ticked this still closes the shop, as logCheckedDraft always has.
    logChecked.textContent = ticked ? `Log ${ticked} ticked` : "Finish shop";
  }
  root.append(el("div", { class: "shop-bar", role: "region", "aria-label": "Done shopping" }, [el("span", { class: "shop-bar-label", text: "Done shopping?" }), logChecked, scanBags]), el("div", { class: "shop-bar-spacer", "aria-hidden": "true" }));
  updateShopBar();
  return { root };
}
