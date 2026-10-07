import { generateList } from "../list.js";
import { getMeta, getSettings, getState, logCheckedDraft, setMeta, saveProduct } from "../db.js";
import { formatFullShoppingList, nextTescoItem, normaliseTescoProgress, openTescoSearch, undoTescoProgress, updateTescoProgress } from "../tesco.js";
import { el, empty, sectionTitle, button } from "../ui.js";

// A draft is separate from completed purchase events, so checking a suggestion
// does not change stock until the user confirms the list.

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

  const root = el("div", { class: "stack" }); root.append(sectionTitle("Your next shop.", "Run-outs come first. Suggestions stay editable and are saved on this device."));
  if (!draft.items.length) { root.append(empty("Nothing to buy right now", "Finish a pack, add a staple, or build purchase history to get suggestions.")); return { root }; }

  const renderSection = (title, items) => {
    if (!items.length) return;
    root.append(el("h2", { text: title }));
    let currentCategory = null;
    for (const item of items) {
      const categoryLabel = item.category || "Uncategorised";
      if (categoryLabel !== currentCategory) { currentCategory = categoryLabel; root.append(el("h3", { class: "muted", text: categoryLabel })); }
      const checkbox = el("input", { type: "checkbox", "aria-label": `Mark ${item.name} checked` }); checkbox.checked = item.checked;
      const quantity = el("output", { text: String(item.qty), "aria-label": `${item.qty} packs` });
      const save = async () => { draft.updatedAt = new Date().toISOString(); return setMeta("shoppingDraft", draft); };
      checkbox.addEventListener("change", () => { item.checked = checkbox.checked; save(); });
      const minus = button("−", "secondary", () => { item.qty = Math.max(1, item.qty - 1); quantity.textContent = String(item.qty); save(); }); minus.setAttribute("aria-label", `Reduce ${item.name} quantity`);
      const plus = button("+", "secondary", () => { item.qty += 1; quantity.textContent = String(item.qty); save(); }); plus.setAttribute("aria-label", `Increase ${item.name} quantity`);
      const snooze = button("Snooze", "ghost", async () => {
        const weeks = Number(prompt("Snooze for 1, 2, or 4 weeks", "1")); if (![1, 2, 4].includes(weeks)) return;
        const until = new Date(); until.setDate(until.getDate() + weeks * 7);
        await saveProduct(item.barcode, { snoozeUntil: context.today(settings.timezone, until) }); context.toast(`Snoozed ${item.name} for ${weeks} week${weeks > 1 ? "s" : ""}`); context.refresh();
      });
      root.append(el("article", { class: "list-item" }, [
        el("div", { class: "row" }, [checkbox, el("div", {}, [el("p", { class: "item-title", text: item.name }), el("p", { class: "meta", text: [item.size, item.category].filter(Boolean).join(" · ") || "Uncategorised" })])]),
        el("p", { class: "meta", text: item.reasons.map(reason => reason.label).join(" · ") }),
        item.reasons.find(reason => reason.note) && el("p", { class: "badge warn", text: item.reasons.find(reason => reason.note).note }),
        el("div", { class: "row spread wrap" }, [el("div", { class: "quantity" }, [minus, quantity, plus]), snooze])
      ]));
    }
  };
  renderSection("Ran out", draft.items.filter(item => item.section === "ran_out"));
  renderSection("Other suggestions", draft.items.filter(item => item.section !== "ran_out"));

  let tescoProgress = normaliseTescoProgress(draft.items, draft.tescoExport);
  draft.tescoExport = tescoProgress;
  const tesco = el("section", { class: "card stack tesco-export" });
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
    tesco.append(panel); confirm.focus();
  };
  const renderTescoStatus = () => {
    const added = new Set(tescoProgress.addedBarcodes);
    const skipped = new Set(tescoProgress.skippedBarcodes);
    const opened = new Set(tescoProgress.openedBarcodes);
    const next = nextTescoItem(draft.items, tescoProgress);
    const completed = added.size + skipped.size;
    const undoProgress = button("Undo last mark", "ghost", async () => { tescoProgress = undoTescoProgress(draft.items, tescoProgress); await saveTescoProgress(); renderTescoStatus(); });
    undoProgress.disabled = !tescoProgress.history.length;
    tescoStatus.replaceChildren(...[
      el("div", { class: "row spread wrap" }, [
        el("p", { class: "meta", text: tescoProgress.confirmedAt ? `${completed} of ${draft.items.length} reviewed locally` : "Not started" }),
        tescoProgress.confirmedAt && el("div", { class: "row wrap" }, [
          undoProgress,
          button("Reset local progress", "ghost", async () => {
            if (!confirm("Reset Pantry Loop’s Tesco progress? This cannot close Tesco tabs or remove anything from your Tesco basket.")) return;
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
  tesco.append(
    el("h2", { text: "Send to Tesco" }),
    el("p", { class: "meta", text: "Tesco does not provide a supported public basket import. Use a full text copy or open one official Tesco search at a time." }),
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
  root.append(tesco);

  const actions = el("section", { class: "card stack" }, [el("h2", { text: "Done shopping?" }), el("p", { class: "meta", text: "Choose exactly how to record this shop." })]);
  actions.append(button("I’ll scan the bags", "primary", async () => { draft.scanningActive = true; draft.completionMode = "scan"; draft.updatedAt = new Date().toISOString(); await setMeta("shoppingDraft", draft); location.hash = "#scan"; }), button("Log checked purchases", "secondary", async () => { const result = await logCheckedDraft(draft); context.toast(result.alreadyCompleted ? "This shop is already recorded" : `Recorded ${result.count} pack${result.count === 1 ? "" : "s"}`); context.refresh(); }));
  root.append(actions); return { root };
}
