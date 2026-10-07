import { APP_ID, SCHEMA_VERSION, getDataChangeVersion, replaceAll, setMeta } from "./db.js";
import { buildBackup, validateBackup } from "./export.js";
import { getSupabaseClient } from "./supabase-config.js";

const RETRIES = 3;
const SNAPSHOT_TABLE = "pantry_snapshots";

function occurredAt(event) {
  return event.purchasedAt ?? event.finishedAt ?? "";
}

// Device session and backup metadata stays local. Proxy URLs are stripped from
// synchronized settings so a snapshot cannot install a remote service target.
function cleanMeta(rows) {
  const deviceOnly = new Set(["activeSession", "storagePersistent", "lastJsonBackupRequest", "cloudReplacePending"]);
  return rows.filter(row => !deviceOnly.has(row.key)).map(row => {
    if (row.key !== "settings" || !row.value || typeof row.value !== "object") return structuredClone(row);
    const { catalogueProxyUrl: _catalogue, visionProxyUrl: _vision, ...safe } = row.value;
    return { key: row.key, value: safe };
  });
}

function deviceMeta(rows) {
  const deviceOnly = new Set(["activeSession", "storagePersistent", "lastJsonBackupRequest", "cloudReplacePending"]);
  return rows.filter(row => deviceOnly.has(row.key)).map(row => structuredClone(row));
}

export function restoreDeviceMeta(snapshot, rows) {
  return { ...snapshot, meta: [...snapshot.meta, ...deviceMeta(rows)] };
}

function metaVersion(row) {
  const value = row?.value;
  if (typeof value === "string") return timeValue(value);
  if (!value || typeof value !== "object") return 0;
  return Math.max(timeValue(value.updatedAt), timeValue(value.completedAt), timeValue(value.createdAt));
}

function resetVersion(rows) {
  return timeValue(rows.find(row => row.key === "cloudResetAt")?.value);
}

function envelopeFromValidated(value) {
  return {
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ...value,
    meta: cleanMeta(value.meta)
  };
}

function rootId(event, byId) {
  const seen = new Set([event.id]);
  let cursor = event;
  while (cursor.replacesId && byId.has(cursor.replacesId) && !seen.has(cursor.replacesId)) {
    seen.add(cursor.replacesId);
    cursor = byId.get(cursor.replacesId);
  }
  return cursor.id;
}

function timeValue(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
}

function rowVersion(row) {
  return Math.max(timeValue(row.updatedAt), timeValue(row.voidedAt), timeValue(occurredAt(row)), timeValue(row.createdAt));
}

function eventGroups(rows) {
  const byId = new Map(rows.map(event => [event.id, event]));
  const groups = new Map();
  for (const event of rows) {
    const root = rootId(event, byId);
    const group = groups.get(root) ?? [];
    group.push(event); groups.set(root, group);
  }
  return groups;
}

function mergeEventGroups(remoteRows, localRows) {
  const remote = eventGroups(remoteRows); const local = eventGroups(localRows);
  const merged = [];
  for (const root of new Set([...remote.keys(), ...local.keys()])) {
    const remoteGroup = remote.get(root); const localGroup = local.get(root);
    if (!remoteGroup) { merged.push(...localGroup); continue; }
    if (!localGroup) { merged.push(...remoteGroup); continue; }
    const remoteVersion = Math.max(...remoteGroup.map(rowVersion));
    const localVersion = Math.max(...localGroup.map(rowVersion));
    // The server copy wins ties so a stale local row cannot resurrect a voided
    // event. A later correction/undo carries a later void timestamp in its chain.
    merged.push(...(localVersion > remoteVersion ? localGroup : remoteGroup));
  }
  return merged.map(row => structuredClone(row));
}

function normalizeSequences(purchases, depletions) {
  const all = [...purchases, ...depletions];
  const byId = new Map(all.map(event => [event.id, event]));
  const groups = new Map();
  for (const event of all) {
    const root = rootId(event, byId);
    const group = groups.get(root) ?? [];
    group.push(event); groups.set(root, group);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const aKey = `${a.map(occurredAt).sort()[0]}:${a[0].id}`;
    const bKey = `${b.map(occurredAt).sort()[0]}:${b[0].id}`;
    return aKey.localeCompare(bKey);
  });
  ordered.forEach((group, index) => group.forEach(event => { event.seq = index + 1; }));
  return ordered.length + 1;
}

