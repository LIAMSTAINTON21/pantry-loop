import test from "node:test";
import assert from "node:assert/strict";
import { createAuthClient, createAuthGate, isPlausibleEmail } from "../src/auth.js";

// Mock Supabase auth to exercise OTP, restored sessions, and sign-out without
// depending on an external account or network.
function mockClient() {
  const calls = [];
  let authChange;
  const user = { id: "user-1", email: "person@example.com" };
  return {
    calls,
    user,
    rpc: async name => ({ data: name === "is_allowed_account", error: null }),
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      getSession: async () => ({ data: { session: { user } }, error: null }),
      signInWithOtp: async input => { calls.push(["otp", input]); return { error: null }; },
      verifyOtp: async input => { calls.push(["verify", input]); return { data: { user }, error: null }; },
      signOut: async () => { calls.push(["signOut"]); return { error: null }; },
      onAuthStateChange: callback => { authChange = callback; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    emitAuth(event, session = null) { authChange?.(event, session); }
  };
}

test("validates email and requests an existing user's Supabase email OTP", async () => {
  const supabase = mockClient();
  const client = createAuthClient(supabase);
  assert.equal(isPlausibleEmail(" Person@Example.COM "), true);
  assert.equal(isPlausibleEmail("not-an-email"), false);
  assert.equal(await client.requestCode(" Person@Example.COM "), "person@example.com");
  assert.deepEqual(supabase.calls[0], ["otp", { email: "person@example.com", options: { shouldCreateUser: false } }]);
});

test("verifies numeric email OTP through Supabase and returns only the user", async () => {
  const supabase = mockClient();
  const client = createAuthClient(supabase);
  assert.deepEqual(await client.verifyCode(" Person@Example.COM ", "123 456"), supabase.user);
  assert.deepEqual(supabase.calls[0], ["verify", { email: "person@example.com", token: "123456", type: "email" }]);
});

test("email redirects omit release queries and authentication fragments", async () => {
  const previous = globalThis.location;
  globalThis.location = { origin: "https://example.com", pathname: "/pantry-loop/", href: "https://example.com/pantry-loop/?release=old#private" };
  try {
    const supabase = mockClient();
    await createAuthClient(supabase).requestCode("person@example.com");
    assert.equal(supabase.calls[0][1].options.emailRedirectTo, "https://example.com/pantry-loop/");
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test("reads persisted sessions including sessions established by a magic-link callback", async () => {
  const supabase = mockClient();
  const client = createAuthClient(supabase);
  assert.deepEqual(await client.session(), supabase.user);
});

test("auth gate unlocks at startup when Supabase restored a magic-link session", async () => {
  const supabase = mockClient();
  const root = { hidden: false, replaceChildren() {} };
  const documentRef = {
    querySelector: selector => selector === "#auth-root" ? root : null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, removeAttribute() {}, addEventListener() {}, append() {} })
  };
  const gate = createAuthGate({ documentRef, supabaseClient: supabase });
  const result = await gate.start();
  assert.equal(result.user, supabase.user);
  assert.equal(gate.user, supabase.user);
  assert.equal(root.hidden, true);
});

test("signs out of the Supabase session", async () => {
  const supabase = mockClient();
  const client = createAuthClient(supabase);
  assert.deepEqual(await client.logout(), { ok: true });
  assert.deepEqual(supabase.calls[0], ["signOut"]);
});

test("observes remote sign-out events", async () => {
  const supabase = mockClient();
  let signedOut = 0;
  await createAuthClient(supabase).onSignedOut(() => { signedOut += 1; });
  supabase.emitAuth("TOKEN_REFRESHED", { user: supabase.user });
  supabase.emitAuth("SIGNED_OUT");
  assert.equal(signedOut, 1);
});

test("maps service failures to generic auth errors", async () => {
  const unavailable = { auth: { signInWithOtp: async () => ({ error: new Error("service unavailable") }) } };
  await assert.rejects(createAuthClient(unavailable).requestCode("person@example.com"), /couldn’t send a sign-in link/i);
  const invalid = { auth: { verifyOtp: async () => ({ data: null, error: new Error("invalid token") }) } };
  await assert.rejects(createAuthClient(invalid).verifyCode("person@example.com", "123456"), /invalid or has expired/i);
});

test("a cached user cannot unlock without server verification and allowlist approval", async () => {
  const client = mockClient();
  client.auth.getUser = async () => ({ error: new Error("revoked"), data: null });
  assert.equal(await createAuthClient(client).session(), null);
  client.auth.getUser = async () => ({ data: { user: client.user }, error: null });
  client.rpc = async () => ({ data: false, error: null });
  assert.equal(await createAuthClient(client).session(), null);
  client.rpc = async () => { throw new Error("offline"); };
  assert.equal(await createAuthClient(client).session(), null);
});

test("account changes during verification are rejected", async () => {
  const client = mockClient();
  client.auth.getSession = async () => ({ data: { session: { user: { id: "different-account" } } }, error: null });
  assert.equal(await createAuthClient(client).session(), null);
});

test("a different account signing in triggers the same lock as remote sign-out", async () => {
  const client = mockClient(); let locked = 0;
  await createAuthClient(client).onSignedOut(() => { locked++; }, () => "user-1");
  client.emitAuth("SIGNED_IN", { user: client.user }); assert.equal(locked, 0);
  client.emitAuth("SIGNED_IN", { user: { id: "user-2" } }); assert.equal(locked, 1);
});

function gateFixture() {
  const node = () => ({ hidden: false, inert: false, replaceChildren() {}, append() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, classList: { add() {}, remove() {} } });
  const root = node(), protectedNode = node();
  return { root, protectedNode, documentRef: { querySelector: selector => selector === "#auth-root" ? root : null, querySelectorAll: () => [protectedNode], createElement: node, createTextNode: () => node() } };
}

test("protected routes remain hidden until account storage is ready", async () => {
  const fixture = gateFixture(); let ready;
  const gate = createAuthGate({ ...fixture, supabaseClient: mockClient(), beforeUnlock: () => new Promise(resolve => { ready = resolve; }) });
  const started = gate.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.protectedNode.hidden, true); assert.equal(fixture.protectedNode.inert, true);
  ready(); await started;
  assert.equal(fixture.protectedNode.hidden, false); gate.destroy();
});

test("a sign-out during account setup cannot reveal a stale protected route", async () => {
  const fixture = gateFixture(); const client = mockClient(); let ready;
  const gate = createAuthGate({ ...fixture, supabaseClient: client, beforeUnlock: () => new Promise(resolve => { ready = resolve; }) });
  gate.start(); await new Promise(resolve => setImmediate(resolve));
  client.emitAuth("SIGNED_OUT"); ready(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.protectedNode.hidden, true); assert.equal(gate.user, null); gate.destroy();
});
