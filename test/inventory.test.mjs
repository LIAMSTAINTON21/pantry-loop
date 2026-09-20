import test from "node:test";
import assert from "node:assert/strict";
import { replayStock } from "../src/inventory.js";
import { purchase, depletion } from "./fixtures.mjs";

const code = "4006381333931";

test("empty history remains unknown", () => assert.deepEqual(replayStock(code, [], []), { onHandQty: null, status: "unknown", lastEvent: null }));

test("buy three and finish one leaves two", () => {
  const result = replayStock(code, [purchase("p", 1, code, "2026-09-01", 3)], [depletion("d", 2, code, "2026-09-02T12:00:00Z")]);
  assert.equal(result.onHandQty, 2); assert.equal(result.status, "in_stock");
});

test("first action depletion creates a run-out state", () => {
  const result = replayStock(code, [], [depletion("d", 1, code, "2026-09-02T12:00:00Z")]);
  assert.equal(result.onHandQty, 0); assert.equal(result.status, "finished");
});

test("replacement replays at original sequence", () => {
  const buys = [purchase("old", 1, code, "2026-09-01", 1, { voidedAt: "2026-09-04T00:00:00Z" }), purchase("replacement", 1, code, "2026-09-01", 3, { replacesId: "old" })];
  const used = [depletion("d", 2, code, "2026-09-03T00:00:00Z", 2)];
  assert.equal(replayStock(code, buys, used).onHandQty, 1);
});