export function mergeBackups(remoteInput, localInput) {
  // Validate both sides before merging. A reset timestamp acts as a deletion
  // boundary; otherwise records merge by stable IDs and edit timestamps.
  const remote = validateBackup(remoteInput);
  const local = validateBackup(localInput);
  const remoteReset = resetVersion(remote.meta);
  const localReset = resetVersion(local.meta);
  if (remoteReset > localReset) return envelopeFromValidated(remote);
  if (localReset > remoteReset) return envelopeFromValidated(local);
  const products = new Map(remote.products.map(row => [row.barcode, row]));
  local.products.forEach(row => {
    const server = products.get(row.barcode);
    if (!server || rowVersion(row) > rowVersion(server)) products.set(row.barcode, row);
  });
  const meta = new Map(cleanMeta(remote.meta).map(row => [row.key, row]));
  cleanMeta(local.meta).forEach(row => {
    const server = meta.get(row.key);
    if (!server || metaVersion(row) > metaVersion(server)) meta.set(row.key, row);
  });
  const mergedPurchases = mergeEventGroups(remote.purchases, local.purchases);
  const mergedDepletions = mergeEventGroups(remote.depletions, local.depletions);
  const nextSeq = normalizeSequences(mergedPurchases, mergedDepletions);
  meta.set("schemaVersion", { key: "schemaVersion", value: SCHEMA_VERSION });
  meta.set("nextSeq", { key: "nextSeq", value: nextSeq });
  const exportedAt = new Date().toISOString();
  const checked = validateBackup({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    products: [...products.values()].map(row => structuredClone(row)),
    purchases: mergedPurchases,
    depletions: mergedDepletions,
    meta: [...meta.values()]
  });
  return { appId: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt, ...checked };
}

function backupEnvelope(input) {
  const checked = validateBackup(input);
  return { appId: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: input.exportedAt ?? new Date().toISOString(), ...checked };
}

export function cloudBackupEnvelope(input) {
  const envelope = backupEnvelope(input);
  return { ...envelope, meta: cleanMeta(envelope.meta) };
}

async function readRemote(client, userId) {
  const { data, error } = await client.from(SNAPSHOT_TABLE).select("snapshot,revision,updated_at")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data ? { snapshot: data.snapshot, revision: Number(data.revision), updatedAt: data.updated_at } : null;
}

async function writeRemote(client, userId, remote, snapshot) {
  if (!remote) {
    const { data, error } = await client.from(SNAPSHOT_TABLE)
      .insert({ user_id: userId, snapshot, revision: 1 }).select("revision,updated_at").maybeSingle();
    if (error) {
      if (error.code === "23505") { const conflict = new Error("Snapshot changed on another device"); conflict.status = 409; throw conflict; }
      throw error;
    }
    if (!data) throw new Error("Snapshot was not saved");
    return { revision: Number(data.revision), updatedAt: data.updated_at };
  }
  const { data, error } = await client.from(SNAPSHOT_TABLE)
    .update({ snapshot, revision: remote.revision + 1 })
    .eq("user_id", userId).eq("revision", remote.revision)
    .select("revision,updated_at").maybeSingle();
  if (error) throw error;
  if (!data) { const conflict = new Error("Snapshot changed on another device"); conflict.status = 409; throw conflict; }
  return { revision: Number(data.revision), updatedAt: data.updated_at };
}

export async function synchronizeNow() {
  const client = await getSupabaseClient();
  const { data: authData, error: authError } = await client.auth.getSession();
  const userId = authData?.session?.user?.id;
  if (authError || !userId) throw new Error("Sign in before synchronizing.");
  const startingVersion = getDataChangeVersion();
  let local = await buildBackup();
  const localDeviceMeta = deviceMeta(local.meta);
  const forceCloudReplace = local.meta.some(row => row.key === "cloudReplacePending" && row.value === true);
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    // The revision condition makes writes optimistic: on a competing device
    // edit, reread and merge instead of silently overwriting its snapshot.
    const remote = await readRemote(client, userId);
    const snapshot = remote?.snapshot ? mergeBackups(remote.snapshot, local) : cloudBackupEnvelope(local);
    try {
      const saved = await writeRemote(client, userId, remote, snapshot);
      // A user action may complete while network requests are in flight. Never
      // replace those newer local edits with the earlier captured snapshot; the
      // queued follow-up sync will merge them into the new server revision.
      if (getDataChangeVersion() === startingVersion) {
        await replaceAll({ ...snapshot, meta: [...snapshot.meta, ...localDeviceMeta] }, { notify: false, expectedVersion: startingVersion });
        if (forceCloudReplace) await setMeta("cloudReplacePending", false);
      }
      return { revision: saved.revision, updatedAt: saved.updatedAt };
    } catch (error) {
      if (error.status !== 409 || attempt === RETRIES - 1) throw error;
      local = snapshot;
    }
  }
  throw new Error("Synchronization could not resolve a conflict");
}

export function startSynchronization({ onStatus = () => {} } = {}) {
  let timer = null; let active = false; let queued = false; let stopped = false; let currentRun = Promise.resolve();
  const run = async () => {
    if (stopped) return;
    if (active) { queued = true; return; }
    active = true; onStatus("syncing");
    try { await synchronizeNow(); onStatus("synced"); }
    catch (error) { onStatus("error", error); }
    finally {
      active = false;
      if (queued && !stopped) { queued = false; schedule(50); }
    }
  };
  const invoke = () => {
    if (active) { queued = true; return; }
    currentRun = run();
  };
  const schedule = (delay = 500) => { clearTimeout(timer); timer = setTimeout(invoke, delay); };
  const changed = () => schedule();
  const online = () => schedule(0);
  window.addEventListener("pantry:data-changed", changed);
  window.addEventListener("online", online);
  schedule(0);
  return async () => {
    stopped = true; clearTimeout(timer);
    window.removeEventListener("pantry:data-changed", changed);
    window.removeEventListener("online", online);
    await currentRun.catch(() => {});
  };
}
