import { getSupabaseClient } from "./supabase-config.js";

const GENERIC_REQUEST_ERROR = "We couldn’t send a sign-in link. Please wait a little and try again.";
const GENERIC_VERIFY_ERROR = "That code is invalid or has expired. Request a new code and try again.";

function normalizedEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isPlausibleEmail(value) {
  const email = normalizedEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function createAuthClient(clientPromise = getSupabaseClient()) {
  return {
    async session() {
      try {
        const client = await clientPromise;
        const { data, error } = await client.auth.getSession();
        if (error) return null;
        return data?.session?.user ?? null;
      }
      catch { return null; }
    },

    async requestCode(email) {
      const clean = normalizedEmail(email);
      if (!isPlausibleEmail(clean)) throw new Error("Enter a valid email address.");
      try {
        const client = await clientPromise;
        const location = globalThis.location;
        const redirectTo = location?.origin && location?.pathname ? `${location.origin}${location.pathname}` : undefined;
        const { error } = await client.auth.signInWithOtp({
          email: clean,
          options: { shouldCreateUser: false, ...(redirectTo ? { emailRedirectTo: redirectTo } : {}) }
        });
        if (error) throw error;
      } catch { throw new Error(GENERIC_REQUEST_ERROR); }
      return clean;
    },

    async verifyCode(email, code) {
      const cleanEmail = normalizedEmail(email);
      const cleanCode = String(code ?? "").replace(/\s+/g, "");
      if (!isPlausibleEmail(cleanEmail) || !/^\d{4,10}$/.test(cleanCode)) throw new Error(GENERIC_VERIFY_ERROR);
      try {
        const client = await clientPromise;
        const { data, error } = await client.auth.verifyOtp({ email: cleanEmail, token: cleanCode, type: "email" });
        if (error || !data?.user) throw new Error(GENERIC_VERIFY_ERROR);
        return data.user;
      } catch { throw new Error(GENERIC_VERIFY_ERROR); }
    },

    async logout() {
      try {
        const client = await clientPromise;
        const { error } = await client.auth.signOut();
        return { ok: !error };
      } catch { return { ok: false }; }
    },

    async onSignedOut(callback) {
      const client = await clientPromise;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || event === "USER_DELETED" || (event === "TOKEN_REFRESHED" && !session?.user)) callback();
      });
      return () => data?.subscription?.unsubscribe?.();
    }
  };
}

