import test from "node:test";
import assert from "node:assert/strict";
import { CameraScanner, RepeatGate } from "../src/scanner.js";

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

test("paused scanner skips decoding until every pause reason is cleared", async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const scanner = new CameraScanner({ videoWidth: 0, videoHeight: 0 }, () => {});
  let decodes = 0;
  scanner.decode = async () => { decodes += 1; return []; };
  scanner.setPaused("offscreen", true); scanner.setPaused("editor", true);
  scanner.running = true; scanner.loop();
  await wait(350); assert.equal(decodes, 0);
  scanner.setPaused("offscreen", false);
  await wait(350); assert.equal(decodes, 0);
  scanner.setPaused("editor", false);
  await wait(350); assert.ok(decodes > 0);
  scanner.running = false; clearTimeout(scanner.timer);
});

test("stopping while the camera is still opening releases it and never starts decoding", async () => {
  let release; let tracksStopped = 0;
  const stream = { getTracks: () => [{ stop: () => { tracksStopped += 1; } }] };
  globalThis.window ??= globalThis; const hadSecure = "isSecureContext" in globalThis;
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { release = () => resolve(stream); }) } }, configurable: true });
  const states = [];
  const scanner = new CameraScanner({ play: async () => {} }, () => {}, state => states.push(state));
  const starting = scanner.start();
  scanner.stop(); release(); await starting;
  assert.equal(tracksStopped, 1); assert.equal(scanner.running, false); assert.deepEqual(states, []);
  if (!hadSecure) delete globalThis.isSecureContext;
});
