import { normalizeBarcode } from "../barcode.js";
import { CameraScanner } from "../scanner.js";
import { el, empty, sectionTitle, button, field, onLongPress } from "../ui.js";
import { openSheet, stepper } from "../sheet.js";

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
  const root = el("div", { class: "stack" });
  const intro = sectionTitle(settings.lastMode === "buy" ? "Bring groceries in." : "Mark a pack finished.", "Known barcodes fill themselves in. If one is missing, use a photo or type the details.");
  root.append(intro);
  const mode = el("div", { class: "mode-switch", role: "group", "aria-label": "Scanning mode" });
  for (const value of ["buy", "finished"]) {
    const control = el("button", { type: "button", text: value === "buy" ? "Buy / add stock" : "Finished / use up", "aria-pressed": settings.lastMode === value });
    control.addEventListener("click", async () => {
      await setMode(value); scanner?.modeChanged();
      document.querySelectorAll(".mode-switch button").forEach(btn => btn.setAttribute("aria-pressed", String(btn === control)));
      intro.querySelector("h1").textContent = value === "buy" ? "Bring groceries in." : "Mark a pack finished.";
      submitManual.textContent = value === "buy" ? "Add purchase" : "Mark finished";
    });
    mode.append(control);
  }
  root.append(mode);
  if (context.activeDraft?.scanningActive && !context.activeDraft.completedAt) {
    root.append(el("div", { class: "callout stack" }, [
      el("p", { class: "item-title", text: "Scanning this shopping list" }),
      el("p", { class: "meta", text: "Buy scans are linked to this exact shop. Finish when the bags are unpacked." }),
      button("Finish scanning this shop", "secondary", async () => { await context.finishScanDraft(); toast("Shopping session closed"); context.refresh(); })
    ]));
  }

  const camera = el("div", { class: "camera-shell" });
  const video = el("video", { muted: "", playsinline: "", "aria-label": "Camera preview" });
  video.muted = true;
  const message = el("div", { class: "camera-message" }, [el("p", { text: "Camera is starting…" })]);
  camera.append(video, el("div", { class: "aim", "aria-hidden": "true" }), message); root.append(camera);
  const controls = el("div", { class: "row wrap" }); root.append(controls);

  let scanner;
  let closeEditor = null;
  // Only decode while most of the camera is actually on screen, clear of the sticky header and floating nav.
  let cameraVisible = true;
  const visibility = new IntersectionObserver(entries => {
    const entry = entries[entries.length - 1];
    // Compare against the usable screen too, so a camera taller than the screen (landscape) can still count as visible.
    const usable = Math.min(entry.boundingClientRect.height, entry.rootBounds?.height ?? Infinity);
    cameraVisible = entry.isIntersecting && usable > 0 && entry.intersectionRect.height >= 0.6 * usable;
    camera.classList.toggle("is-paused", !cameraVisible);
    scanner?.setPaused("offscreen", !cameraVisible);
  }, { rootMargin: "-80px 0px -90px 0px", threshold: Array.from({ length: 21 }, (_, index) => index / 20) });
  visibility.observe(camera);
  camera.append(el("p", { class: "camera-paused", text: "Scanner paused · scroll up to scan", "aria-hidden": "true" }));
  async function startCamera() {
    message.hidden = false; message.firstChild.textContent = "Opening rear camera…";
    try {
      scanner?.stop();
      scanner = new CameraScanner(video, async detection => acceptCode(detection), (state, error) => {
        if (state === "native" || state === "fallback") { message.hidden = true; toast(`Scanner ready · ${state === "native" ? "phone decoder" : "offline decoder"}`); }
        if (state === "decode-error") console.warn("Decoder error", error);
      });
      scanner.setPaused("offscreen", !cameraVisible);
      await scanner.start({ forceFallback: settings.forceFallback });
    } catch (error) {
      message.hidden = false; message.replaceChildren(el("div", { class: "stack" }, [el("p", { text: error.name === "NotAllowedError" ? "Camera permission was denied. You can retry or enter a code manually." : error.message }), button("Retry camera", "primary", startCamera)]));
    }
  }
  controls.append(button("Enable / retry camera", "secondary", startCamera));
  controls.append(button("No barcode? Identify product", "primary", async () => { scanner?.stop(); await context.identifyWithoutBarcode(); if (!document.hidden) context.refresh(); }));

  const manualForm = el("form", { class: "stack manual-form" });
  const code = el("input", { inputmode: "numeric", autocomplete: "off", placeholder: "e.g. 5000112548167", required: "" });
  const format = el("select");
  [["ean_13", "EAN-13"], ["ean_8", "EAN-8"], ["upc_a", "UPC-A"], ["upc_e", "UPC-E"], ["code_128", "Code 128"]].forEach(([value, label]) => format.append(el("option", { value, text: label })));
  const qty = el("input", { type: "number", min: "1", step: "1", value: "1", inputmode: "numeric" });
  const submitManual = button(settings.lastMode === "buy" ? "Add purchase" : "Mark finished", "primary"); submitManual.type = "submit";
  manualForm.append(field("Code", code), field("Format", format), field("Pack quantity", qty), submitManual);
  manualForm.addEventListener("submit", async event => {
    event.preventDefault();
    try { const canonical = normalizeBarcode(code.value, format.value); await acceptCode({ code: canonical, format: format.value, qty: Number(qty.value), source: "manual" }); code.value = ""; }
    catch (error) { toast(error.message, { error: true }); }
  });
  const manualEntry = el("details", { class: "card manual-entry" }, [el("summary", { text: "Can’t scan it? Enter the barcode" }), manualForm]);
  root.append(manualEntry);

  const session = el("div", { class: "stack" });
  const renderSession = () => {
    session.replaceChildren(el("h2", { text: "This session" }));
    const events = context.sessionEvents();
    if (!events.length) { session.append(empty("Nothing logged yet", "Your saved scans will appear here.")); return; }
    session.append(el("p", { class: "meta session-hint", text: "Scans are saved to your stock straight away. Hold an item to change or remove it." }));
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
  return { root, cleanup: () => { closeEditor?.(); scanner?.stop(); visibility.disconnect(); window.removeEventListener("sessionchange", renderSession); } };
}
