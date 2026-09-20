import { generateList } from "../list.js";
import { getMeta, getSettings, getState, logCheckedDraft, setMeta, updateSettings, saveProduct } from "../db.js";
import { el, empty, sectionTitle, button } from "../ui.js";

function mergeDraft(generated, current) {
  const old = new Map((current?.items ?? []).map(item => [item.barcode, item]));
  return generated.map(item => ({ ...item, qty: old.get(item.barcode)?.qty ?? item.qty, checked: old.get(item.barcode)?.checked ?? false }));
}

export async function renderList(context) {
  const state = await getState(); const settings = await getSettings(); const today = context.today(settings.timezone);
  const generated = generateList(state.products, state.purchases, state.depletions, today, settings);
  let draft = await getMeta("shoppingDraft");
  if (!draft || draft.completedAt) draft = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), createdAt: new Date().toISOString(), completedAt: null, completionMode: null, items: [] };
  draft.items = mergeDraft(generated, draft); await setMeta("shoppingDraft", draft);

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
      const save = async () => setMeta("shoppingDraft", draft);
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
  const actions = el("section", { class: "card stack" }, [el("h2", { text: "Done shopping?" }), el("p", { class: "meta", text: "Choose exactly how to record this shop." })]);
  actions.append(button("I’ll scan the bags", "primary", async () => { draft.scanningActive = true; draft.completionMode = "scan"; await setMeta("shoppingDraft", draft); location.hash = "#scan"; }), button("Log checked purchases", "secondary", async () => { const result = await logCheckedDraft(draft); context.toast(result.alreadyCompleted ? "This shop is already recorded" : `Recorded ${result.count} pack${result.count === 1 ? "" : "s"}`); context.refresh(); }));
  root.append(actions); return { root };
}
