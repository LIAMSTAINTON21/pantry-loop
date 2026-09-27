import test from "node:test";
import assert from "node:assert/strict";
import { catalogueAdapter, openFoodFactsAdapter } from "../src/lookup.js";
import { parseVisionProduct } from "../src/identification.js";

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
