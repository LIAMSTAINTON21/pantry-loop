import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import "../vendor/idb-8.0.3.umd.js";
import { calculateMeal, nutritionFromOFF, dailyTotals } from "../src/nutrition.js";
import { bindDatabaseAccount, recordEvent, recordMeal, getState, voidEvent, clearLocalData, correctEvent } from "../src/db.js";
import { buildBackup, validateBackup } from "../src/export.js";

const profile = { unit: "g", basis: 100, packSize: 500, kcal: 200, protein: 10, carbs: null, fat: 5 };
await bindDatabaseAccount({ id: "nutrition-test", email: "test@example.com" });
test("mass, volume and portions use only the chosen unit", () => {
  for (const unit of ["g", "ml", "portion"]) {
    const result = calculateMeal({ ...profile, unit }, 75);
    assert.equal(result.qty, 0.15); assert.equal(result.totals.kcal, 150);
    assert.equal(result.totals.carbs, null);
  }
  assert.equal(calculateMeal({ ...profile, unit: "portion", basis: 1, packSize: 4, kcal: 60 }, 2).totals.kcal, 120);
});
test("missing calories and invalid denominators cannot silently become zero", () => {
  for (const patch of [{ kcal: null }, { kcal: -1 }, { packSize: 0 }, { basis: Infinity }, { unit: "kg" }]) assert.throws(() => calculateMeal({ ...profile, ...patch }, 1));
  assert.throws(() => calculateMeal(profile, 0));
  assert.equal(calculateMeal({ ...profile, kcal: 0 }, 10).totals.kcal, 0);
});
test("OFF hydration keeps units explicit and missing macros unknown", () => {
  const p = nutritionFromOFF({ quantity: "1 l", nutriments: { "energy-kcal_100g": 40 } });
  assert.equal(p.unit, "ml"); assert.equal(p.packSize, 1000); assert.equal(p.protein, null);
  assert.equal(nutritionFromOFF({ quantity: "6 x 50 g", nutriments: { "energy-kcal_100g": 40 } }), null);
  assert.equal(nutritionFromOFF({ quantity: "500g", nutriments: {} }), null);
});
test("food logging, corrections, backups and removal keep stock and calories atomic", async () => {
  try {
    const barcode = "4006381333931";
    await recordEvent({ type: "purchase", barcode, barcodeFormat: "ean_13", sessionId: "test", name: "Oats" });
    const meal = await recordMeal({ barcode, profile, amount: 75, date: "2026-10-09", actionId: "meal-one" });
    await recordMeal({ barcode, profile, amount: 75, date: "2026-10-09", actionId: "meal-one" });
    await assert.rejects(recordMeal({ barcode, profile, amount: 80, date: "2026-10-09", actionId: "meal-one" }), /different details/);
    let state = await getState();
    assert.equal(state.depletions.length, 1); assert.equal(state.products[0].onHandQty, 0.85);
    assert.equal(dailyTotals(state.depletions, "2026-10-09").kcal.value, 150);
    assert.equal(dailyTotals(state.depletions, "2026-10-09").carbs.incomplete, true);
    await assert.rejects(recordMeal({ barcode, profile, amount: 600, date: "2026-10-09" }), /Not enough stock/);
    await assert.rejects(recordMeal({ barcode, profile, amount: 10, date: "2026-02-30" }), /Invalid food/);
    assert.equal((await getState()).depletions.length, 1);
    await assert.rejects(correctEvent("depletions", meal.id, 1), /Food diary/);
    const edited = await recordMeal({ barcode, profile, amount: 100, date: "2026-10-09", replacesId: meal.id });
    state = await getState();
    assert.equal(state.products[0].onHandQty, 0.8);
    assert.equal(dailyTotals(state.depletions, "2026-10-09").kcal.value, 200);
    const backup = await buildBackup(); assert.equal(validateBackup(backup).depletions.length, 2);
    const broken = structuredClone(backup); broken.depletions[0].food.totals.kcal = 900;
    assert.throws(() => validateBackup(broken), /do not match/);
    await voidEvent("depletions", edited.id);
    state = await getState(); assert.equal(state.products[0].onHandQty, 1);
    assert.equal(dailyTotals(state.depletions, "2026-10-09").kcal.value, 0);
  } finally { await clearLocalData(); }
});
test("concurrent meals cannot consume the same remaining stock twice", async () => {
  try {
    const barcode = "4006381333931";
    await recordEvent({ type: "purchase", barcode, barcodeFormat: "ean_13", sessionId: "test" });
    const attempts = await Promise.allSettled([1, 2].map(() => recordMeal({ barcode, profile, amount: 300, date: "2026-10-09" })));
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await getState()).products[0].onHandQty, 0.4);
  } finally { await clearLocalData(); }
});
