import { el } from "./ui.js";

// Bottom sheet used for every edit/confirm flow. Content is built by the caller; the sheet handles
// open/close animation, Escape, backdrop taps (ignoring the lift of the finger that opened it) and a busy lock.
export function openSheet({ title, subtitle = null, content = [], onClose = null }) {
  let closed = false; let busy = false; const openedAt = performance.now();
  const dialog = el("dialog", { class: "sheet-dialog", "aria-labelledby": "sheet-title" });
  const panel = el("div", { class: "sheet-panel" }, [
    el("div", { class: "sheet-grabber", "aria-hidden": "true" }),
    el("h2", { id: "sheet-title", text: title }),
    subtitle && el("p", { class: "meta sheet-subtitle", text: subtitle }),
    ...content
  ]);
  dialog.append(panel);
  const close = ({ force = false } = {}) => {
    if (closed || (busy && !force)) return; closed = true;
    dialog.classList.remove("is-visible");
    setTimeout(() => { dialog.close(); dialog.remove(); onClose?.(); }, 180);
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("click", event => { if (event.target === dialog && performance.now() - openedAt > 400) close(); });
  document.body.append(dialog); dialog.showModal(); requestAnimationFrame(() => dialog.classList.add("is-visible"));
  return {
    dialog, panel, close,
    // Runs an async action with the sheet locked; closes on success, shows the error in the sheet on failure.
    async run(action, { error, keepOpen = false } = {}) {
      busy = true; panel.querySelectorAll("button, input, select, textarea").forEach(control => { control.dataset.wasDisabled = control.disabled; control.disabled = true; });
      try { await action(); busy = false; if (!keepOpen) close(); return true; }
      catch (reason) { busy = false; if (error) error.textContent = reason.message || "That did not work"; return false; }
      finally { panel.querySelectorAll("[data-was-disabled]").forEach(control => { control.disabled = control.dataset.wasDisabled === "true"; delete control.dataset.wasDisabled; }); }
    }
  };
}

export function stepper({ value, min = 0, label, unit = "", onChange }) {
  let current = value;
  const output = el("output", { class: "confirm-qty-value", text: String(current), "aria-live": "polite" });
  const minus = el("button", { type: "button", class: "confirm-qty-step", text: "−", "aria-label": `Reduce ${label}` });
  const plus = el("button", { type: "button", class: "confirm-qty-step", text: "+", "aria-label": `Increase ${label}` });
  const set = next => { current = Math.max(min, next); output.textContent = String(current); minus.disabled = current <= min; onChange?.(current); };
  minus.addEventListener("click", () => set(current - 1)); plus.addEventListener("click", () => set(current + 1));
  const node = el("div", { class: "confirm-qty", role: "group", "aria-label": label }, [minus, el("div", { class: "confirm-qty-readout" }, [output, unit && el("span", { class: "confirm-qty-label", text: unit })]), plus]);
  set(current);
  return { node, get value() { return current; }, set };
}
