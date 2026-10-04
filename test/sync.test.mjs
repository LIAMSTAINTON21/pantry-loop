import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = { baseURI: "http://localhost:8080/" };
const { cloudBackupEnvelope, mergeBackups, restoreDeviceMeta } = await import("../src/sync.js");
const { product, purchase, depletion } = await import("./fixtures.mjs");

const backup = (patch = {}) => ({
  appId: "pantry-loop", schemaVersion: 1, exportedAt: "2026-10-04T10:00:00Z",
  products: [product()], purchases: [], depletions: [],
  meta: [{ key: "schemaVersion", value: 1 }, { key: "nextSeq", value: 1 }], ...patch
});

test("merges event IDs and normalizes colliding sequences", () => {
  const remote = backup({ purchases: [purchase("remote", 1, "4006381333931", "2026-10-03")] });
  const local = backup({ depletions: [depletion("local", 1, "4006381333931", "2026-10-04")] });
  const merged = mergeBackups(remote, local);
  assert.equal(merged.appId, "pantry-loop");
  assert.equal(merged.schemaVersion, 1);
  assert.equal(merged.purchases.length, 1);
  assert.equal(merged.depletions.length, 1);
  assert.notEqual(merged.purchases[0].seq, merged.depletions[0].seq);
});

test("removes legacy proxy URLs from synchronized settings", () => {
  const merged = mergeBackups(backup(), backup({ meta: [{ key: "settings", value: { timezone: "Europe/London", visionProxyUrl: "https://attacker.test", catalogueProxyUrl: "https://attacker.test" } }] }));
  const settings = merged.meta.find(row => row.key === "settings").value;
  assert.equal(settings.visionProxyUrl, undefined);
  assert.equal(settings.catalogueProxyUrl, undefined);
});

test("a newer remote void cannot be resurrected by a stale local event", () => {
  const active = purchase("shared", 1, "4006381333931", "2026-10-04");
  const remote = backup({ purchases: [{ ...active, voidedAt: "2026-10-04T13:05:00Z" }] });
  const local = backup({ purchases: [active] });
  const merged = mergeBackups(remote, local);
  assert.equal(merged.purchases[0].voidedAt, "2026-10-04T13:05:00Z");
});

test("newer product edits win while the server wins timestamp ties", () => {
  const stale = product("4006381333931", { name: "Old name", updatedAt: "2026-10-04T10:00:00Z" });
  const fresh = product("4006381333931", { name: "Fresh name", updatedAt: "2026-10-04T10:05:00Z" });
  assert.equal(mergeBackups(backup({ products: [fresh] }), backup({ products: [stale] })).products[0].name, "Fresh name");
  assert.equal(mergeBackups(backup({ products: [fresh] }), backup({ products: [{ ...fresh, name: "Tie loses" }] })).products[0].name, "Fresh name");
});

test("cloud replacement preserves device-only metadata without uploading it", () => {
  const deviceRows = [
    { key: "activeSession", value: { id: "device-session" } },
    { key: "storagePersistent", value: true },
    { key: "lastJsonBackupRequest", value: "2026-10-04T11:00:00Z" }
  ];
  const merged = mergeBackups(backup(), backup({ meta: [...backup().meta, ...deviceRows] }));
  assert.equal(merged.meta.some(row => row.key === "activeSession"), false);
  const local = restoreDeviceMeta(merged, deviceRows);
  assert.deepEqual(local.meta.slice(-3), deviceRows);
});

test("new cloud snapshots omit all device-only synchronization flags", () => {
  const local = backup({ meta: [
    ...backup().meta,
    { key: "activeSession", value: { id: "device-session" } },
    { key: "lastJsonBackupRequest", value: "2026-10-04T11:00:00Z" },
    { key: "cloudReplacePending", value: true }
  ] });
  const cloud = cloudBackupEnvelope(local);
  assert.deepEqual(cloud.meta.map(row => row.key).sort(), ["nextSeq", "schemaVersion"]);
});

test("a cloud restore epoch prevents stale devices resurrecting deleted history", () => {
  const removed = purchase("removed-by-restore", 1, "4006381333931", "2026-10-03");
  const staleDevice = backup({ purchases: [removed] });
  const restoredCloud = backup({
    purchases: [],
    meta: [...backup().meta, { key: "cloudResetAt", value: "2026-10-04T12:00:00Z" }]
  });
  const merged = mergeBackups(restoredCloud, staleDevice);
  assert.equal(merged.purchases.length, 0);
  assert.equal(merged.meta.find(row => row.key === "cloudResetAt")?.value, "2026-10-04T12:00:00Z");
});

test("a newer cloud restore wins over an older pending offline restore", () => {
  const olderPending = backup({
    purchases: [purchase("older-restore", 1, "4006381333931", "2026-10-03")],
    meta: [...backup().meta, { key: "cloudResetAt", value: "2026-10-04T11:00:00Z" }, { key: "cloudReplacePending", value: true }]
  });
  const newerCloud = backup({
    purchases: [],
    meta: [...backup().meta, { key: "cloudResetAt", value: "2026-10-04T12:00:00Z" }]
  });
  const merged = mergeBackups(newerCloud, olderPending);
  assert.equal(merged.purchases.length, 0);
  assert.equal(merged.meta.find(row => row.key === "cloudResetAt")?.value, "2026-10-04T12:00:00Z");
});
