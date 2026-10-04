import { el, field } from "./ui.js";
import { CameraScanner } from "./scanner.js";
import { identifyBarcode } from "./lookup.js";
import { getSupabaseClient, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase-config.js";

const visionEndpoint = () => `${SUPABASE_URL}/functions/v1/identify-product`;

function action(symbol, label, className, handler) {
  return el("button", { type: "button", class: `identify-choice ${className}`, onclick: handler }, [
    el("span", { class: "identify-symbol", text: symbol, "aria-hidden": "true" }), el("span", { text: label })
  ]);
}

export async function compressProductImage(file, maxDimension = 1280, quality = 0.78) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}

export function parseVisionProduct(data) {
  let value = data?.product ?? data;
  if (typeof value?.output_text === "string") value = value.output_text;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { value = JSON.parse(cleaned); } catch { return null; }
  }
  const name = String(value?.product_name ?? value?.name ?? "").trim();
  if (!name) return null;
  const price = value.price === null || value.price === undefined || value.price === "" ? null : Number(value.price);
  return {
    name, brand: String(value.brand ?? "").trim() || null,
    size: String(value.quantity ?? value.size ?? "").trim() || null,
    price: Number.isFinite(price) ? price : null,
    currency: String(value.currency ?? "GBP").trim().toUpperCase() || "GBP",
    category: String(value.category ?? "").trim() || null,
    imageUrl: null, source: "Vision identification"
  };
}

async function identifyPhoto(image, barcode) {
  const client = await getSupabaseClient();
  const { data: authData, error: authError } = await client.auth.getSession();
  const accessToken = authData?.session?.access_token;
  if (authError || !accessToken) throw new Error("Sign in again before identifying a product");
  const response = await fetch(visionEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ image, barcode })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const safeMessage = typeof data?.error?.message === "string" ? data.error.message : null;
    throw new Error(response.status === 413 ? "That photo is too large" : safeMessage || `Photo identification failed (${response.status})`);
  }
  const product = parseVisionProduct(data);
  if (!product) throw new Error("I couldn’t identify that product");
  return product;
}

