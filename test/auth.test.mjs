import test from "node:test";
import assert from "node:assert/strict";
import { createAuthClient, createAuthGate, isPlausibleEmail } from "../src/auth.js";

function mockClient() {
  const calls = [];
  let authChange;
  const user = { id: "user-1", email: "person@example.com" };
  return {
    calls,
    user,
    auth: {
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
