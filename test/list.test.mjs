import test from "node:test";
import assert from "node:assert/strict";
import { daysBetween, generateList } from "../src/list.js";
import { product, purchase, depletion } from "./fixtures.mjs";

const code = "4006381333931";
const prediction = dates => dates.map((date, index) => purchase(`p${index}`, index + 1, code, date));

test("three, four, and six purchase dates yield low, medium, and high prediction confidence", () => {
  const p = [product(code)];
  assert.equal(generateList(p, prediction(["2026-08-30", "2026-09-06", "2026-09-13"]), [], "2026-09-20", {})[0].confidence, "low");
  assert.equal(generateList(p, prediction(["2026-08-23", "2026-08-30", "2026-09-06", "2026-09-13"]), [], "2026-09-20", {})[0].confidence, "medium");
  assert.equal(generateList(p, prediction(["2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06", "2026-09-13"]), [], "2026-09-20", {})[0].confidence, "high");
});

test("outlier gap keeps median seven but lowers confidence", () => {
  const rows = prediction(["2026-06-17", "2026-06-24", "2026-07-01", "2026-08-30", "2026-09-06"]);
  const item = generateList([product(code)], rows, [], "2026-09-13", {})[0];
  assert.match(item.primaryReason, /~7 days/); assert.equal(item.confidence, "low");
});

test("packs on one date form one occasion and do not unlock prediction", () => {
  const rows = [purchase("a", 1, code, "2026-09-01"), purchase("b", 2, code, "2026-09-01"), purchase("c", 3, code, "2026-09-08")];
  assert.equal(generateList([product(code)], rows, [], "2026-09-09", {}).length, 0);
});

test("ran out overrides yesterday purchase guard", () => {
  const rows = [purchase("p", 1, code, "2026-09-19")]; const used = [depletion("d", 2, code, "2026-09-20T12:00:00Z")];
  assert.equal(generateList([product(code)], rows, used, "2026-09-20", {})[0].primaryReason, "Ran out");
});

test("later purchase clears run-out and recent guard suppresses staple", () => {
  const rows = [purchase("p", 2, code, "2026-09-20")]; const used = [depletion("d", 1, code, "2026-09-19T12:00:00Z")];
  assert.equal(generateList([product(code, { isStaple: true, staplePeriodDays: 1 })], rows, used, "2026-09-20", {}).length, 0);
});

test("new staple appears immediately and boundaries are calendar based", () => {
  assert.equal(generateList([product(code, { isStaple: true, staplePeriodDays: 7 })], [], [], "2026-09-20", {}).length, 1);
  assert.equal(daysBetween("2026-03-22", "2026-03-29"), 7);
  const snoozed = product(code, { isStaple: true, staplePeriodDays: 1, snoozeUntil: "2026-09-20" });
  assert.equal(generateList([snoozed], [], [], "2026-09-20", {}).length, 1);
  const exactlyTwo = [purchase("p", 1, code, "2026-09-18")];
  assert.equal(generateList([product(code, { isStaple: true, staplePeriodDays: 1 })], exactlyTwo, [], "2026-09-20", {}).length, 1);
});

test("never-suggest and active snooze suppress run-outs", () => {
  const used = [depletion("d", 1, code, "2026-09-20T12:00:00Z")];
  assert.equal(generateList([product(code, { neverSuggest: true })], [], used, "2026-09-20", {}).length, 0);
  assert.equal(generateList([product(code, { snoozeUntil: "2026-09-21" })], [], used, "2026-09-20", {}).length, 0);
});