export function showIdentificationFallback({ barcode = null, barcodeFormat = null, settings, toast }) {
  return new Promise(resolve => {
    const dialog = el("dialog", { class: "identify-dialog", "aria-labelledby": "identify-title" });
    const panel = el("div", { class: "identify-panel" }); dialog.append(panel); document.body.append(dialog);
    let barcodeScanner = null;
    let screenVersion = 0;
    let draft = {};
    const stopBarcodeScanner = () => { barcodeScanner?.stop(); barcodeScanner = null; };
    const finish = value => { screenVersion++; stopBarcodeScanner(); dialog.classList.add("is-leaving"); setTimeout(() => { dialog.close(); dialog.remove(); resolve(value); }, 180); };
    const errorText = barcode ? "We couldn’t find this barcode in the product catalogue." : "No barcode? You can still add the product.";

    const showOptions = () => {
      screenVersion++;
      stopBarcodeScanner();
      const file = el("input", { type: "file", accept: "image/*", capture: "environment", class: "sr-only", "aria-label": "Take a photo of the product" });
      file.addEventListener("change", async () => {
        if (!file.files?.[0]) return;
        showLoading(file.files[0]);
      });
      panel.replaceChildren(
        el("p", { class: "confirm-kicker", text: "PRODUCT NOT FOUND" }),
        el("h1", { id: "identify-title", text: "How should we identify it?" }),
        el("p", { class: "confirm-message", text: errorText }),
        el("div", { class: "identify-options" }, [
          action("▣", "Scan barcode + read label", "identify-photo", () => showBarcodeScanner(draft)),
          action("Aa", "Enter details manually", "identify-manual", () => showForm({}, { code: barcode, format: barcodeFormat }))
        ]), file,
        el("button", { type: "button", class: "identify-cancel", text: "Cancel", onclick: () => finish(null) })
      );
    };

    const showLoading = async file => {
      stopBarcodeScanner();
      const version = ++screenVersion;
      panel.replaceChildren(el("span", { class: "spinner identify-spinner", "aria-hidden": "true" }), el("h1", { id: "identify-title", text: "Reading the package…" }), el("p", { class: "confirm-message", text: "Looking for the product, brand, variant and pack size." }), el("div", { class: "identify-skeleton" }));
      try {
        const image = typeof file === "string" ? file : await compressProductImage(file);
        const product = await identifyPhoto(image, barcode);
        if (version !== screenVersion) return;
        showForm({ ...draft, ...product }, { code: barcode, format: barcodeFormat });
      } catch (error) {
        if (version !== screenVersion) return;
        toast(`${error.message}. Your barcode has been kept.`, { error: true });
        showForm(draft, { code: barcode, format: barcodeFormat });
      }
    };

    const showBarcodeScanner = async (product = {}) => {
      stopBarcodeScanner();
      draft = product;
      const version = ++screenVersion;
      const video = el("video", { muted: "", playsinline: "", "aria-label": "Barcode camera preview" }); video.muted = true;
      const status = el("p", { class: "confirm-message", text: "Opening the rear camera…" });
      const codeStatus = el("p", { class: "meta", text: barcode ? `Barcode saved: ${barcode}` : "Show the barcode first, then turn the pack to its front label." });
      const capture = el("button", { type: "button", class: "primary", text: "Read name and brand from this picture", onclick: () => {
        if (!video.videoWidth) { status.textContent = "Wait for the camera picture first."; return; }
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        showLoading(canvas.toDataURL("image/jpeg", 0.78));
      } });
      capture.disabled = true;
      const photo = el("input", { type: "file", accept: "image/*", capture: "environment", class: "sr-only", "aria-label": "Choose product photo" });
      photo.addEventListener("change", () => { if (photo.files?.[0]) showLoading(photo.files[0]); });
      panel.replaceChildren(el("p", { class: "confirm-kicker", text: "BARCODE + PRODUCT LABEL" }), el("h1", { id: "identify-title", text: "Scan, then show the label" }), el("div", { class: "identify-camera" }, [video, el("div", { class: "aim", "aria-hidden": "true" })]), codeStatus, status, capture, photo, el("button", { type: "button", class: "secondary", text: "Take or choose a photo", onclick: () => { stopBarcodeScanner(); photo.click(); } }), el("button", { type: "button", class: "identify-back", text: "Back to product details", onclick: () => showForm(draft, { code: barcode, format: barcodeFormat }) }));
      try {
        barcodeScanner = new CameraScanner(video, async detection => {
          if (version !== screenVersion || detection.code === barcode) return;
          barcode = detection.code; barcodeFormat = detection.format;
          codeStatus.textContent = `Barcode saved: ${barcode}`;
          status.textContent = "Barcode found. Checking product details…";
          const result = await identifyBarcode(detection.code, settings);
          if (version !== screenVersion) return;
          if (result.match) draft = { ...draft, ...result.match };
          status.textContent = "Now show the front label and tap Read name and brand.";
        }, state => { if (version === screenVersion && (state === "native" || state === "fallback")) { capture.disabled = false; status.textContent = "Keep the product name and brand clearly visible when taking the picture."; } });
        await barcodeScanner.start({ forceFallback: settings.forceFallback });
      } catch (error) {
        status.textContent = error.name === "NotAllowedError" ? "Camera permission was denied. Go back and type the product details." : error.message;
      }
    };

    const showForm = (product = {}, scanned = { code: barcode, format: barcodeFormat }) => {
      screenVersion++;
      stopBarcodeScanner();
      barcode = scanned.code; barcodeFormat = scanned.format;
      draft = product;
      const form = el("form", { class: "identify-form" });
      const name = el("input", { value: product.name ?? "", required: "", maxlength: "140", autocomplete: "off", placeholder: "e.g. Tesco British Whole Milk" });
      const brand = el("input", { value: product.brand ?? "", maxlength: "80", autocomplete: "organization", placeholder: "e.g. Tesco" });
      const price = el("input", { value: product.price ?? "", type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "Optional" });
      const size = el("input", { value: product.size ?? "", maxlength: "60", placeholder: "e.g. 4 pints" });
      const category = el("input", { value: product.category ?? "", maxlength: "80", placeholder: "Optional" });
      const scannedCode = el("input", { value: scanned.code ?? "", readonly: "", placeholder: "No barcode scanned" });
      const scanBarcode = el("button", { type: "button", class: "secondary", text: "Scan barcode / fill with AI", onclick: () => showBarcodeScanner({ ...product, name: name.value, brand: brand.value, price: price.value === "" ? null : Number(price.value), size: size.value, category: category.value }) });
      const submit = el("button", { type: "submit", class: "primary", text: "Confirm and add item" });
      form.append(el("p", { class: "confirm-kicker", text: product.name ? "PRODUCT DETAILS" : "MANUAL PRODUCT" }), el("h1", { id: "identify-title", text: product.name ? "Check these details" : "Tell us what it is" }), el("p", { class: "confirm-message", text: "Scan the barcode if it has one, then check or enter the details." }), el("div", { class: "identify-barcode-row" }, [field("Barcode (optional)", scannedCode), scanBarcode]), field("Product name", name), el("div", { class: "identify-grid" }, [field("Brand", brand), field("Price (£, optional)", price)]), el("div", { class: "identify-grid" }, [field("Quantity / size", size), field("Category (optional)", category)]), submit, el("button", { type: "button", class: "identify-back", text: "Back to options", onclick: showOptions }));
      form.addEventListener("submit", event => { event.preventDefault(); finish({ name: name.value.trim(), brand: brand.value.trim() || null, price: price.value === "" ? null : Number(price.value), currency: "GBP", size: size.value.trim() || null, category: category.value.trim() || null, imageUrl: product.imageUrl ?? null, source: product.source ?? "Manual entry", barcode: scanned.code ?? null, barcodeFormat: scanned.format ?? null }); });
      panel.replaceChildren(form); requestAnimationFrame(() => name.focus());
    };

    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
    showOptions(); dialog.showModal(); requestAnimationFrame(() => dialog.classList.add("is-visible"));
  });
}
