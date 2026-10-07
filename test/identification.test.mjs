import test from "node:test";
import assert from "node:assert/strict";
import { catalogueAdapter, openFoodFactsAdapter } from "../src/lookup.js";
import { parseVisionProduct, showIdentificationFallback } from "../src/identification.js";

// A tiny DOM substitute and stubbed fetch verify that suggestions stay
// reviewable, failures preserve the scanned code, and metadata is normalized.
test('unknown barcode starts AI automatically and reviews result; failure keeps barcode for manual entry', async () => {
  const originals = Object.fromEntries(['document', 'requestAnimationFrame', 'supabase', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = [];
  class Node {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.listeners = {}; this.classList = { add() {} }; nodes.push(this); }
    setAttribute(key, value) { this[key] = value; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    showModal() {} focus() {} close() {} remove() {}
  }
  const text = node => [node.textContent || '', ...(node.children ?? []).map(text)].join(' ');
  globalThis.document = { body: new Node('body'), createElement: tag => new Node(tag), createTextNode: value => ({ nodeType: 3, textContent: value }) };
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'test-only' } } }) } }) };
  let requests = 0, error = false;
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.deepEqual(JSON.parse(options.body), { barcode: '5000112548167', image: 'data:image/jpeg;base64,test' });
    return { ok: !error, status: error ? 503 : 200, json: async () => error ? { error: { message: 'Service unavailable' } } : { product: { product_name: 'Test milk', brand: 'Test brand', quantity: '2L' } } };
  };
  try {
    const args = { barcode: '5000112548167', initialImage: 'data:image/jpeg;base64,test', settings: {}, toast() {} };
    showIdentificationFallback(args);
    assert.match(text(document.body), /AI MODE/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.match(text(document.body), /AI suggestion/);
    assert.ok(nodes.some(node => node.tag === 'input' && node.value === 'Test milk'));
    error = true;
    showIdentificationFallback(args);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 2);
    assert.match(text(document.body), /AI mode couldn’t identify this item/);
    assert.ok(nodes.some(node => node.tag === 'input' && node.value === '5000112548167'));
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test("normalizes a Pepesto-style Tesco catalogue item", () => {
  assert.deepEqual(catalogueAdapter({ names: { en: "Tesco Whole Milk" }, brand: "Tesco", price: 165, currency: "GBP", quantity_str: "4 pints", image_url: "https://example.test/milk.jpg", entity_name: "Milk" }), {
    name: "Tesco Whole Milk", brand: "Tesco", size: "4 pints", price: 1.65, currency: "GBP", imageUrl: "https://example.test/milk.jpg", category: "Milk", source: "Tesco GB catalogue"
  });
});

test("normalizes Open Food Facts metadata", () => {
  assert.equal(openFoodFactsAdapter({ product: { code: "5000112548167", product_name: "Cola", brands: "Brand", quantity: "2L", categories: "Drinks, Fizzy", image_front_url: "https://example.test/cola.jpg" } }, "5000112548167").category, "Drinks");
});

test("parses structured vision JSON and fenced proxy output", () => {
  const parsed = parseVisionProduct({ output_text: "```json\n{\"product_name\":\"Tomato Soup\",\"brand\":\"Tesco\",\"quantity\":\"400g\",\"price\":0.75}\n```" });
  assert.equal(parsed.name, "Tomato Soup");
  assert.equal(parsed.size, "400g");
  assert.equal(parsed.price, 0.75);
});

test("rejects vision output without a product name", () => {
  assert.equal(parseVisionProduct({ brand: "Unknown" }), null);
});
