import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

// Merging parallel UI releases can silently duplicate tabs or mix offline bundles.
// These checks validate the assembled release without a browser or network calls.
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("primary navigation has exactly one link per app route", async () => {
  const html = await read("index.html");
  const routes = [...html.matchAll(/data-route="([^"]+)"/g)].map(match => match[1]);
  assert.equal(routes.length, new Set(routes).size);
  assert.deepEqual([...routes].sort(), ["catalogue", "list", "scan", "settings", "stock"]);
});

test("offline release identifiers match and all cached assets exist", async () => {
  const [html, bootstrap, main, worker] = await Promise.all(["index.html", "src/bootstrap.js", "src/main.js", "sw.js"].map(read));
  const release = html.match(/bootstrap\.js\?release=([^"']+)/)?.[1];
  assert.ok(release);
  for (const source of [bootstrap, main]) assert.ok(source.includes(`sw.js?release=${release}`));
  assert.ok(worker.includes(`bootstrap.js?release=${release}`));
  const assets = [...worker.matchAll(/"(\.\/[^"\n]*)"/g)].map(match => match[1]);
  for (const path of assets) await access(new URL(path.split("?")[0], root));
  for (const path of ["./src/views/stock.js", "./src/icons.js", "./src/sheet.js"]) assert.ok(assets.includes(path));
});
