import { createPantryServer } from "./app.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
for (const filename of [".env.local", ".env"]) {
  const envFile = path.join(projectRoot, filename);
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
    break;
  }
}

const allowedEmail = String(process.env.ALLOWED_EMAIL ?? "").trim();
if (!allowedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail)) {
  console.error("ALLOWED_EMAIL must be set to the one email address permitted to sign in.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

const server = createPantryServer();
server.listen(port, "127.0.0.1", () => console.info(`[pantry-loop] Secure local server listening on http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
