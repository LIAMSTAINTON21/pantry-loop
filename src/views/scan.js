import { normalizeBarcode } from "../barcode.js";
import { CameraScanner } from "../scanner.js";
import { el, button, field, onLongPress } from "../ui.js";
import { openSheet, stepper } from "../sheet.js";
import { icon } from "../icons.js";

const MODE_COPY = {
  buy: { label: "Add to stock", hint: "Scan to add to your stock", submit: "Add to stock" },
  finished: { label: "Used up", hint: "Scan a pack you’ve finished", submit: "Mark used up" }
};

function showManualEntry(mode, { onSubmit, onClose, onOpen }) {
  const error = el("p", { class: "confirm-error", role: "alert" });
  const code = el("input", { inputmode: "numeric", autocomplete: "off", enterkeyhint: "done", placeholder: "e.g. 5000112548167", required: "", "aria-describedby": "manual-error" });
  error.id = "manual-error";
  const format = el("select");
  [["ean_13", "EAN-13 (most UK groceries)"], ["ean_8", "EAN-8"], ["upc_a", "UPC-A"], ["upc_e", "UPC-E"], ["code_128", "Code 128"]].forEach(([value, label]) => format.append(el("option", { value, text: label })));
  const qty = stepper({ value: 1, min: 1, label: "Pack quantity", unit: "packs" });
  const submit = el("button", { type: "submit", class: "primary", text: MODE_COPY[mode].submit });
  const form = el("form", { class: "stack" }, [field("Barcode number", code), field("Barcode type", format), qty.node, error, submit, button("Cancel", "ghost", () => sheet.close())]);
  const sheet = openSheet({ title: "Type a barcode", subtitle: "Use the numbers printed under the bars.", content: [form], onClose });
  onOpen?.(() => sheet.close({ force: true }));
  form.addEventListener("submit", event => {
    event.preventDefault();
    sheet.run(() => onSubmit({ code: code.value, format: format.value, qty: qty.value }), { error });
  });
  requestAnimationFrame(() => code.focus());
}

function showSessionEditor(item, { onSave, onRemove, onOpen }) {
  return new Promise(resolve => {
    const error = el("p", { class: "confirm-error", role: "alert" });
    let save = null;
    const qty = stepper({ value: item.qty, min: 1, label: `${item.name} quantity`, unit: item.type === "purchase" ? "packs bought" : "packs finished", onChange: value => { if (save) save.disabled = value === item.qty; } });
    save = button("Save quantity", "primary", () => sheet.run(() => onSave(qty.value), { error }));
    save.disabled = true;
    const remove = el("button", { type: "button", class: "sheet-remove", onclick: () => sheet.run(onRemove, { error }) }, [el("span", { text: "✕", "aria-hidden": "true" }), el("span", { text: "Remove product" })]);
    const sheet = openSheet({
      title: item.name, subtitle: item.message, onClose: resolve,
      content: [qty.node, save, el("div", { class: "sheet-danger" }, [el("p", { class: "sheet-question", text: `Remove ${item.name} from this session?` }), remove]), error, button("Cancel", "ghost", () => sheet.close())]
    });
    onOpen?.(() => sheet.close({ force: true }));
  });
}

