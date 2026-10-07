import test from "node:test";
import assert from "node:assert/strict";
import { expandUpce, normalizeBarcode, validGtin } from "../src/barcode.js";

// Canonical conversion prevents equivalent retail formats from creating
// duplicate product records.
test("validates retail check digits and preserves EAN-8", () => {
  assert.equal(validGtin("4006381333931"), true);
  assert.equal(validGtin("4006381333932"), false);
  assert.equal(normalizeBarcode("96385074", "ean_8"), "96385074");
});

test("UPC-A and equivalent EAN-13 share one canonical key", () => {
  assert.equal(normalizeBarcode("036000291452", "upc_a"), "0036000291452");
  assert.equal(normalizeBarcode("0036000291452", "ean_13"), "0036000291452");
});

test("UPC-E expands before UPC-A canonicalisation and is not EAN-8", () => {
  assert.equal(expandUpce("04252614"), "042100005264");
  assert.equal(normalizeBarcode("04252614", "upc_e"), "0042100005264");
  assert.throws(() => normalizeBarcode("04252614", "ean_8"));
});

test("Code 128 stays a local namespaced key", () => {
  assert.equal(normalizeBarcode("001234ABC", "code_128"), "code128:001234ABC");
});
