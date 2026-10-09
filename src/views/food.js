import { getState, recordMeal, voidEvent, updateSettings } from "../db.js";
import { el, button, field, sectionTitle } from "../ui.js";
import { openSheet, confirmSheet } from "../sheet.js";
import { CameraScanner } from "../scanner.js";
import { normalizeBarcode } from "../barcode.js";
import { fetchNutrition } from "../lookup.js";
import { NUTRIENTS, calculateMeal, dailyTotals, displayAmount, parseMeasure } from "../nutrition.js";

const numeric = (value = "", required = false) => el("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: value ?? "", ...(required ? { required: "" } : {}) });
let selectedDiaryDate = null;

// The review form has one amount and one unit, so blank alternative units never
// block saving. Changing unit clears nutrient values instead of guessing conversions.
export function mealEditor(product, context, date, original = null) {
  const measure = parseMeasure(product.size);
  const initial = original?.food.profile ?? product.nutrition ?? { unit: measure?.unit ?? "g", basis: 100, packSize: measure?.amount ?? "" };
  const unit = el("select");
  for (const [value, text] of [["g", "Grams (g)"], ["ml", "Millilitres (ml)"], ["portion", "Portions"]]) unit.append(el("option", { value, text }));
  const amount = numeric(original?.food.amount ?? "", true);
  const basis = numeric(initial.basis, true), pack = numeric(initial.packSize, true);
  const inputs = Object.fromEntries(NUTRIENTS.map(key => [key, numeric(initial[key], key === "kcal")]));
  const error = el("p", { role: "alert", class: "confirm-error" });
  const preview = el("p", { class: "callout", "aria-live": "polite", text: "Enter the amount eaten to preview calories and stock." });
  const source = el("p", { class: "meta", text: initial.source ?? "Enter the values printed on your label." });
  let provenance = initial.source ?? "Manual label";
  const profile = () => ({ unit: unit.value, basis: Number(basis.value), packSize: Number(pack.value), ...Object.fromEntries(NUTRIENTS.map(key => [key, inputs[key].value === "" ? null : Number(inputs[key].value)])), source: provenance, checkedAt: new Date().toISOString() });
  const update = () => {
    try {
      const result = calculateMeal(profile(), Number(amount.value));
      const remaining = (product.onHandQty ?? 0) + (original?.qty ?? 0) - result.qty;
      preview.textContent = `${displayAmount(result.totals.kcal)} kcal · ${displayAmount(result.qty)} packs used · ${displayAmount(Math.max(0, remaining) * Number(pack.value))} ${unit.value} left${remaining < -1e-8 ? " — not enough stock" : ""}`;
    } catch { preview.textContent = "Enter amount, calories, nutrition basis and pack size to preview."; }
  };
  const fill = p => { unit.value = p.unit; basis.value = p.basis; pack.value = p.packSize ?? ""; for (const key of NUTRIENTS) inputs[key].value = p[key] ?? ""; provenance = p.source ?? "Manual label"; source.textContent = `${provenance} · check against your label before saving`; update(); };
  const lookupNutrition = () => sheet.run(async () => {
    source.textContent = "Looking up nutrition…";
    try { fill(await fetchNutrition(product.barcode, context.settings)); }
    catch (reason) { source.textContent = "Lookup unavailable — manual entry is still available."; throw reason; }
  }, { error, keepOpen: true });
  const lookup = button("Look up nutrition", "secondary", lookupNutrition);
  const form = el("form", { class: "stack" }, [
    el("p", { class: "meta", text: "Use the same unit for amount eaten, nutrition basis and total size of ONE pack. For portions, enter calories per portion and portions per pack. No other unit is required." }),
    field("Unit", unit), field("Amount eaten", amount), field("Nutrition values per how many units? (usually 100 g/ml or 1 portion)", basis),
    field("Total units in one pack", pack),
    ...NUTRIENTS.map(key => field(key === "kcal" ? "Calories (kcal) for that nutrition basis" : `${key[0].toUpperCase() + key.slice(1)} (g, optional) for that basis`, inputs[key])),
    lookup, source, preview, error,
    el("button", { type: "submit", class: "primary", text: original ? "Save changes to diary & stock" : "Log food & deduct stock" }),
    button("Cancel", "ghost", () => sheet.close())
  ]);
  const actionId = crypto.randomUUID();
  const sheet = openSheet({ title: product.name, subtitle: `Food diary · ${date}`, content: [form] });
  fill(initial);
  unit.addEventListener("change", () => { basis.value = unit.value === "portion" ? 1 : 100; pack.value = ""; for (const input of Object.values(inputs)) input.value = ""; provenance = "Manual label"; source.textContent = "Unit changed. Enter matching label values; no conversion has been assumed."; update(); });
  form.addEventListener("input", () => { provenance = "Reviewed label"; update(); });
  form.addEventListener("submit", event => { event.preventDefault(); sheet.run(async () => {
    await recordMeal({ barcode: product.barcode, profile: profile(), amount: Number(amount.value), date, replacesId: original?.id ?? null, actionId });
    context.toast("Food diary and stock updated"); context.refresh();
  }, { error }); });
  // Saved profiles work offline. Older products get one bounded lookup when opened;
  // failure leaves this same form available for manual label entry.
  if (!original && !product.nutrition && context.settings.onlineLookup && navigator.onLine) lookupNutrition();
  return sheet;
}

export async function renderFood(context) {
  const state = await getState();
  const root = el("div", { class: "stack food-view" });
  let disposed = false, editor = null, scanner = null, cameraSheet = null;
  root.append(sectionTitle("Food diary", "Your calories and household stock, together. Log only food you eat; use Used up for waste or other household members."));
  const date = el("input", { type: "date", value: selectedDiaryDate ?? context.today(context.settings.timezone), required: "" });
  const summary = el("div", { class: "food-totals callout", "aria-live": "polite" });
  const history = el("div", { class: "stack" });
  const goal = numeric(context.settings.calorieGoal ?? "");
  const goalStatus = el("p", { role: "status", class: "meta" });
  root.append(field("Diary date", date), summary);
  const goalForm = el("form", { class: "row" }, [field("Optional daily calorie goal (kcal)", goal), el("button", { type: "submit", class: "secondary", text: "Save goal" })]);
  goalForm.addEventListener("submit", async event => {
    event.preventDefault(); const value = goal.value === "" ? null : Number(goal.value);
    if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 100000)) { goalStatus.textContent = "Enter a positive goal, or leave it blank."; return; }
    try { await updateSettings({ calorieGoal: value }); context.settings.calorieGoal = value; draw(); goalStatus.textContent = "Goal saved"; } catch (error) { goalStatus.textContent = error.message; }
  });
  root.append(goalForm, goalStatus);
  const products = [...state.products].sort((a, b) => a.name.localeCompare(b.name));
  const choice = el("select", { "aria-label": "Product to eat" });
  for (const product of products) choice.append(el("option", { value: product.barcode, text: `${product.name} · ${displayAmount(product.onHandQty ?? 0)} packs` }));
  const openProduct = product => { if (!date.checkValidity() || !date.value) { date.reportValidity(); return; } editor = mealEditor(product, context, date.value); };
  const search = el("input", { type: "search", placeholder: "Search your products", "aria-label": "Search your products" });
  search.addEventListener("input", () => { choice.replaceChildren(...products.filter(p => `${p.name} ${p.brand ?? ""}`.toLowerCase().includes(search.value.toLowerCase())).map(p => el("option", { value: p.barcode, text: `${p.name} · ${displayAmount(p.onHandQty ?? 0)} packs` }))); });
  root.append(search, choice, button("Log selected food", "primary", () => { const product = products.find(p => p.barcode === choice.value); if (product) openProduct(product); else context.toast("Add a product using Scan first."); }));
  const scanned = code => {
    const product = products.find(p => p.barcode === code);
    if (!product) throw new Error("Product not in your pantry. Add it using the Scan tab first, then log it here.");
    scanner?.stop(); cameraSheet?.close();
    setTimeout(() => { if (!disposed) openProduct(product); }, 200);
  };
  root.append(button("Scan food barcode", "secondary", () => {
    const video = el("video", { muted: "", playsinline: "", "aria-label": "Food barcode camera" }); video.muted = true;
    const error = el("p", { class: "confirm-error", role: "alert" });
    const code = el("input", { inputmode: "numeric", placeholder: "Or type EAN-13 barcode", "aria-label": "EAN-13 barcode" });
    cameraSheet = openSheet({ title: "Scan food from your pantry", content: [el("div", { class: "camera-shell" }, [video]), error, code, button("Use barcode", "secondary", () => { try { scanned(normalizeBarcode(code.value, "ean_13")); } catch (reason) { error.textContent = reason.message; } }), button("Cancel", "ghost", () => cameraSheet.close())], onClose: () => scanner?.stop() });
    scanner = new CameraScanner(video, async detection => scanned(detection.code), (status, reason) => { if (status === "accept-error") error.textContent = reason.message; });
    scanner.start({ forceFallback: context.settings.forceFallback }).catch(reason => { error.textContent = `Camera unavailable: ${reason.message}. You can type the barcode or select the product instead.`; });
  }));
  root.append(el("p", { class: "meta" }, ["Nutrition lookup: ", el("a", { href: "https://world.openfoodfacts.org", target: "_blank", rel: "noopener noreferrer", text: "Open Food Facts (ODbL)" }), ". Check the label: products and recipes can change. Missing macros are shown as incomplete, not zero."]), history);
  function draw() {
    const totals = dailyTotals(state.depletions, date.value);
    summary.replaceChildren(...NUTRIENTS.map(key => el("p", { text: `${key === "kcal" ? "Calories" : key}: ${displayAmount(totals[key].value)} ${key === "kcal" ? "kcal" : "g"}${totals[key].incomplete ? " (incomplete)" : ""}` })));
    if (context.settings.calorieGoal) { const remaining = context.settings.calorieGoal - totals.kcal.value; summary.append(el("p", { text: remaining >= 0 ? `${displayAmount(remaining)} kcal remaining against your goal` : `${displayAmount(-remaining)} kcal above your goal` })); }
    const entries = state.depletions.filter(e => !e.voidedAt && e.food?.date === date.value).sort((a, b) => b.seq - a.seq);
    history.replaceChildren(el("h2", { text: "Logged food" }));
    if (!entries.length) history.append(el("p", { class: "meta", text: "No food logged on this date." }));
    for (const event of entries) history.append(el("article", { class: "card stack" }, [el("h3", { text: event.food.name }), el("p", { text: `${displayAmount(event.food.amount)} ${event.food.profile.unit} · ${displayAmount(event.food.totals.kcal)} kcal` }), button("Edit amount / nutrition", "secondary", () => { editor = mealEditor(products.find(p => p.barcode === event.barcode), context, event.food.date, event); }), button("Remove & restore stock", "danger", async () => {
      if (!await confirmSheet({ title: `Remove ${event.food.name}?`, message: "This removes the calories and restores the linked stock deduction.", confirmLabel: "Remove & restore", danger: true })) return;
      try { await voidEvent("depletions", event.id); context.toast("Food removed and stock restored"); context.refresh(); } catch (error) { context.toast(error.message, { error: true }); }
    })]));
  }
  date.addEventListener("change", () => { if (date.value && date.checkValidity()) selectedDiaryDate = date.value; draw(); }); draw();
  return { root, cleanup: () => { disposed = true; scanner?.stop(); cameraSheet?.close({ force: true }); editor?.close({ force: true }); } };
}
