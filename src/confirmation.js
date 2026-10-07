// Keep quantity review, renaming, and removal in one modal. Callers provide the
// persistence operations so the same UI can review a new scan or edit a saved one.
import { el } from "./ui.js";

function actionButton(symbol, label, className, handler) {
  return el("button", { type: "button", class: `confirm-action ${className}`, onclick: handler }, [
    el("span", { class: "confirm-action-symbol", text: symbol, "aria-hidden": "true" }),
    el("span", { text: label })
  ]);
}

export function showScanConfirmation({ name, message, mode, qty = 1, onRename, onRemove, onConfirm, removalMessage = "This scan will not be saved to your session." }) {
  return new Promise(resolve => {
    const dialog = el("dialog", { class: "scan-confirmation", "aria-labelledby": "confirmation-title" });
    const panel = el("div", { class: "scan-confirmation-panel" });
    let quantity = Number.isSafeInteger(qty) && qty >= 0 ? qty : 1;
    let currentName = name;
    let busy = false;
    let finished = false;
    dialog.append(panel);
    document.body.append(dialog);

    const finish = result => {
      if (finished) return;
      finished = true;
      dialog.classList.add("is-leaving");
      setTimeout(() => { dialog.close(); dialog.remove(); resolve(result); }, 180);
    };

    const run = async (error, operation) => {
      // Lock every control during a write, then keep the dialog open on failure
      // so the user can retry without accidentally submitting twice.
      if (busy || finished) return;
      busy = true;
      const controls = [...panel.querySelectorAll("button, input")];
      const disabledStates = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      error.textContent = "";
      try { await operation(); }
      catch (reason) { error.textContent = reason?.message || "Could not save this change. Please try again."; }
      finally {
        busy = false;
        if (!finished) controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
      }
    };

    const showRemove = () => {
      if (busy || finished) return;
      const error = el("p", { class: "confirm-error", role: "alert" });
      panel.replaceChildren(
        el("div", { class: "confirm-icon confirm-icon-edit", text: "×", "aria-hidden": "true" }),
        el("h1", { id: "confirmation-title", class: "confirm-error", text: `Remove ${currentName}?` }),
        el("p", { class: "confirm-message", text: removalMessage }),
        error,
        el("div", { class: "confirm-actions" }, [
          actionButton("✓", "Yes — remove", "confirm-remove", () => run(error, async () => {
            await onRemove();
            finish({ action: "removed", name: currentName, qty: 0 });
          })),
          actionButton("×", "Cancel — keep reviewing", "confirm-change", () => { if (!busy) showReview(); })
        ])
      );
    };

    const showReview = () => {
      const error = el("p", { class: "confirm-error", role: "alert" });
      const count = el("output", { text: quantity, "aria-live": "polite", "aria-label": "Quantity" });
      const updateQuantity = delta => {
        if (busy || finished) return;
        quantity = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, quantity + delta));
        count.textContent = quantity;
        minus.disabled = quantity === 0;
        plus.disabled = quantity === Number.MAX_SAFE_INTEGER;
      };
      const minus = el("button", { type: "button", text: "−", "aria-label": "Decrease quantity", onclick: () => updateQuantity(-1) });
      const plus = el("button", { type: "button", text: "+", "aria-label": "Increase quantity", onclick: () => updateQuantity(1) });
      minus.disabled = quantity === 0;
      plus.disabled = quantity === Number.MAX_SAFE_INTEGER;
      panel.replaceChildren(
        el("div", { class: "confirm-icon confirm-icon-tick", text: "✓", "aria-hidden": "true" }),
        el("p", { class: "confirm-kicker", text: mode === "purchase" ? "CONFIRM PURCHASE" : "CONFIRM FINISHED ITEMS" }),
        el("h1", { id: "confirmation-title", text: currentName }),
        el("p", { class: "confirm-message", text: message }),
        el("p", { text: "Quantity" }),
        el("div", { class: "quantity", role: "group", "aria-label": "Item quantity" }, [minus, count, plus]),
        error,
        el("div", { class: "confirm-actions" }, [
          actionButton("✓", "Correct — continue", "confirm-keep", () => {
            if (busy || finished) return;
            // Zero requests removal; it never writes a zero-quantity stock event.
            if (quantity === 0) { showRemove(); return; }
            return run(error, async () => {
              await onConfirm(quantity);
              finish({ action: "kept", name: currentName, qty: quantity });
            });
          }),
          actionButton("×", "Wrong item", "confirm-change", () => { if (!busy && !finished) showRename(); })
        ])
      );
    };

    const showRename = () => {
      const input = el("input", { value: currentName, required: "", maxlength: "120", autocomplete: "off", "aria-label": "Correct item name" });
      const error = el("p", { class: "confirm-error", role: "alert" });
      const form = el("form", { class: "rename-form" });
      const save = actionButton("✓", "Save this name", "confirm-keep"); save.type = "submit";
      const remove = actionButton("×", "Remove this scan", "confirm-remove", showRemove);
      form.append(
        el("div", { class: "confirm-icon confirm-icon-edit", text: "?", "aria-hidden": "true" }),
        el("p", { class: "confirm-kicker", text: "WRONG ITEM?" }),
        el("h1", { id: "confirmation-title", text: "Name it correctly" }),
        el("p", { class: "confirm-message", text: "This name will be remembered for this barcode from now on." }),
        el("label", { class: "rename-label" }, [document.createTextNode("Item name"), input]),
        error,
        el("div", { class: "confirm-actions" }, [save, remove])
      );
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (busy || finished) return;
        const nextName = input.value.trim();
        if (!nextName) { error.textContent = "Enter a name for this item"; input.focus(); return; }
        void run(error, async () => {
          await onRename(nextName);
          currentName = nextName;
          showReview();
        });
      });
      panel.replaceChildren(form); requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.select(); } });
    };

    dialog.addEventListener("cancel", event => event.preventDefault());
    showReview();
    dialog.showModal();
    requestAnimationFrame(() => dialog.classList.add("is-visible"));
  });
}

export function showRemovalConfirmation(name, message = "Remove this product from the current list?") {
  return new Promise(resolve => {
    const dialog = el("dialog", { class: "scan-confirmation", "aria-labelledby": "removal-title" });
    let finished = false;
    const finish = confirmed => {
      if (finished) return;
      finished = true;
      dialog.close();
      dialog.remove();
      resolve(confirmed);
    };
    dialog.append(el("div", { class: "scan-confirmation-panel" }, [
      el("h1", { id: "removal-title", class: "confirm-error", text: `Remove ${name}?` }),
      el("p", { class: "confirm-message", text: message }),
      el("div", { class: "confirm-actions" }, [
        actionButton("✓", "Remove product", "confirm-remove", () => finish(true)),
        actionButton("×", "Cancel", "confirm-change", () => finish(false))
      ])
    ]));
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => dialog.classList.add("is-visible"));
  });
}
