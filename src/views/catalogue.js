import { getState, newProduct, openDatabase, recordEvent, saveProduct } from "../db.js";
import { retryLookup } from "../lookup.js";
import { el, empty, sectionTitle, button, field } from "../ui.js";

export async function renderCatalogue(context) {
  const state = await getState(); const root = el("div", { class: "stack" });
  root.append(sectionTitle("Everything you buy.", "Fix names, set staples, enter opening stock, and review estimated packs."));
  const unresolved = state.products.filter(product => product.lookup?.state === "pending" || product.name.startsWith("Unknown item"));
  if (unresolved.length) root.append(el("div", { class: "callout", text: `${unresolved.length} item${unresolved.length === 1 ? " needs" : "s need"} a name.` }));

  const addForm = el("form", { class: "card stack" }); const addName = el("input", { required: "", placeholder: "Loose apples" }); const opening = el("input", { type: "number", min: "0", step: "1", value: "0" });
  const addSubmit = button("Add product", "primary"); addSubmit.type = "submit";
  addForm.append(el("h2", { text: "Add a manual product" }), field("Name", addName), field("Opening packs (optional)", opening), addSubmit);
  addForm.addEventListener("submit", async event => { event.preventDefault(); const barcode = `manual:${crypto.randomUUID()}`; const qty = Number(opening.value); if (qty > 0) await recordEvent({ type: "purchase", barcode, barcodeFormat: "manual", qty, source: "opening_stock", sessionId: crypto.randomUUID(), name: addName.value.trim() }); else { const db = await openDatabase(); await db.add("products", newProduct(barcode, "manual", addName.value.trim())); } context.toast("Manual product added"); context.refresh(); });
  root.append(addForm, el("h2", { text: `Catalogue · ${state.products.length}` }));
  if (!state.products.length) { root.append(empty("Your catalogue is empty", "Scan a pack or add a manual product to begin.")); return { root }; }

  const sorted = [...state.products].sort((a, b) => a.name.localeCompare(b.name));
  for (const product of sorted) {
    const card = el("article", { class: "product-item" });
    const name = el("input", { value: product.name, "aria-label": `Name for ${product.barcode}` });
    const brand = el("input", { value: product.brand ?? "", placeholder: "Brand" });
    const size = el("input", { value: product.size ?? "", placeholder: "Size" });
    const price = el("input", { value: product.price ?? "", type: "number", min: "0", step: "0.01", placeholder: "Price" });
    const category = el("input", { value: product.category ?? "", placeholder: "Aisle / category" });
    const staple = el("input", { type: "checkbox" }); staple.checked = product.isStaple;
    const period = el("input", { type: "number", min: "1", step: "1", value: product.staplePeriodDays ?? 7 });
    const never = el("input", { type: "checkbox" }); never.checked = product.neverSuggest;
    const openingQty = el("input", { type: "number", min: "1", step: "1", value: "1", "aria-label": `Opening stock quantity for ${product.name}` });
    const save = button("Save changes", "secondary", async () => {
      await saveProduct(product.barcode, { name: name.value.trim(), brand: brand.value.trim() || null, size: size.value.trim() || null, price: price.value === "" ? null : Number(price.value), category: category.value.trim() || null, isStaple: staple.checked, staplePeriodDays: staple.checked ? Number(period.value) : null, neverSuggest: never.checked, lookup: name.value.trim() ? { ...product.lookup, state: product.lookup.state === "pending" ? "manual" : product.lookup.state } : product.lookup }, ["name", "brand", "size", "price", "category"]);
      context.toast("Product saved"); context.refresh();
    });
    card.append(el("div", { class: "row spread" }, [el("span", { class: "badge", text: product.status === "in_stock" ? `${product.onHandQty} on hand` : product.status.replace("_", " ") }), el("span", { class: product.lookup?.state === "pending" ? "badge warn" : "badge", text: product.lookup?.state ?? "local" })]));
    if (product.imageUrl) card.append(el("img", { class: "product-image", src: product.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }));
    card.append(field("Name", name), el("div", { class: "row" }, [field("Brand", brand), field("Size", size)]), el("div", { class: "row" }, [field("Price (£)", price), field("Aisle / category", category)]), el("div", { class: "row wrap" }, [el("label", { class: "row" }, [staple, document.createTextNode("Scheduled staple")]), field("Every days", period), el("label", { class: "row" }, [never, document.createTextNode("Suggestions off")])]), el("p", { class: "meta", text: `${product.barcode}${product.lookup?.source ? ` · ${product.lookup.source}` : ""}` }), el("div", { class: "row wrap" }, [save, product.lookup?.state !== "manual" && button("Retry online name", "ghost", async () => { await retryLookup(product.barcode); context.toast("Name retry queued"); })]), el("div", { class: "divider" }), el("p", { class: "meta", text: "Use once to seed packs already at home." }), el("div", { class: "row" }, [openingQty, button("Add opening stock", "ghost", async () => { await recordEvent({ type: "purchase", barcode: product.barcode, barcodeFormat: product.barcodeFormat, qty: Number(openingQty.value), source: "opening_stock", sessionId: crypto.randomUUID() }); context.toast("Opening stock added"); context.refresh(); })]));
    root.append(card);
  }
  return { root };
}
