import test from "node:test";
import assert from "node:assert/strict";
import { formatFullShoppingList, nextTescoItem, normaliseTescoProgress, openTescoSearch, tescoSearchUrl, undoTescoProgress, updateTescoProgress } from "../src/tesco.js";

// Cover URL safety, readable summaries, and per-item progress while shopping
// from a confirmed list.
const items = [
  { barcode: "one", name: "Whole milk", size: "4 pints", qty: 2 },
  { barcode: "two", name: "Bread & butter", size: null, qty: 1 }
];

test("builds official Tesco search URLs with encoded item details", () => {
  assert.equal(tescoSearchUrl(items[1]), "https://www.tesco.com/shop/en-GB/search?query=Bread%20%26%20butter");
  assert.equal(tescoSearchUrl(items[0]), "https://www.tesco.com/shop/en-GB/search?query=Whole%20milk%204%20pints");
});

test("opens only a new isolated Tesco search tab", () => {
  let call;
  const opened = { opener: "source" };
  assert.equal(openTescoSearch(items[1], (...args) => { call = args; return opened; }), opened);
  assert.deepEqual(call, [tescoSearchUrl(items[1]), "_blank", "noopener,noreferrer"]);
  assert.equal(opened.opener, null);
});

test("formats a complete readable shopping list", () => {
  assert.equal(formatFullShoppingList(items), "2 × Whole milk · 4 pints\n1 × Bread & butter");
});

test("progress advances, persists valid local marks, and can undo", () => {
  let progress = normaliseTescoProgress(items, { confirmedAt: "2026-10-04T10:00:00Z", addedBarcodes: ["missing"] });
  assert.equal(nextTescoItem(items, progress).barcode, "one");
  progress = updateTescoProgress(items, progress, "one", "opened");
  assert.deepEqual(progress.openedBarcodes, ["one"]);
  progress = updateTescoProgress(items, progress, "one", "added");
  assert.equal(nextTescoItem(items, progress).barcode, "two");
  progress = updateTescoProgress(items, progress, "two", "skipped");
  assert.equal(nextTescoItem(items, progress), null);
  progress = undoTescoProgress(items, progress);
  assert.equal(progress.currentBarcode, "two");
  assert.equal(nextTescoItem(items, progress).barcode, "two");
});
