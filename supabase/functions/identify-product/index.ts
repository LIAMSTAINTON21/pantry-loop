// Supabase supplies secrets at runtime; no service credentials are bundled in
// the browser-facing application.
import { createProductIdentificationHandler } from "./handler.mjs";

Deno.serve(createProductIdentificationHandler({ env: Deno.env.toObject() }));
