// Build elements with textContent for user-provided strings, avoiding HTML
// interpolation while keeping screen construction concise.
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

export function empty(message, detail = "") {
  return el("div", { class: "empty" }, [el("p", { class: "item-title", text: message }), detail && el("p", { class: "meta", text: detail })]);
}

export function sectionTitle(title, detail = "") {
  return el("div", {}, [el("h1", { text: title }), detail && el("p", { class: "lede", text: detail })]);
}

export function button(label, className = "secondary", handler = null) {
  return el("button", { type: "button", class: className, text: label, onclick: handler });
}

export function field(labelText, input) {
  return el("label", {}, [document.createTextNode(labelText), input]);
}

// Moving a finger cancels the hold so scrolling never opens an editor.
export function onLongPress(node, handler, delay = 500) {
  let timer = null; let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; node.classList.remove("is-pressing"); };
  node.addEventListener("pointerdown", event => {
    cancel();
    if (event.button) return;
    start = { x: event.clientX, y: event.clientY }; node.classList.add("is-pressing");
    timer = setTimeout(() => { timer = null; node.classList.remove("is-pressing"); navigator.vibrate?.(20); handler(); }, delay);
  });
  node.addEventListener("pointermove", event => { if (timer && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel(); });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) node.addEventListener(type, cancel);
  node.addEventListener("contextmenu", event => event.preventDefault());
  node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handler(); } });
  node.addEventListener("click", event => { if (event.detail === 0) handler(); });
}
