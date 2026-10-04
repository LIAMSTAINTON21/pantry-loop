import test from "node:test";
import assert from "node:assert/strict";
import { createProductIdentificationHandler } from "../supabase/functions/identify-product/handler.mjs";
import { MODEL, PRODUCT_SCHEMA, parseImageDataUrl } from "../supabase/functions/_shared/product-identification.mjs";

const env = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-only",
  OPENAI_API_KEY: "openai-test-only",
  ALLOWED_EMAIL: "owner@example.com",
  ALLOWED_ORIGIN: "https://owner.example.com"
};
const validPng = () => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const request = (image = validPng(), headers = {}) => new Request("https://project.supabase.co/functions/v1/identify-product", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer user-jwt-test", origin: env.ALLOWED_ORIGIN, ...headers },
  body: JSON.stringify({ image })
});
const response = product => new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 1000, output_tokens: 100 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(product) }] }] }), { status: 200 });
const product = { product_name: "Tomato Soup", brand: "Tesco", quantity: "400g", price: 0.75, currency: "GBP", category: "Soup", confidence: "high" };

test("rejects missing JWT before any upstream or accounting request", async () => {
  let calls = 0;
  const handler = createProductIdentificationHandler({ env, fetchImpl: async () => { calls++; throw new Error("unexpected"); } });
  const result = await handler(new Request("https://project.supabase.co/functions/v1/identify-product", { method: "POST", headers: { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }, body: JSON.stringify({ image: validPng() }) }));
  assert.equal(result.status, 401);
  assert.equal(calls, 0);
});

test("enforces exact email and allowed web origin before quota reservation", async () => {
  let calls = 0;
  const handler = createProductIdentificationHandler({ env, fetchImpl: async () => { calls++; return Response.json({ id: "user-1", email: "other@example.com" }); } });
  assert.equal((await handler(request())).status, 403);
  assert.equal(calls, 1);
  assert.equal((await handler(request(validPng(), { origin: "https://attacker.example" }))).status, 403);
  assert.equal(calls, 1);
});

test("validates declared MIME against signature and image dimensions", () => {
  assert.deepEqual(parseImageDataUrl(validPng()).mediaType, "image/png");
  assert.throws(() => parseImageDataUrl(`data:image/jpeg;base64,${Buffer.from("not jpeg").toString("base64")}`), /bytes do not match/);
  const huge = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(huge); huge.write("IHDR", 12, "ascii"); huge.writeUInt32BE(8192, 16); huge.writeUInt32BE(8192, 20);
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${huge.toString("base64")}`), /dimensions are too large/);
});

test("returns the fixed OpenAI structured result after a durable quota reservation", async () => {
  const calls = [];
  const handler = createProductIdentificationHandler({ env, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1", email: "Owner@Example.com" });
    if (url.endsWith("/rest/v1/rpc/reserve_product_identification")) return Response.json({ status: "reserved", scans_remaining: 9, estimated_cost_gbp: 0.25 });
    if (url.endsWith("/rest/v1/rpc/settle_product_identification")) return Response.json(null);
    return response(product);
  } });
  const result = await handler(request());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), product);
  assert.equal(result.headers.get("x-ratelimit-remaining"), "9");
  const sent = JSON.parse(calls[2].options.body);
  assert.equal(calls[2].url, "https://api.openai.com/v1/responses");
  assert.equal(sent.model, MODEL);
  assert.equal(sent.store, false);
  assert.deepEqual(sent.text.format.schema, PRODUCT_SCHEMA);
  assert.equal(sent.input[0].content[1].detail, "low");
  assert.equal(calls[3].url, "https://project.supabase.co/rest/v1/rpc/settle_product_identification");
  assert.equal(JSON.parse(calls[3].options.body).p_actual_cost_gbp, "0.000210");
});

test("does not call OpenAI when persistent quota reports a daily or monthly cap", async () => {
  for (const status of ["daily_limit", "monthly_limit"]) {
    let calls = 0;
    const handler = createProductIdentificationHandler({ env, fetchImpl: async url => {
      calls++;
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1", email: "owner@example.com" });
      return Response.json({ status });
    } });
    const result = await handler(request());
    assert.equal(result.status, 429);
    assert.equal(calls, 2);
  }
});

test("reconciles usage returned with an OpenAI error, retaining the reservation when usage is absent", async () => {
  for (const withUsage of [true, false]) {
    const calls = [];
    const handler = createProductIdentificationHandler({ env, fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1", email: "owner@example.com" });
      if (url.endsWith("/rest/v1/rpc/reserve_product_identification")) return Response.json({ status: "reserved", scans_remaining: 9, estimated_cost_gbp: 0.25 });
      if (url.endsWith("/rest/v1/rpc/settle_product_identification")) return Response.json(null);
      return new Response(JSON.stringify(withUsage ? { error: { message: "temporary failure" }, usage: { input_tokens: 1000, output_tokens: 100 } } : { error: { message: "temporary failure" } }), { status: 503 });
    } });
    const result = await handler(request());
    assert.equal(result.status, 502);
    const settled = calls.some(call => call.url.endsWith("/rest/v1/rpc/settle_product_identification"));
    assert.equal(settled, withUsage);
  }
});
