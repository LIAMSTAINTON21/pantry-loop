import test from "node:test";
import assert from "node:assert/strict";
import { RepeatGate } from "../src/scanner.js";

test("requires two matches, latches while held, then rearms after timed absence", () => {
  const gate = new RepeatGate();
  assert.deepEqual(gate.observe(["A"], 0), []);
  assert.deepEqual(gate.observe(["A"], 100), ["A"]);
  assert.deepEqual(gate.observe(["A"], 10000), []);
  gate.observe([], 10100); gate.observe([], 10450); gate.observe([], 10850);
  assert.deepEqual(gate.observe(["A"], 10900), []);
  assert.deepEqual(gate.observe(["A"], 11000), ["A"]);
});

test("mode change forces visible code removal before reacceptance", () => {
  const gate = new RepeatGate(); gate.observe(["A"], 0); assert.deepEqual(gate.observe(["A"], 100), ["A"]);
  gate.reset({ requireRemoval: ["A"] });
  assert.deepEqual(gate.observe(["A"], 2000), []);
  gate.observe([], 2100); gate.observe([], 2500); gate.observe([], 2900);
  gate.observe(["A"], 3000); assert.deepEqual(gate.observe(["A"], 3100), ["A"]);
});
