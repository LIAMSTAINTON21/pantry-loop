// Public browser configuration only. Populate these with the Supabase project URL
// and publishable key before deployment. Never put a service role key here.
export const SUPABASE_URL = "https://ksbbchrfflarlpcgsufp.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_oIdWvKg75g3VIFEPrPja7A_X45TwXSg";

let clientPromise;

export async function getSupabaseClient() {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) || SUPABASE_URL.includes("YOUR_PROJECT_REF") || SUPABASE_PUBLISHABLE_KEY.includes("YOUR_")) {
    throw new Error("Supabase is not configured yet.");
  }
  // Share one initialization promise across callers so concurrent screens do
  // not create separate auth clients or race session restoration.
  clientPromise ??= Promise.resolve().then(() => {
    const createClient = globalThis.supabase?.createClient;
    if (typeof createClient !== "function") throw new Error("Supabase client failed to load.");
    return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  });
  return clientPromise;
}
