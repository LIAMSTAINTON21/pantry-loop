import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import "../vendor/idb-8.0.3.umd.js";
import { bindDatabaseAccount, releaseDatabaseAccount, clearLocalData, recordEvent } from "../src/db.js";

let currentId = "owner-a", switchDuringRead = false, writes = 0, reads = 0;
globalThis.document = { baseURI: "http://localhost/" };
globalThis.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: currentId } } }, error: null }) },
  from: () => ({
    select() { return this; }, eq() { return this; },
    async maybeSingle() { reads++; if (switchDuringRead) currentId = "owner-b"; return { data: null, error: null }; },
    insert() { writes++; throw new Error("Unexpected cross-account write"); }
  })
}) };
const { synchronizeNow } = await import("../src/sync.js");

test("sync never uploads account A's local cache under account B", async () => {
  try {
    await bindDatabaseAccount({ id: "owner-a", email: "a@example.com" });
    await recordEvent({ type: "purchase", barcode: "4006381333931", barcodeFormat: "ean_13", sessionId: "private-a" });
    currentId = "owner-b";
    await assert.rejects(synchronizeNow(), /Account changed/);
    assert.equal(reads, 0); assert.equal(writes, 0);
    currentId = "owner-a"; switchDuringRead = true;
    await assert.rejects(synchronizeNow(), /Account changed/);
    assert.equal(reads, 1); assert.equal(writes, 0);
  } finally { await clearLocalData(); await releaseDatabaseAccount(); }
});
