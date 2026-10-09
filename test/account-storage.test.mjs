import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import "../vendor/idb-8.0.3.umd.js";
import { bindDatabaseAccount, releaseDatabaseAccount, openDatabase, recordEvent, getState, clearLocalData } from "../src/db.js";

test("accounts have separate stock and the legacy cache stays with its verified owner", async () => {
  const owner = { id: "owner-id", email: "staintonliam21@gmail.com", email_confirmed_at: "2026-10-01T00:00:00Z" };
  const guests = [{ id: "guest-one", email: "thandobest1234@gmail.com" }, { id: "guest-two", email: "s.g.roberts111@gmail.com" }];
  const seed = qty => recordEvent({ type: "purchase", barcode: "4006381333931", barcodeFormat: "ean_13", qty, sessionId: "test" });
  try {
    await assert.rejects(openDatabase(), /Sign in/);
    await bindDatabaseAccount(owner);
    assert.equal((await openDatabase()).name, "pantry-loop-data");
    await seed(5);
    await assert.rejects(bindDatabaseAccount(guests[0]), /Account changed/);
    await releaseDatabaseAccount();
    await assert.rejects(getState(), /Sign in/);
    for (const [index, guest] of guests.entries()) {
      await bindDatabaseAccount(guest);
      assert.equal((await getState()).products.length, 0);
      assert.equal((await openDatabase()).name, `pantry-loop-data-user-${guest.id}`);
      await seed(index + 1);
      await releaseDatabaseAccount();
    }
    await bindDatabaseAccount(owner);
    assert.equal((await getState()).products[0].onHandQty, 5);
    await releaseDatabaseAccount();
    await bindDatabaseAccount(guests[0]);
    assert.equal((await getState()).products[0].onHandQty, 1);
  } finally {
    await releaseDatabaseAccount();
    for (const user of [owner, ...guests]) { await bindDatabaseAccount(user); await clearLocalData(); await releaseDatabaseAccount(); }
  }
});

test("an unconfirmed identity cannot claim the legacy cache", async () => {
  try {
    await bindDatabaseAccount({ id: "unconfirmed", email: "staintonliam21@gmail.com" });
    assert.equal((await openDatabase()).name, "pantry-loop-data-user-unconfirmed");
  } finally { await clearLocalData(); await releaseDatabaseAccount(); }
});