export async function renderScan(context) {
  const { settings, setMode, acceptCode, toast } = context;
  const root = el("div", { class: "stack scan-view" });
  // Same mapping as acceptCode in main.js: anything other than "buy" records a finished pack.
  let mode = settings.lastMode === "buy" ? "buy" : "finished";
  root.append(el("h1", { class: "sr-only", text: "Scan groceries" }));

  // Mode toggle sits directly above the camera so the camera is the first thing on screen.
  const modes = el("div", { class: "mode-switch", role: "group", "aria-label": "What are you scanning?" });
  const hint = el("p", { class: "camera-hint", "aria-live": "polite" });
  const syncMode = () => {
    modes.querySelectorAll("button").forEach(btn => btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode)));
    hint.replaceChildren(icon(mode === "buy" ? "plus" : "minus", { size: 16 }), document.createTextNode(MODE_COPY[mode].hint));
    root.dataset.mode = mode;
  };
  for (const value of ["buy", "finished"]) {
    const control = el("button", { type: "button", "data-mode": value }, [icon(value === "buy" ? "plus" : "minus", { size: 18 }), el("span", { text: MODE_COPY[value].label })]);
    control.addEventListener("click", async () => {
      if (mode === value) return;
      mode = value; syncMode();
      await setMode(value); scanner?.modeChanged();
    });
    modes.append(control);
  }
  root.append(modes);

  if (context.activeDraft?.scanningActive && !context.activeDraft.completedAt) {
    root.append(el("div", { class: "scan-banner", role: "status" }, [
      icon("cart", { size: 18 }),
      el("p", { text: "Scans are linked to your shopping list" }),
      button("Finish", "ghost scan-banner-action", async () => { await context.finishScanDraft(); toast("Shop finished"); context.refresh(); })
    ]));
  }

  const camera = el("div", { class: "camera-shell" });
  const video = el("video", { muted: "", playsinline: "", "aria-label": "Camera preview" });
  video.muted = true;
  const message = el("div", { class: "camera-message" }, [el("p", { text: "Opening the camera…" })]);
  camera.append(video, el("div", { class: "aim", "aria-hidden": "true" }), hint, message);
  root.append(camera);
  syncMode();

  let scanner;
  let closeEditor = null; let closeManual = null;
  // Only decode while most of the camera is actually on screen, clear of the sticky header and floating nav.
  let cameraVisible = true;
  const visibility = new IntersectionObserver(entries => {
    const entry = entries[entries.length - 1];
    // Compare against the usable screen too, so a camera taller than the screen (landscape) can still count as visible.
    const usable = Math.min(entry.boundingClientRect.height, entry.rootBounds?.height ?? Infinity);
    cameraVisible = entry.isIntersecting && usable > 0 && entry.intersectionRect.height >= 0.6 * usable;
    camera.classList.toggle("is-paused", !cameraVisible);
    scanner?.setPaused("offscreen", !cameraVisible);
  }, { rootMargin: "-64px 0px -90px 0px", threshold: Array.from({ length: 21 }, (_, index) => index / 20) });
  visibility.observe(camera);
  camera.append(el("p", { class: "camera-paused", text: "Scanner paused · scroll up to scan", "aria-hidden": "true" }));
  let cameraAttempt = null;
  async function startCamera() {
    message.hidden = false; message.replaceChildren(el("p", { text: "Opening the camera…" }));
    camera.classList.remove("is-ready");
    // If the permission prompt is dismissed without an answer, start() may never settle; offer a retry.
    const attempt = Symbol("camera"); cameraAttempt = attempt;
    setTimeout(() => { if (cameraAttempt === attempt && !camera.classList.contains("is-ready") && !message.querySelector("button")) message.append(button("Try again", "secondary", startCamera)); }, 6000);
    try {
      scanner?.stop();
      scanner = new CameraScanner(video, async detection => acceptCode(detection), (state, error) => {
        if (state === "native" || state === "fallback") { message.hidden = true; camera.classList.add("is-ready"); }
        if (state === "decode-error") console.warn("Decoder error", error);
      });
      scanner.setPaused("offscreen", !cameraVisible);
      await scanner.start({ forceFallback: settings.forceFallback });
    } catch (error) {
      if (cameraAttempt !== attempt) return; // a newer attempt owns the camera now
      message.hidden = false;
      message.replaceChildren(el("div", { class: "camera-error" }, [
        icon("camera", { size: 28 }),
        el("p", { text: error.name === "NotAllowedError" ? "Camera access is off. Allow it in your browser settings, or type the barcode instead." : error.message }),
        button("Try the camera again", "primary", startCamera)
      ]));
    }
  }

  const pauseFor = async (reason, task) => { scanner?.setPaused(reason, true); try { await task(); } finally { scanner?.setPaused(reason, false); } };
  const typeBarcode = el("button", { type: "button", class: "scan-action" }, [icon("keyboard", { size: 20 }), el("span", { text: "Type barcode" })]);
  typeBarcode.addEventListener("click", () => pauseFor("manual", () => new Promise(resolve => showManualEntry(mode, {
    onClose: () => { closeManual = null; resolve(); },
    onOpen: close => { closeManual = close; },
    onSubmit: async ({ code, format, qty }) => {
      const canonical = normalizeBarcode(code, format);
      setTimeout(() => acceptCode({ code: canonical, format, qty, source: "manual" }).catch(error => toast(error.message, { error: true })), 200);
    }
  }))));
  const identify = el("button", { type: "button", class: "scan-action" }, [icon("sparkle", { size: 20 }), el("span", { text: "No barcode" })]);
  identify.addEventListener("click", async () => { scanner?.stop(); await context.identifyWithoutBarcode(); if (!document.hidden) context.refresh(); });
  root.append(el("div", { class: "scan-actions" }, [typeBarcode, identify]));

  const session = el("div", { class: "stack" });
  const renderSession = () => {
    const events = context.sessionEvents();
    session.replaceChildren(el("h2", { class: "list-section" }, ["This session", events.length ? el("span", { class: "list-count", text: `${events.length} item${events.length === 1 ? "" : "s"}` }) : null]));
    if (!events.length) { session.append(el("p", { class: "meta session-hint", text: "Scans save to your stock straight away and show up here." })); return; }
    session.append(el("p", { class: "meta session-hint", text: "Hold an item to change the amount or remove it." }));
    for (const item of events) {
      const card = el("article", { class: "session-item", tabindex: "0", role: "button", "aria-label": `${item.name}, ${item.qty} ${item.type === "purchase" ? "bought" : "finished"}. Press to change or remove.` }, [el("div", { class: "row spread" }, [el("p", { class: "item-title", text: item.name }), el("span", { class: item.type === "purchase" ? "badge" : "badge warn", text: `${item.type === "purchase" ? "+" : "−"}${item.qty}` })]), el("p", { class: "meta", text: item.message })]);
      onLongPress(card, async () => {
        scanner?.setPaused("editor", true);
        try {
          await showSessionEditor(item, {
            onSave: async qty => { await context.editSessionRow(item.key, qty); toast(`${item.name} set to ${qty}`); },
            onRemove: async () => { await context.editSessionRow(item.key, 0); toast(`${item.name} removed`); },
            onOpen: close => { closeEditor = close; }
          });
        } finally { closeEditor = null; scanner?.setPaused("editor", false); }
      });
      session.append(card);
    }
  };
  renderSession(); window.addEventListener("sessionchange", renderSession);
  root.append(session);

  startCamera();
  return { root, cleanup: () => { closeEditor?.(); closeManual?.(); scanner?.stop(); visibility.disconnect(); window.removeEventListener("sessionchange", renderSession); } };
}
