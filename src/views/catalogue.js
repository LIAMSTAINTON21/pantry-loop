import { getState, newProduct, openDatabase, recordEvent, saveProduct } from "../db.js";
import { retryLookup } from "../lookup.js";
import { el, empty, sectionTitle, button, field } from "../ui.js";
import { openSheet, stepper } from "../sheet.js";
import { icon } from "../icons.js";

// Kept outside the view so saving a product (which re-renders) does not lose the search or filter.
const view = { query: "", filter: "all" };
addEventListener("hashchange", () => { if (location.hash !== "#catalogue") { view.query = ""; view.filter = "all"; } });

const needsName = product => product.lookup?.state === "pending" || product.name.startsWith("Unknown item");

function stockLabel(product) {
  if (product.status === "in_stock") return { text: `${product.onHandQty} at home`, tone: "" };
  if (product.status === "finished") return { text: "Ran out", tone: "warn" };
  return { text: "No stock yet", tone: "quiet" };
}

function toggle(labelText, checked, hint = null) {
  const input = el("input", { type: "checkbox", class: "switch", role: "switch" }); input.checked = checked;
  return { input, node: el("label", { class: "switch-row" }, [el("span", { class: "switch-text" }, [el("span", { text: labelText }), hint && el("span", { class: "meta", text: hint })]), input]) };
}

function showAddProduct(context) {
  const error = el("p", { class: "confirm-error", role: "alert" });
  const name = el("input", { required: "", autocomplete: "off", placeholder: "e.g. Loose apples", maxlength: "140" });
  const opening = stepper({ value: 0, min: 0, label: "Packs already at home", unit: "already at home" });
  const submit = el("button", { type: "submit", class: "primary", text: "Add product" });
  const form = el("form", { class: "stack" }, [field("Name", name), opening.node, error, submit, button("Cancel", "ghost", () => sheet.close())]);
  const sheet = openSheet({ title: "Add a product", subtitle: "For things without a barcode, like loose fruit.", content: [form] });
  form.addEventListener("submit", event => {
    event.preventDefault();
    sheet.run(async () => {
      const productName = name.value.trim(); if (!productName) throw new Error("Enter a name");
      const barcode = `manual:${crypto.randomUUID()}`; const qty = opening.value;
      if (qty > 0) await recordEvent({ type: "purchase", barcode, barcodeFormat: "manual", qty, source: "opening_stock", sessionId: crypto.randomUUID(), name: productName });
      else { const db = await openDatabase(); await db.add("products", newProduct(barcode, "manual", productName)); }
      context.toast(`${productName} added`); context.refresh();
    }, { error });
  });
  requestAnimationFrame(() => name.focus());
}