function element(documentRef, tag, options = {}, children = []) {
  const node = documentRef.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

export function createAuthGate({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  supabaseClient = getSupabaseClient(),
  protectedSelector = "[data-auth-protected]",
  beforeLogout = async () => true
} = {}) {
  if (!documentRef) throw new Error("Authentication needs a document");
  const root = documentRef.querySelector("#auth-root");
  if (!root) throw new Error("Missing #auth-root");
  const client = createAuthClient(supabaseClient);
  let currentUser = null;
  let loggingOut = false;
  let stopAuthWatcher = () => {};
  let resolveInitial;
  const initialAuthentication = new Promise(resolve => { resolveInitial = resolve; });

  const protectedNodes = () => [...documentRef.querySelectorAll(protectedSelector)];
  const setProtected = visible => {
    for (const node of protectedNodes()) {
      node.hidden = !visible;
      node.inert = !visible;
      if (visible) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", "true");
    }
  };

  const removeLogout = () => documentRef.querySelector("#auth-logout")?.remove();
  const unlock = user => {
    if (!resolveInitial) {
      windowRef?.location?.reload?.();
      return;
    }
    currentUser = user;
    root.hidden = true;
    root.replaceChildren();
    setProtected(true);
    removeLogout();
    const cluster = documentRef.querySelector(".status-cluster");
    if (cluster) cluster.append(element(documentRef, "button", { id: "auth-logout", type: "button", class: "status-chip auth-logout", text: "Sign out", onclick: logout }));
    resolveInitial?.({ user, logout, lock });
    resolveInitial = null;
  };

  const showRoot = () => {
    currentUser = null;
    removeLogout();
    setProtected(false);
    root.hidden = false;
  };

  const renderEmail = (message = "") => {
    showRoot();
    const email = element(documentRef, "input", { id: "auth-email", name: "email", type: "email", autocomplete: "email", inputmode: "email", required: "", maxlength: "254" });
    const status = element(documentRef, "p", { class: `auth-status${message ? " error" : ""}`, role: "status", "aria-live": "polite", text: message });
    const submit = element(documentRef, "button", { type: "submit", class: "primary", text: "Send sign-in link" });
    const form = element(documentRef, "form", { class: "auth-card" }, [
      element(documentRef, "p", { class: "eyebrow", text: "PANTRY LOOP" }),
      element(documentRef, "h1", { id: "auth-title", text: "Sign in" }),
      element(documentRef, "p", { class: "auth-copy", text: "Your private pantry. Enter your approved email to receive a one-time sign-in link." }),
      element(documentRef, "label", {}, [documentRef.createTextNode("Email address"), email]),
      status,
      submit
    ]);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      status.textContent = ""; status.classList.remove("error"); submit.disabled = true; submit.textContent = "Requesting…";
      try {
        const clean = await client.requestCode(email.value);
        renderCheckInbox(clean);
      } catch (error) {
        status.textContent = error.message; status.classList.add("error");
        submit.disabled = false; submit.textContent = "Send sign-in link";
      }
    });
    root.replaceChildren(element(documentRef, "section", { class: "auth-screen", "aria-labelledby": "auth-title" }, [form]));
    email.focus();
  };

  const renderCheckInbox = email => {
    showRoot();
    const status = element(documentRef, "p", { class: "auth-status", role: "status", "aria-live": "polite", text: "Check your inbox and spam folder. Delivery can take a few minutes." });
    const verify = element(documentRef, "button", { type: "submit", class: "primary", text: "I’ve opened the link" });
    const back = element(documentRef, "button", { type: "button", class: "ghost", text: "Back to sign in", onclick: () => renderEmail() });
    const form = element(documentRef, "form", { class: "auth-card" }, [
      element(documentRef, "p", { class: "eyebrow", text: "PANTRY LOOP" }),
      element(documentRef, "h1", { id: "auth-title", text: "Check your email" }),
      element(documentRef, "p", { class: "auth-copy", text: `If ${email} is the approved account, a sign-in link is on its way. Open it in the browser where you want to use Pantry Loop. There is no code to type.` }),
      status,
      verify,
      back
    ]);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      status.textContent = "Checking sign-in…"; status.classList.remove("error"); verify.disabled = true;
      const user = await client.session();
      if (user) unlock(user);
      else {
        status.textContent = "Not signed in here yet. Open the email link in this browser, or continue in the browser it opened.";
        verify.disabled = false;
      }
    });
    root.replaceChildren(element(documentRef, "section", { class: "auth-screen", "aria-labelledby": "auth-title" }, [form]));
    verify.focus();
  };

  const lock = (message = "") => renderEmail(message);

  async function logout() {
    loggingOut = true;
    showRoot();
    root.replaceChildren(element(documentRef, "section", { class: "auth-screen", "aria-label": "Signing out" }, [element(documentRef, "div", { class: "auth-card", text: "Signing out…" })]));
    let deviceCleared = false;
    try { deviceCleared = await beforeLogout(); } catch { deviceCleared = false; }
    const response = await client.logout();
    loggingOut = false;
    windowRef?.dispatchEvent?.(new CustomEvent("pantrylogout"));
    renderEmail(response?.ok !== true
      ? "Sign-out could not be confirmed. The app remains locked on this device."
      : deviceCleared === false
        ? "You’ve signed out. Unsynced device data was retained because synchronization was unavailable."
        : "You’ve signed out.");
  }

  async function start() {
    setProtected(false);
    root.hidden = false;
    root.replaceChildren(element(documentRef, "section", { class: "auth-screen", "aria-label": "Checking sign-in" }, [element(documentRef, "div", { class: "auth-card auth-checking", text: "Checking sign-in…" })]));
    stopAuthWatcher = await client.onSignedOut(() => {
      if (loggingOut || !currentUser) return;
      showRoot();
      renderEmail("Your session ended. Sign in again to continue.");
      windowRef?.dispatchEvent?.(new CustomEvent("pantrylogout"));
    });
    const user = await client.session();
    if (user) unlock(user);
    else renderEmail();
    return initialAuthentication;
  }

  return { start, logout, lock, destroy() { stopAuthWatcher(); }, get user() { return currentUser; } };
}

export async function requireAuthentication(options = {}) {
  const gate = createAuthGate(options);
  return gate.start();
}
