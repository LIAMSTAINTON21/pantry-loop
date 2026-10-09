// Provider-neutral nutrition maths. Values always carry a unit and denominator;
// missing data is null, never zero, and grams are never treated as millilitres.
export const NUTRIENTS = ["kcal", "protein", "carbs", "fat"];
export const UNITS = ["g", "ml", "portion"];
const positive = n => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1e7;
const nutrient = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e7;
export const rounded = n => Math.round(n * 1e8) / 1e8;
export const displayAmount = n => Number(n.toFixed(2)).toLocaleString();

export function validateNutrition(profile) {
  if (!profile || !UNITS.includes(profile.unit) || !positive(profile.basis) || !positive(profile.packSize)) throw new Error("Enter a nutrition basis and pack size in the selected unit.");
  if (!nutrient(profile.kcal)) throw new Error("Enter calories from the label (zero is allowed).");
  for (const key of NUTRIENTS.slice(1)) if (profile[key] != null && !nutrient(profile[key])) throw new Error(`Invalid ${key}`);
  return profile;
}

export function calculateMeal(profile, amount) {
  validateNutrition(profile);
  if (!positive(amount)) throw new Error("Enter an amount greater than zero.");
  const qty = rounded(amount / profile.packSize);
  if (qty <= 0) throw new Error("That amount is too small to record.");
  const totals = Object.fromEntries(NUTRIENTS.map(key => [key, profile[key] == null ? null : rounded(profile[key] * amount / profile.basis)]));
  if (!Number.isFinite(qty) || qty > 1e7 || Object.values(totals).some(value => value !== null && (!Number.isFinite(value) || value > 1e9))) throw new Error("Amounts are too large. Check the nutrition basis and pack size.");
  return { qty, totals };
}

// A deliberately conservative parser: multipacks and ambiguous label text need review.
export function parseMeasure(text) {
  const match = String(text ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)$/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const amount = Number(match[1].replace(",", ".")) * ({ kg: 1000, cl: 10, l: 1000 }[unit] ?? 1);
  return positive(amount) ? { amount, unit: ["kg", "g"].includes(unit) ? "g" : "ml" } : null;
}

export function nutritionFromOFF(product) {
  const n = product?.nutriments ?? {};
  const pack = parseMeasure(product?.quantity);
  const read = key => nutrient(n[key]) ? n[key] : null;
  // OFF uses the _100g suffix for both 100g and 100ml. Only autofill when the
  // package gives an explicit mass/volume unit; users must review the label.
  if (!pack) return null;
  const kcal = read("energy-kcal_100g") ?? (read("energy-kj_100g") == null ? null : rounded(read("energy-kj_100g") / 4.184));
  if (kcal === null) return null;
  return { unit: pack.unit, basis: 100, packSize: pack.amount, kcal, protein: read("proteins_100g"), carbs: read("carbohydrates_100g"), fat: read("fat_100g"), source: "Open Food Facts", checkedAt: new Date().toISOString() };
}

export function validateFood(food, qty) {
  if (!food || typeof food.name !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(food.date) || new Date(`${food.date}T12:00:00Z`).toISOString().slice(0, 10) !== food.date) throw new Error("Invalid food diary entry");
  const expected = calculateMeal(food.profile, food.amount);
  if (Math.abs(expected.qty - qty) > 1e-8 || NUTRIENTS.some(key => food.totals?.[key] !== expected.totals[key])) throw new Error("Food diary and stock amounts do not match");
  return food;
}

export function dailyTotals(events, date) {
  const foods = events.filter(event => !event.voidedAt && event.food?.date === date);
  return Object.fromEntries(NUTRIENTS.map(key => [key, { value: rounded(foods.reduce((sum, event) => sum + (event.food.totals[key] ?? 0), 0)), incomplete: foods.some(event => event.food.totals[key] == null) }]));
}
