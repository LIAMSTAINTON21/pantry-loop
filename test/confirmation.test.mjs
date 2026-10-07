import test from "node:test";
import assert from "node:assert/strict";
import { showScanConfirmation } from "../src/confirmation.js";

// Exercise the dialog's real event handlers without a browser or DOM dependency.
class TestNode {
  constructor(tagName = "#text", text = "") {
    this.tagName = tagName.toUpperCase();
    this.nodeType = tagName === "#text" ? 3 : 1;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.disabled = false;
    this._text = text;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(" ").trim(); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (["value", "type", "min", "max", "step", "id"].includes(name)) this[name] = String(value);
    if (name === "disabled") this.disabled = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === "disabled") this.disabled = false; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = ""; this.append(...children); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) ?? []; handlers.push(handler); this.listeners.set(name, handlers); }
  async emit(name) {
    const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    await Promise.all((this.listeners.get(name) ?? []).map(handler => handler(event)));
    return event;
  }
  matches(selector) {
    const match = selector.trim().match(/^([\w-]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/);
    if (!match) throw new Error(`Unsupported test selector: ${selector}`);
    const [, tag, className, attribute, value] = match;
    return (!tag || this.tagName === tag.toUpperCase()) && (!className || this.classList.contains(className)) && (!attribute || (value === undefined ? this.attributes.has(attribute) : this.getAttribute(attribute) === value));
  }
  querySelectorAll(selector) {
    const selectors = selector.split(",");
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    return selector === "*" ? descendants : descendants.filter(child => selectors.some(item => child.matches(item)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { globalThis.document.activeElement = this; }
  select() { this.selected = true; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
}

function setup(t, options = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const body = new TestNode("body");
  globalThis.document = { body, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode("#text", text) };
  globalThis.requestAnimationFrame = callback => callback();
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    if (previousFrame) Object.defineProperty(globalThis, "requestAnimationFrame", previousFrame); else delete globalThis.requestAnimationFrame;
  });
  const result = showScanConfirmation({ name: "Milk", message: "Review this scan", mode: "purchase", qty: 1, ...options });
  const dialog = body.querySelector("dialog");
  const findButton = label => {
    const found = dialog.querySelectorAll("button").find(button => button.textContent.includes(label) || button.getAttribute("aria-label") === label);
    assert.ok(found, `Expected button: ${label}; visible buttons: ${dialog.querySelectorAll("button").map(button => button.textContent).join(", ")}`);
    return found;
  };
  return { body, dialog, result, findButton };
}

test("chosen quantity is saved only when confirmed", async t => {
  const writes = [];
  const ui = setup(t, { onConfirm: async qty => writes.push(qty) });
  await ui.findButton("Increase quantity").emit("click");
  await ui.findButton("Increase quantity").emit("click");
  assert.deepEqual(writes, []);
  await ui.findButton("Correct — continue").emit("click");
  assert.deepEqual(writes, [3]);
  assert.equal((await ui.result).qty, 3);
});

test("zero requires explicit removal and cancelling keeps the review open", async t => {
  let removed = 0, saved = 0;
  const ui = setup(t, { onRemove: async () => { removed++; }, onConfirm: async () => { saved++; } });
  await ui.findButton("Decrease quantity").emit("click");
  assert.equal(ui.findButton("Decrease quantity").disabled, true);
  await ui.findButton("Correct — continue").emit("click");
  assert.match(ui.dialog.textContent, /Remove Milk/);
  assert.equal(removed, 0);
  await ui.findButton("Cancel — keep reviewing").emit("click");
  assert.equal(ui.dialog.querySelector("output").textContent, "0");
  await ui.findButton("Correct — continue").emit("click");
  await ui.findButton("Yes — remove").emit("click");
  assert.equal((await ui.result).action, "removed");
  assert.equal(removed, 1);
  assert.equal(saved, 0);
});

test("failed save stays editable and retry uses the new quantity", async t => {
  const writes = [];
  const ui = setup(t, { onConfirm: async qty => { writes.push(qty); if (writes.length === 1) throw new Error("Storage unavailable"); } });
  await ui.findButton("Correct — continue").emit("click");
  assert.match(ui.dialog.textContent, /Storage unavailable/);
  assert.equal(ui.findButton("Increase quantity").disabled, false);
  await ui.findButton("Increase quantity").emit("click");
  await ui.findButton("Correct — continue").emit("click");
  assert.deepEqual(writes, [1, 2]);
  await ui.result;
});

test("pending save ignores double submission and quantity changes", async t => {
  let release;
  let saves = 0;
  const ui = setup(t, { onConfirm: () => { saves++; return new Promise(resolve => { release = resolve; }); } });
  const first = ui.findButton("Correct — continue").emit("click");
  await ui.findButton("Correct — continue").emit("click");
  await ui.findButton("Increase quantity").emit("click");
  assert.equal(saves, 1);
  assert.equal(ui.dialog.querySelector("output").textContent, "1");
  release(); await first; await ui.result;
});

test("failed removal can be retried without saving a zero event", async t => {
  let removals = 0;
  const ui = setup(t, { qty: 0, onRemove: async () => { if (++removals === 1) throw new Error("Removal failed"); } });
  await ui.findButton("Correct — continue").emit("click");
  await ui.findButton("Yes — remove").emit("click");
  assert.match(ui.dialog.textContent, /Removal failed/);
  await ui.findButton("Yes — remove").emit("click");
  assert.equal(removals, 2);
  await ui.result;
});
