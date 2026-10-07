import test from "node:test";
import assert from "node:assert/strict";
import { RepeatGate, CameraScanner, isScannerVisible } from "../src/scanner.js";

// Minimal video/canvas doubles let scanner lifecycle and duplicate-frame
// handling be checked without requesting a real camera.
function preview(top = 0) {
  return { isConnected: true, closest: () => null, getBoundingClientRect: () => ({ top, bottom: top + 200, left: 0, right: 300, width: 300, height: 200 }) };
}
const viewport = { innerWidth: 400, innerHeight: 400 };
test('scanner requires most of preview in viewport, including visual viewport', () => {
  assert.equal(isScannerVisible(preview(), {}, viewport), true);
  assert.equal(isScannerVisible(preview(300), {}, viewport), false);
  assert.equal(isScannerVisible(preview(-180), {}, viewport), false);
  assert.equal(isScannerVisible(preview(), { hidden: true }, viewport), false);
  assert.equal(isScannerVisible(preview(), {}, { ...viewport, visualViewport: { offsetTop: 150, offsetLeft: 0, width: 400, height: 250 } }), false);
});
test('scanner pauses behind dialogs and sticky overlays, but works inside its own dialog', () => {
  const video = preview();
  assert.equal(isScannerVisible(video, { querySelectorAll: () => [{ contains: () => false }] }, viewport), false);
  assert.equal(isScannerVisible(video, { querySelectorAll: () => [{ contains: item => item === video }], elementFromPoint: () => video }, viewport), true);
  assert.equal(isScannerVisible(video, { elementFromPoint: () => ({}) }, viewport), false);
});
test('camera permission resolved after stop immediately releases stream', async t => {
  let resolveStream, stopped = 0, played = 0;
  t.mock.method(globalThis, 'setTimeout', setTimeout);
  const oldWindow = globalThis.window, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } } });
  try {
    const video = { play: () => { played++; } };
    const scanner = new CameraScanner(video, () => {});
    const start = scanner.start(); scanner.stop();
    resolveStream({ getTracks: () => [{ stop: () => { stopped++; } }] });
    await start;
    assert.equal(stopped, 1); assert.equal(played, 0); assert.equal(scanner.running, false); assert.equal(video.srcObject, null);
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  }
});
test('captured AI frame is resized JPEG and unavailable frames return null', () => {
  const oldDocument = globalThis.document;
  let canvas;
  globalThis.document = { createElement: () => (canvas = { getContext: () => ({ drawImage() {} }), toDataURL: (type, quality) => `${type}:${quality}` }) };
  try {
    const scanner = new CameraScanner({ videoWidth: 2560, videoHeight: 1440 });
    assert.equal(scanner.captureImage(), 'image/jpeg:0.78');
    assert.equal(canvas.width, 1280); assert.equal(canvas.height, 720);
    scanner.video.videoWidth = 0; assert.equal(scanner.captureImage(), null);
  } finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; }
});

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

test("a replacement camera retains the held barcode latch", () => {
  const gate = new RepeatGate();
  gate.observe(["A"], 0); gate.observe(["A"], 100);
  const scanner = new CameraScanner({}, () => {}, () => {}, gate);
  assert.deepEqual(scanner.gate.observe(["A"], 5000), []);
  scanner.modeChanged();
  assert.deepEqual(scanner.gate.observe(["A"], 6000), []);
  gate.observe([], 6100); gate.observe([], 6500); gate.observe([], 6900);
  gate.observe(["A"], 7000);
  assert.deepEqual(gate.observe(["A"], 7100), ["A"]);
});
