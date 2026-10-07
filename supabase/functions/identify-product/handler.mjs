import {
  DAILY_SCAN_LIMIT, INPUT_GBP_PER_MILLION, MAX_REQUEST_BYTES, MODEL, MONTHLY_COST_CAP_GBP,
  OUTPUT_GBP_PER_MILLION,
  OPENAI_URL, PRODUCT_SCHEMA, RESERVED_CALL_GBP, SYSTEM_PROMPT, USER_PROMPT,
  parseImageDataUrl, validateProduct
} from "../_shared/product-identification.mjs";

// Keep parsing, account checks, quota accounting, provider calls, and output
// validation in a framework-light handler that can be exercised in tests.
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
});

async function requestJson(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "body_too_large" });
  if (!request.body) throw Object.assign(new Error("Request body must be a JSON object"), { status: 400, code: "invalid_json" });
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("Request body is too large"), { status: 413, code: "body_too_large" });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch { throw Object.assign(new Error("Request body must be a JSON object"), { status: 400, code: "invalid_json" }); }
}

function corsHeaders(origin, allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": origin && origin === allowedOrigin ? allowedOrigin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

export function createProductIdentificationHandler({ env, fetchImpl = fetch }) {
  const baseUrl = String(env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const openAiKey = String(env.OPENAI_API_KEY ?? "");
  const allowedEmail = String(env.ALLOWED_EMAIL ?? "").trim().toLowerCase();
  const allowedOrigin = String(env.ALLOWED_ORIGIN ?? "").trim().replace(/\/$/, "");

  return async function handle(request) {
    // Origin checks are a browser boundary; verifying the Supabase user below
    // is the separate account boundary before accepting an image.
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, allowedOrigin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405, { ...cors, Allow: "POST, OPTIONS" });
    if (origin && (!allowedOrigin || origin !== allowedOrigin)) return json({ error: { code: "cross_origin_denied", message: "This app origin is not allowed" } }, 403, cors);
    if (!baseUrl || !serviceKey || !allowedEmail || !allowedOrigin) return json({ error: { code: "service_not_configured", message: "Product identification is not configured" } }, 503, cors);

    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    if (!bearer) return json({ error: { code: "authentication_required", message: "Authentication required" } }, 401, cors);

    try {
      const userResponse = await fetchImpl(`${baseUrl}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${bearer[1]}` },
        signal: AbortSignal.timeout(10_000)
      });
      if (!userResponse.ok) return json({ error: { code: "authentication_required", message: "Authentication required" } }, 401, cors);
      const user = await userResponse.json();
      if (typeof user?.id !== "string" || String(user.email ?? "").trim().toLowerCase() !== allowedEmail) return json({ error: { code: "account_not_allowed", message: "This account is not permitted to identify products" } }, 403, cors);

      const contentType = String(request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") return json({ error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } }, 415, cors);
      const body = await requestJson(request);
      const image = parseImageDataUrl(body.image);
      if (!openAiKey) return json({ error: { code: "vision_not_configured", message: "Vision service is not configured" } }, 503, cors);

      const quotaResponse = await fetchImpl(`${baseUrl}/rest/v1/rpc/reserve_product_identification`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_user_id: user.id }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!quotaResponse.ok) throw Object.assign(new Error("Usage accounting failed"), { status: 503, code: "usage_accounting_unavailable" });
      const quota = await quotaResponse.json();
      // Reserve budget before the paid provider call. If the provider fails
      // without usable token counts, the reservation stays charged rather than
      // allowing unmetered retries.
      if (quota?.status === "daily_limit") return json({ error: { code: "daily_scan_limit", message: "Daily scan limit reached" } }, 429, { ...cors, "Retry-After": "86400" });
      if (quota?.status === "monthly_limit") return json({ error: { code: "monthly_cost_limit", message: "Monthly AI cost limit reached" } }, 429, { ...cors, "Retry-After": "86400" });
      if (quota?.status !== "reserved" || !Number.isInteger(quota.scans_remaining) || !Number.isFinite(Number(quota.estimated_cost_gbp))) throw Object.assign(new Error("Usage accounting returned an invalid result"), { status: 503, code: "usage_accounting_unavailable" });

      const upstream = await fetchImpl(OPENAI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openAiKey}` },
        body: JSON.stringify({
          model: MODEL,
          store: false,
          max_output_tokens: 400,
          instructions: SYSTEM_PROMPT,
          input: [{ role: "user", content: [
            { type: "input_text", text: USER_PROMPT },
            { type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}`, detail: "low" }
          ] }],
          text: { format: { type: "json_schema", name: "grocery_product", strict: true, schema: PRODUCT_SCHEMA } }
        }),
        signal: AbortSignal.timeout(30_000)
      });
      let result;
      try { result = await upstream.json(); } catch { result = null; }
      const inputTokens = result?.usage?.input_tokens;
      const outputTokens = result?.usage?.output_tokens;
      if (Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0) {
        const costGbp = Number((inputTokens / 1_000_000 * INPUT_GBP_PER_MILLION + outputTokens / 1_000_000 * OUTPUT_GBP_PER_MILLION).toFixed(6));
        const settlement = await fetchImpl(`${baseUrl}/rest/v1/rpc/settle_product_identification`, {
          method: "POST",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_user_id: user.id, p_actual_cost_gbp: costGbp.toFixed(6) }),
          signal: AbortSignal.timeout(10_000)
        });
        if (!settlement.ok) throw Object.assign(new Error("Usage reconciliation failed"), { status: 503, code: "usage_accounting_unavailable" });
      }
      if (!upstream.ok) return json({ error: { code: "vision_provider_error", message: "Vision provider request failed" } }, 502, cors);
      if (!result) return json({ error: { code: "invalid_vision_response", message: "Vision provider returned an invalid response" } }, 502, cors);
      if (result.status !== "completed" || result.incomplete_details) return json({ error: { code: "invalid_vision_response", message: "Vision provider did not return a complete product" } }, 502, cors);
      const content = result.output?.find(item => item?.type === "message")?.content;
      if (content?.some(block => block?.type === "refusal")) return json({ error: { code: "invalid_vision_response", message: "Vision provider refused the image" } }, 502, cors);
      const text = content?.find(block => block?.type === "output_text")?.text;
      let product;
      try { product = validateProduct(JSON.parse(text)); }
      catch { return json({ error: { code: "invalid_vision_response", message: "Vision provider returned an invalid product" } }, 502, cors); }
      return json(product, 200, { ...cors, "X-RateLimit-Limit": String(DAILY_SCAN_LIMIT), "X-RateLimit-Remaining": String(quota.scans_remaining), "X-Monthly-AI-Cap-GBP": String(MONTHLY_COST_CAP_GBP), "X-Monthly-AI-Reserved-GBP": String(RESERVED_CALL_GBP) });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = typeof error?.code === "string" ? error.code : "internal_error";
      const message = status >= 500 ? "The server could not complete the request" : error.message;
      return json({ error: { code, message } }, status, { ...cors, ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}) });
    }
  };
}
