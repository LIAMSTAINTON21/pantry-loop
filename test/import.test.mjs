import test from "node:test";
import assert from "node:assert/strict";
import { validateBackup } from "../src/export.js";
import { product, purchase } from "./fixtures.mjs";

// Reject incompatible schemas and broken references before an import can
// replace the current local database.
const code = "4006381333931";
const base = () => ({ appId: "pantry-loop", schemaVersion: 1, exportedAt: "2026-09-20T12:00:00Z", products: [product(code)], purchases: [purchase("p", 1, code, "2026-09-20")], depletions: [], meta: [{ key: "nextSeq", value: 2 }] });

test("valid backup is cloned and accepted", () => assert.equal(validateBackup(base()).products.length, 1));
test("rejects unsupported newer schema", () => { const value = base(); value.schemaVersion = 2; assert.throws(() => validateBackup(value), /newer/); });
test("rejects orphan product references", () => { const value = base(); value.purchases[0].barcode = "missing"; assert.throws(() => validateBackup(value), /Invalid event/); });
test("rejects active sequence collisions", () => { const value = base(); value.purchases.push(purchase("p2", 1, code, "2026-09-20")); assert.throws(() => validateBackup(value), /sequence/); });
