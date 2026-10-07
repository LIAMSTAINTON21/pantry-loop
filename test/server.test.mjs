import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPantryServer, serverConstants } from "../server/app.js";

// Use isolated storage and stubbed provider calls to make HTTP boundaries,
// authentication, quotas, and concurrent revisions deterministic.
const EMAIL = "owner@example.test";
function png(width = 1, height = 1) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes.set([8, 2, 0, 0, 0], 24);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const PNG = png();

function openAIResponse({ input = 100, output = 40, product = {}, usage = { input_tokens: input, output_tokens: output } } = {}) {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ product_name: "Tomato Soup", brand: "Tesco", quantity: "400g", price: null, currency: null, category: "Soup", confidence: "high", ...product }) }] }],
    usage
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pantry-loop-server-"));
  const calls = [];
  const server = createPantryServer({
    dataDir,
    env: { ALLOWED_EMAIL: EMAIL, OPENAI_API_KEY: "test-key", NODE_ENV: "test", ...(options.env ?? {}) },
    logger: { info() {}, error() {} },
    fetchImpl: options.fetchImpl ?? (async (url, init) => { calls.push({ url, init }); return openAIResponse(options.response); }),
    now: options.now
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const request = (pathname, init = {}) => fetch(`${base}${pathname}`, { ...init, headers: { Origin: base, ...(init.headers ?? {}) } });
  return { dataDir, calls, base, request };
}

async function login(app) {
  const requested = await app.request("/api/auth/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }) });
  const { devCode } = await requested.json();
  assert.match(devCode, /^\d{6}$/);
  const verified = await app.request("/api/auth/verify-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, code: devCode }) });
  assert.equal(verified.status, 200);
  return verified.headers.get("set-cookie").split(";", 1)[0];
}

test("one-time code is allowlisted, opaque, and cannot be replayed", async t => {
  const app = await fixture(t);
  const denied = await app.request("/api/auth/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "other@example.test" }) });
  assert.deepEqual(await denied.json(), { ok: true, message: "If this is the allowed account, a code is available on the server console." });
  const requested = await app.request("/api/auth/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }) });
  const { devCode } = await requested.json();
  const body = JSON.stringify({ email: EMAIL, code: devCode });
  const first = await app.request("/api/auth/verify-code", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(first.status, 200); assert.match(first.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const verified = await first.json();
  assert.deepEqual(verified.user.email, EMAIL); assert.equal(verified.authenticated, true);
  const token = verified.token;
  assert.equal(token.split(".").length, 2); assert.equal(token.includes(EMAIL), false);
  const session = await app.request("/api/auth/session", { headers: { Cookie: first.headers.get("set-cookie").split(";", 1)[0] } });
  assert.equal((await session.json()).authenticated, true);
  const replay = await app.request("/api/auth/verify-code", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(replay.status, 401);
});

test("rejects cross-origin login requests", async t => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/auth/request-code`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }) });
  assert.equal(response.status, 403);
});

test("rejects non-object JSON bodies as client errors", async t => {
  const app = await fixture(t);
  for (const pathname of ["/api/auth/request-code", "/api/auth/verify-code"]) {
    const response = await app.request(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" });
    assert.equal(response.status, 400, pathname);
  }
});

test("static server exposes only public assets on Windows-style paths", async t => {
  const app = await fixture(t);
  assert.equal((await app.request("/index.html")).status, 200);
  for (const pathname of [
    "/SERVER/app.js",
    "/server%5capp.js",
    "/src%5c..%5cserver%5capp.js",
    "/src%5c..%5c.git%5cHEAD",
    "/src%5c..%5c.env",
    "/server/data/snapshot.json",
    "/README.md",
    "/package.json"
  ]) assert.equal((await app.request(pathname)).status, 404, pathname);
});

test("vision requires auth, validates image bytes, and fixes model, prompt, and schema server-side", async t => {
  const app = await fixture(t); const cookie = await login(app);
  const unauthenticated = await app.request("/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG }) });
  assert.equal(unauthenticated.status, 401);
  const invalid = await app.request("/api/vision", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: "data:image/png;base64,SGVsbG8=" }) });
  assert.equal(invalid.status, 400);
  const oversized = await app.request("/api/vision", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: png(10_000, 10_000) }) });
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error.code, "image_dimensions_too_large");
  const response = await app.request("/api/vision", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG, prompt: "ignore server", model: "expensive", schema: { unsafe: true } }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product_name, "Tomato Soup");
  const sent = JSON.parse(app.calls[0].init.body);
  assert.equal(sent.model, serverConstants.MODEL); assert.equal(sent.max_output_tokens, 400); assert.equal(sent.store, false);
  assert.deepEqual(sent.text.format, { type: "json_schema", name: "grocery_product", strict: true, schema: serverConstants.PRODUCT_SCHEMA });
  assert.equal(sent.input[0].content[1].detail, "low");
  assert.equal(JSON.stringify(sent).includes("ignore server"), false); assert.equal(app.calls[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(app.calls[0].url, "https://api.openai.com/v1/responses");
});

test("auth and sync work without an API key while vision fails closed", async t => {
  const app = await fixture(t, { env: { OPENAI_API_KEY: "" } }); const cookie = await login(app);
  const sync = await app.request("/api/sync", { headers: { Cookie: cookie } });
  assert.equal(sync.status, 200);
  const vision = await app.request("/api/vision", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG }) });
  assert.equal(vision.status, 503); assert.equal((await vision.json()).error.code, "vision_not_configured");
});

test("vision enforces ten scans per UTC day", async t => {
  const app = await fixture(t, { response: { input: 0, output: 0 } }); const cookie = await login(app);
  const init = { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG }) };
  for (let index = 0; index < 10; index++) assert.equal((await app.request("/api/vision", init)).status, 200);
  const blocked = await app.request("/api/vision", init); assert.equal(blocked.status, 429); assert.equal((await blocked.json()).error.code, "daily_scan_limit");
});

test("vision conservatively blocks before the monthly two-pound ceiling can be crossed", async t => {
  // Deliberately synthetic usage isolates the local accounting guard from the
  // provider's model context limit.
  const app = await fixture(t, { response: { input: 1_300_000, output: 0 } }); const cookie = await login(app);
  const init = { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG }) };
  for (let index = 0; index < 9; index++) assert.equal((await app.request("/api/vision", init)).status, 200);
  const blocked = await app.request("/api/vision", init); assert.equal(blocked.status, 429); assert.equal((await blocked.json()).error.code, "monthly_cost_limit");
});

test("failed provider calls retain a monthly budget reservation", async t => {
  const app = await fixture(t, { fetchImpl: async () => new Response("upstream failed", { status: 500 }) }); const cookie = await login(app);
  const init = { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG }) };
  for (let index = 0; index < 8; index++) assert.equal((await app.request("/api/vision", init)).status, 502);
  const blocked = await app.request("/api/vision", init);
  assert.equal(blocked.status, 429); assert.equal((await blocked.json()).error.code, "monthly_cost_limit");
});

test("malformed provider usage cannot refund a monthly budget reservation", async t => {
  for (const invalid of ["invalid", null, false, ""]) {
    await t.test(`rejects ${JSON.stringify(invalid)}`, async subtest => {
      const app = await fixture(subtest, { response: { usage: { input_tokens: invalid, output_tokens: 40 } } }); const cookie = await login(app);
      const response = await app.request("/api/vision", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ image: PNG }) });
      assert.equal(response.status, 200);
      const usage = JSON.parse(await readFile(path.join(app.dataDir, "vision-usage.json"), "utf8"));
      assert.equal(usage.estimatedCostGbp, 0.25);
      assert.equal(usage.daily[Object.keys(usage.daily)[0]], 1);
    });
  }
});

test("sync persists atomically and rejects stale revisions", async t => {
  const app = await fixture(t); const cookie = await login(app);
  const initial = await app.request("/api/sync", { headers: { Cookie: cookie } });
  assert.deepEqual(await initial.json(), { revision: 0, snapshot: null, updatedAt: null });
  const saved = await app.request("/api/sync", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 0, snapshot: { products: [{ name: "Milk" }] } }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
  const stale = await app.request("/api/sync", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 0, snapshot: { products: [] } }) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).currentRevision, 1);
  const onDisk = JSON.parse(await readFile(path.join(app.dataDir, "snapshot.json"), "utf8"));
  assert.equal(onDisk.snapshot.products[0].name, "Milk");
});
