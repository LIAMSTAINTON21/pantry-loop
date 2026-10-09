import { getState, recordEvent, voidEvent } from "../db.js";
import { el, empty, sectionTitle } from "../ui.js";
import { displayAmount } from "../nutrition.js";

// Show only positive replayed quantities; unknown or finished products remain
// in the catalogue without implying that stock is on hand.
export async function renderStock(context) {
  const state = await getState(); const root = el("div", { class: "stack" });
  const inStock = state.products.filter(product => product.status === "in_stock" && product.onHandQty > 0)
    .sort((a, b) => String(a.category ?? "~").localeCompare(String(b.category ?? "~")) || a.name.localeCompare(b.name));
  const packs = inStock.reduce((sum, product) => sum + product.onHandQty, 0);
  root.append(sectionTitle("What’s at home.", "Tap − when you use a pack and + if you find another. Anything that hits 0 goes on your shopping list."));
  if (!inStock.length) { root.append(empty("Nothing in stock yet", "Scan your shopping in, or add opening stock from the Catalogue.")); return { root }; }
  root.append(el("h2", { class: "list-section" }, ["In stock", el("span", { class: "list-count", text: `${inStock.length} item${inStock.length === 1 ? "" : "s"} · ${packs} pack${packs === 1 ? "" : "s"}` })]));

  let currentCategory = null; let group = null;
  for (const product of inStock) {
    const categoryLabel = product.category || "Uncategorised";
    if (categoryLabel !== currentCategory) { currentCategory = categoryLabel; group = el("div", { class: "aisle-group" }, [el("h3", { class: "aisle-label", text: categoryLabel })]); root.append(group); }
    let onHand = product.onHandQty;
    const value = el("output", { text: displayAmount(onHand), "aria-label": `${onHand} packs on hand` });
    const stockText = () => product.nutrition ? `${displayAmount(onHand * product.nutrition.packSize)} ${product.nutrition.unit} left · ${product.brand ?? ""}` : [product.size, product.brand].filter(Boolean).join(" · ") || "On hand";
    const meta = el("p", { class: "meta", text: stockText() });
    const row = el("article", { class: "list-item stock-item" });
    const record = async (type, button) => {
      button.disabled = true;
      try {
        const { event, product: updated } = await recordEvent({ type, barcode: product.barcode, barcodeFormat: product.barcodeFormat, qty: 1, source: "manual", sessionId: crypto.randomUUID() });
        onHand = Math.max(0, updated.onHandQty ?? 0);
        value.textContent = displayAmount(onHand); value.setAttribute("aria-label", `${onHand} packs on hand`); meta.textContent = stockText();
        row.classList.toggle("is-empty", onHand === 0); minus.disabled = onHand === 0;
        if (onHand === 0) meta.textContent = "Finished · added to your shopping list";
        const store = type === "purchase" ? "purchases" : "depletions";
        context.toast(type === "purchase" ? `Added one ${product.name}` : onHand === 0 ? `${product.name} finished` : `Used one ${product.name} · ${onHand} left`, {
          action: async () => { await voidEvent(store, event.id); context.toast("Undone"); context.refresh(); }
        });
      } catch (error) { context.toast(error.message || "That did not save", { error: true }); }
      finally { if (onHand > 0 || type === "purchase") button.disabled = false; }
    };
    const minus = el("button", { type: "button", text: "−", "aria-label": `Used one ${product.name}` });
    const plus = el("button", { type: "button", text: "+", "aria-label": `Add one ${product.name}` });
    minus.addEventListener("click", () => record("depletion", minus));
    plus.addEventListener("click", () => record("purchase", plus));
    row.append(el("div", { class: "list-main" }, [el("p", { class: "item-title", text: product.name }), meta]), el("div", { class: "quantity" }, [minus, value, plus]));
    group.append(row);
  }
  return { root };
}