function showEditProduct(product, context) {
  const error = el("p", { class: "confirm-error", role: "alert" });
  const name = el("input", { value: product.name, required: "", maxlength: "140", autocomplete: "off" });
  const brand = el("input", { value: product.brand ?? "", placeholder: "Optional", autocomplete: "off" });
  const size = el("input", { value: product.size ?? "", placeholder: "e.g. 500 g" });
  const price = el("input", { value: product.price ?? "", type: "number", min: "0", step: "any", inputmode: "decimal", placeholder: "Optional" });
  const category = el("input", { value: product.category ?? "", placeholder: "e.g. Dairy" });
  const staple = toggle("Scheduled staple", product.isStaple, "Suggest it on a regular cycle");
  const period = el("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: product.staplePeriodDays ?? 7 });
  const periodField = field("Every how many days?", period);
  const never = toggle("Never suggest", product.neverSuggest, "Keep it off the shopping list");
  const syncPeriod = () => { periodField.hidden = !staple.input.checked; };
  staple.input.addEventListener("change", syncPeriod); syncPeriod();

  const save = el("button", { type: "submit", class: "primary", text: "Save changes" });
  const form = el("form", { class: "stack" }, [
    field("Name", name),
    el("div", { class: "field-pair" }, [field("Brand", brand), field("Size", size)]),
    el("div", { class: "field-pair" }, [field("Price (£)", price), field("Aisle / category", category)]),
    el("div", { class: "switch-group" }, [staple.node, periodField, never.node]),
    error, save
  ]);
  form.addEventListener("submit", event => {
    event.preventDefault();
    sheet.run(async () => {
      if (!name.value.trim()) throw new Error("Enter a name");
      await saveProduct(product.barcode, { name: name.value.trim(), brand: brand.value.trim() || null, size: size.value.trim() || null, price: price.value === "" ? null : Number(price.value), category: category.value.trim() || null, isStaple: staple.input.checked, staplePeriodDays: staple.input.checked ? Number(period.value) : null, neverSuggest: never.input.checked, lookup: { ...product.lookup, state: product.lookup?.state === "pending" ? "manual" : product.lookup?.state } }, ["name", "brand", "size", "price", "category"]);
      context.toast("Product saved"); context.refresh();
    }, { error });
  });

  const opening = stepper({ value: 1, min: 1, label: "Opening stock", unit: "packs" });
  const extras = el("details", { class: "sheet-extra" }, [
    el("summary", { text: "More options" }),
    el("div", { class: "stack" }, [
      el("p", { class: "meta", text: "Add packs that were already at home before you started scanning." }),
      opening.node,
      button("Add opening stock", "secondary", () => sheet.run(async () => {
        await recordEvent({ type: "purchase", barcode: product.barcode, barcodeFormat: product.barcodeFormat, qty: opening.value, source: "opening_stock", sessionId: crypto.randomUUID() });
        context.toast("Opening stock added"); context.refresh();
      }, { error })),
      product.lookup?.state !== "manual" && button("Look up the name online again", "ghost", () => sheet.run(async () => { await retryLookup(product.barcode); context.toast("Name check queued"); }, { error })),
      el("p", { class: "meta barcode-meta", text: [product.barcode.startsWith("manual:") ? "No barcode" : product.barcode, product.lookup?.source].filter(Boolean).join(" · ") })
    ])
  ]);
  const sheet = openSheet({ title: product.name, subtitle: stockLabel(product).text, content: [form, extras, button("Cancel", "ghost", () => sheet.close())] });
}

export async function renderCatalogue(context) {
  const state = await getState(); const root = el("div", { class: "stack" });
  const products = [...state.products].sort((a, b) => a.name.localeCompare(b.name));
  root.append(sectionTitle("Everything you buy.", "Tap a product to edit it."));

  const query = el("input", { type: "search", placeholder: "Search products", "aria-label": "Search products", autocomplete: "off", enterkeyhint: "search" });
  const add = el("button", { type: "button", class: "icon-button primary", "aria-label": "Add a product" }, [icon("plus", { size: 22 })]);
  add.addEventListener("click", () => showAddProduct(context));
  root.append(el("div", { class: "search-row" }, [el("label", { class: "search-field" }, [icon("search", { size: 18 }), query]), add]));

  query.value = view.query;
  const filters = [["all", "All"], ["staples", "Staples"], ["names", "Needs a name"]];
  const counts = { all: products.length, staples: products.filter(p => p.isStaple).length, names: products.filter(needsName).length };
  if (!counts[view.filter]) view.filter = "all";
  let filter = view.filter;
  const chips = el("div", { class: "chip-row", role: "group", "aria-label": "Filter products" });
  for (const [value, label] of filters) {
    const count = value === "staples" ? products.filter(p => p.isStaple).length : value === "names" ? products.filter(needsName).length : products.length;
    if (value !== "all" && !count) continue;
    const chip = el("button", { type: "button", class: "chip", "aria-pressed": String(value === filter) }, [label, el("span", { class: "chip-count", text: String(count) })]);
    chip.addEventListener("click", () => { filter = value; view.filter = value; chips.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c === chip))); renderRows(); });
    chips.append(chip);
  }
  if (chips.children.length > 1) root.append(chips);

  const list = el("div", { class: "product-list" });
  root.append(list);
  if (!products.length) { list.append(empty("Your catalogue is empty", "Scan a pack or tap + to add a product.")); return { root }; }

  function renderRows() {
    const term = query.value.trim().toLowerCase();
    const visible = products.filter(product => (filter === "all" || (filter === "staples" ? product.isStaple : needsName(product)))
      && (!term || [product.name, product.brand, product.category, product.barcode].some(value => String(value ?? "").toLowerCase().includes(term))));
    list.replaceChildren(...visible.map(product => {
      const stock = stockLabel(product);
      const row = el("button", { type: "button", class: "product-row" }, [
        product.imageUrl ? el("img", { class: "product-thumb", src: product.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : el("span", { class: "product-thumb", text: product.name.trim().charAt(0).toUpperCase(), "aria-hidden": "true" }),
        el("span", { class: "product-main" }, [el("span", { class: "item-title", text: product.name }), el("span", { class: "meta", text: [product.size, product.category, product.isStaple && "Staple"].filter(Boolean).join(" · ") || (needsName(product) ? "Name being checked online" : "No details yet") })]),
        el("span", { class: `badge ${stock.tone}`, text: stock.text }),
        icon("chevron", { size: 18 })
      ]);
      row.addEventListener("click", () => showEditProduct(product, context));
      return row;
    }));
    if (!visible.length) list.append(empty(term ? `Nothing matches “${query.value.trim()}”` : "Nothing here", term ? "Check the spelling, or tap + to add it." : ""));
  }
  query.addEventListener("input", () => { view.query = query.value; renderRows(); });
  renderRows();
  return { root };
}
