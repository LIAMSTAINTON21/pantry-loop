import { el } from "./ui.js";

function actionButton(symbol, label, className, handler) {
  return el("button", { type: "button", class: `confirm-action ${className}`, onclick: handler }, [
    el("span", { class: "confirm-action-symbol", text: symbol, "aria-hidden": "true" }),
    el("span", { text: label })
  ]);
}

export function showScanConfirmation({ name, message, mode, qty = 1, aiIdentified = false, onRename, onRemove, onQuantity }) {
  return new Promise(resolve => {
    const dialog = el("dialog", { class: "scan-confirmation", "aria-labelledby": "confirmation-title" });
    const panel = el("div", { class: "scan-confirmation-panel" });
    dialog.append(panel);
    document.body.append(dialog);

    const finish = result => {
      dialog.classList.add("is-leaving");
      setTimeout(() => { dialog.close(); dialog.remove(); resolve(result); }, 180);
    };

    let renamed = false;
    const showSaved = (currentName, startQty = qty) => {
      let currentQty = startQty;
      const error = el("p", { class: "confirm-error", role: "alert" });
      const value = el("output", { class: "confirm-qty-value", text: String(currentQty), "aria-live": "polite" });
      const minus = el("button", { type: "button", class: "confirm-qty-step", text: "−", "aria-label": "Reduce quantity" });
      const plus = el("button", { type: "button", class: "confirm-qty-step", text: "+", "aria-label": "Increase quantity" });
      const keep = actionButton("✓", "Correct — continue", "confirm-keep", async () => {
        if (currentQty === 0) { showRemoveCheck(currentName); return; }
        const action = renamed ? "renamed" : "kept";
        if (currentQty === qty) { finish({ action, name: currentName }); return; }
        const target = currentQty; const controls = [keep, minus, plus, change];
        controls.forEach(control => { control.disabled = true; });
        try { await onQuantity(target); qty = target; finish({ action, name: currentName, qty: target }); }
        catch (reason) { error.textContent = reason.message || "Could not change the quantity"; controls.forEach(control => { control.disabled = false; }); minus.disabled = currentQty === 0; }
      });
      const change = actionButton("×", "Wrong item", "confirm-change", () => showRename(currentName));
      const setQty = next => {
        currentQty = Math.max(0, next); value.textContent = String(currentQty); minus.disabled = currentQty === 0;
        keep.lastChild.textContent = currentQty === 0 ? "Remove item" : currentQty === qty ? "Correct — continue" : `Save ${currentQty}`;
      };
      minus.addEventListener("click", () => setQty(currentQty - 1));
      plus.addEventListener("click", () => setQty(currentQty + 1));
      setQty(currentQty);
      panel.replaceChildren(
        el("div", { class: "confirm-icon confirm-icon-tick", text: "✓", "aria-hidden": "true" }),
        el("p", { class: "confirm-kicker", text: mode === "purchase" ? "PURCHASE SAVED" : "PACK FINISHED" }),
        aiIdentified && el("p", { class: "ai-badge", text: "AI MODE · CHECK THE NAME" }),
        el("h1", { id: "confirmation-title", text: currentName }),
        el("p", { class: "confirm-message", text: message }),
        el("div", { class: "confirm-qty", role: "group", "aria-label": mode === "purchase" ? "Packs bought" : "Packs finished" }, [
          minus, el("div", { class: "confirm-qty-readout" }, [value, el("span", { class: "confirm-qty-label", text: mode === "purchase" ? "packs bought" : "packs finished" })]), plus
        ]),
        error,
        el("div", { class: "confirm-actions" }, [
          keep,
          change
        ])
      );
    };

    const showRemoveCheck = currentName => {
      const error = el("p", { class: "confirm-error", role: "alert" });
      const yes = actionButton("✓", "Yes, remove it", "confirm-remove", async () => {
        yes.disabled = true; no.disabled = true;
        try { await onRemove(); finish({ action: "removed" }); }
        catch (reason) { error.textContent = reason.message || "Could not remove this scan"; yes.disabled = false; no.disabled = false; }
      });
      const no = actionButton("×", "No, keep it", "confirm-change", () => showSaved(currentName));
      panel.replaceChildren(
        el("div", { class: "confirm-icon confirm-icon-remove", text: "−", "aria-hidden": "true" }),
        el("p", { class: "confirm-kicker confirm-kicker-danger", text: "QUANTITY IS 0" }),
        el("h1", { id: "confirmation-title", class: "confirm-danger-title", text: `Remove ${currentName}?` }),
        el("p", { class: "confirm-message", text: mode === "purchase" ? "This scan will be undone and it won’t be added to your stock." : "This scan will be undone and the pack stays in your stock." }),
        error,
        el("div", { class: "confirm-actions" }, [yes, no])
      );
      requestAnimationFrame(() => no.focus());
    };

    const showRename = currentName => {
      const input = el("input", { value: currentName, required: "", maxlength: "120", autocomplete: "off", "aria-label": "Correct item name" });
      const error = el("p", { class: "confirm-error", role: "alert" });
      const form = el("form", { class: "rename-form" });
      const save = actionButton("✓", "Save this name", "confirm-keep"); save.type = "submit";
      const remove = actionButton("×", "Remove this scan", "confirm-remove", async () => {
        remove.disabled = true; save.disabled = true;
        try { await onRemove(); finish({ action: "removed" }); }
        catch (reason) { error.textContent = reason.message || "Could not remove this scan"; remove.disabled = false; save.disabled = false; }
      });
      form.append(
        el("div", { class: "confirm-icon confirm-icon-edit", text: "?", "aria-hidden": "true" }),
        el("p", { class: "confirm-kicker", text: "WRONG ITEM?" }),
        el("h1", { id: "confirmation-title", text: "Name it correctly" }),
        el("p", { class: "confirm-message", text: "This name will be remembered for this barcode from now on." }),
        el("label", { class: "rename-label" }, [document.createTextNode("Item name"), input]),
        error,
        el("div", { class: "confirm-actions" }, [save, remove])
      );
      form.addEventListener("submit", async event => {
        event.preventDefault(); const nextName = input.value.trim();
        if (!nextName) { error.textContent = "Enter a name for this item"; input.focus(); return; }
        save.disabled = true; remove.disabled = true;
        try { await onRename(nextName); renamed = true; showSaved(nextName); }
        catch (reason) { error.textContent = reason.message || "Could not save that name"; save.disabled = false; remove.disabled = false; }
      });
      panel.replaceChildren(form); requestAnimationFrame(() => { input.focus(); input.select(); });
    };

    dialog.addEventListener("cancel", event => event.preventDefault());
    showSaved(name);
    dialog.showModal();
    requestAnimationFrame(() => dialog.classList.add("is-visible"));
  });
}
