import { createProductIdentificationHandler } from "./handler.mjs";

Deno.serve(createProductIdentificationHandler({ env: Deno.env.toObject() }));
