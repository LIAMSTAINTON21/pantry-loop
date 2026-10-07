// Assemble the scan screen: camera input and typed barcodes share the same review
// flow, while session cards refer to individual saved events, not total stock.
import { normalizeBarcode } from "../barcode.js";
import { CameraScanner } from "../scanner.js";
import { el, empty, sectionTitle, button, field } from "../ui.js";

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
  let disposed = false;
  async function startCamera() {
    if (disposed || document.hidden) return;
    scanner?.stop();
    let candidate;
    message.hidden = false; message.firstChild.textContent = "Opening rear camera…";
    try {
      candidate = new CameraScanner(video, async detection => acceptCode(detection), (state, error) => {
        if (disposed || scanner !== candidate) return;
        if (state === "native" || state === "fallback") { message.hidden = true; toast(`Scanner ready · ${state === "native" ? "phone decoder" : "offline decoder"}`); }
        if (state === "decode-error") console.warn("Decoder error", error);
        if (state === "accept-error") toast(error.message || "Could not review this scan", { error: true });
      }, context.scanGate);
      scanner = candidate;
      await candidate.start({ forceFallback: settings.forceFallback });
    } catch (error) {
      if (disposed || scanner !== candidate) return;
      message.hidden = false; message.replaceChildren(el("div", { class: "stack" }, [el("p", { text: error.name === "NotAllowedError" ? "Camera permission was denied. You can retry or enter a code manually." : error.message }), button("Retry camera", "primary", startCamera)]));
    }
  }
  controls.append(button("Enable / retry camera", "secondary", startCamera));
  controls.append(button("No barcode? Identify product", "primary", () => context.identifyWithoutBarcode()));

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
  // Redraw only the session list after edits; restarting the camera here would
  // throw away its repeat suppression and could count the held barcode again.
  const renderSession = () => {
    session.replaceChildren(el("h2", { text: "This session" }), el("p", { class: "meta", text: "Confirmed scans are saved immediately. Edit an entry, or hold it to remove it." }));
    const events = context.sessionEvents();
    if (!events.length) session.append(empty("Nothing logged yet", "Your saved scans will appear here."));
    else for (const item of events) {
      const card = el("article", { class: "session-item" }, [el("div", { class: "row spread" }, [el("p", { class: "item-title", text: item.name }), el("span", { class: "badge", text: `×${item.qty}` })]), el("p", { class: "meta", text: item.message }), el("div", { class: "row wrap" }, [button("Edit quantity / name", "secondary", () => context.editSessionItem(item)), button("× Remove", "danger", () => context.editSessionItem(item, true))])]);
      let hold = null;
      let origin = null;
      const cancelHold = () => { clearTimeout(hold); hold = null; };
      card.addEventListener("pointerdown", event => {
        // A moving finger is scrolling, not a request to delete the entry.
        cancelHold();
        if (event.button !== 0 || event.target.closest("button")) return;
        origin = { x: event.clientX, y: event.clientY };
        hold = setTimeout(() => { if (!disposed && card.isConnected) context.editSessionItem(item, true); }, 600);
      });
      card.addEventListener("pointermove", event => { if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancelHold(); });
      for (const name of ["pointerup", "pointercancel", "pointerleave"]) card.addEventListener(name, cancelHold);
      session.append(card);
    }
    if (events.length) session.append(button("Finish & view saved stock", "primary", async () => { await context.finishScanDraft(); location.hash = "#stock"; }));
  };
  renderSession(); window.addEventListener("sessionchange", renderSession);
  root.append(session);

  startCamera();
  return { root, cleanup: () => { disposed = true; scanner?.stop(); window.removeEventListener("sessionchange", renderSession); } };
}
