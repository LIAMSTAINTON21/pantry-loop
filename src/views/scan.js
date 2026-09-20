import { normalizeBarcode } from "../barcode.js";
import { CameraScanner } from "../scanner.js";
import { el, empty, sectionTitle, button, field } from "../ui.js";

export async function renderScan(context) {
  const { settings, setMode, acceptCode, toast } = context;
  const root = el("div", { class: "stack" });
  const intro = sectionTitle(settings.lastMode === "buy" ? "Bring groceries in." : "Mark a pack finished.", "Keep scanning without tapping between packs. Naming happens later.");
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
  async function startCamera() {
    message.hidden = false; message.firstChild.textContent = "Opening rear camera…";
    try {
      scanner = new CameraScanner(video, async detection => acceptCode(detection), (state, error) => {
        if (state === "native" || state === "fallback") { message.hidden = true; toast(`Scanner ready · ${state === "native" ? "phone decoder" : "offline decoder"}`); }
        if (state === "decode-error") console.warn("Decoder error", error);
      });
      await scanner.start({ forceFallback: settings.forceFallback });
    } catch (error) {
      message.hidden = false; message.replaceChildren(el("div", { class: "stack" }, [el("p", { text: error.name === "NotAllowedError" ? "Camera permission was denied. You can retry or enter a code manually." : error.message }), button("Retry camera", "primary", startCamera)]));
    }
  }
  controls.append(button("Enable / retry camera", "secondary", startCamera));

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
    if (!events.length) session.append(empty("Nothing logged yet", "Your saved scans will appear here."));
    else for (const item of events) session.append(el("article", { class: "session-item" }, [el("div", { class: "row spread" }, [el("p", { class: "item-title", text: item.name }), el("span", { class: "badge", text: `×${item.qty}` })]), el("p", { class: "meta", text: item.message })]));
  };
  renderSession(); window.addEventListener("sessionchange", renderSession);
  root.append(session);

  startCamera();
  return { root, cleanup: () => { scanner?.stop(); window.removeEventListener("sessionchange", renderSession); } };
}
