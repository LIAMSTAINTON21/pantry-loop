import { getState } from "../db.js";
import { el, empty, sectionTitle, button } from "../ui.js";

// Show only positive replayed quantities; unknown or finished products remain
// in the catalogue without implying that stock is on hand.
export async function renderStock() {
  const { products } = await getState();
  const stock = products.filter(product => product.onHandQty > 0).sort((a, b) => a.name.localeCompare(b.name));
  const root = el("div", { class: "stack" }, [sectionTitle("In stock at home.", "Confirmed Buy / add stock scans are saved here automatically. Quantities are estimated packs, not pack sizes.")]);
  if (!stock.length) root.append(empty("No stock recorded yet", "Scan groceries in Buy / add stock mode and press the tick to save."));
  for (const product of stock) root.append(el("article", { class: "product-item" }, [
    el("div", { class: "row spread" }, [el("h2", { text: product.name }), el("span", { class: "badge", text: `×${product.onHandQty}` })]),
    el("p", { class: "meta", text: [product.brand, product.size].filter(Boolean).join(" · ") })
  ]));
  root.append(button("Scan groceries", "primary", () => { location.hash = "#scan"; }), button("Manage product details in Catalogue", "secondary", () => { location.hash = "#catalogue"; }));
  return { root };
}
