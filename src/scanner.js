// Own the camera stream and turn repeated frame detections into one deliberate scan.
// Native decoding is preferred; the bundled decoder keeps scanning available offline.
import { mapNativeFormat, mapZxingFormat, normalizeBarcode } from "./barcode.js";

const REQUIRED_NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

// Check the actual preview, not scroll distance: responsive layouts, sticky bars
// and dialogs can all hide the camera without moving the document scroll offset.
export function isScannerVisible(video, doc = globalThis.document, win = globalThis.window) {
  if (!video?.isConnected || doc?.hidden || video.closest?.('[hidden], [inert]')) return false;
  const style = win.getComputedStyle?.(video);
  if (style && (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0)) return false;
  const rect = video.getBoundingClientRect();
  const viewport = win.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? win.innerWidth), bottom = top + (viewport?.height ?? win.innerHeight);
  const visibleWidth = Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));
  if (!rect.width || !rect.height || visibleWidth * visibleHeight / (rect.width * rect.height) < 0.65) return false;
  const modal = [...(doc.querySelectorAll?.('dialog[open]') ?? [])].at(-1);
  if (modal && !modal.contains(video)) return false;
  // Ignore the scanner's decorative aim overlay, but reject unrelated overlays.
  const frame = video.parentElement;
  let clear = 0;
  for (const x of [0.2, 0.5, 0.8]) for (const y of [0.2, 0.5, 0.8]) {
    const px = rect.left + rect.width * x, py = rect.top + rect.height * y;
    if (px < left || px > right || py < top || py > bottom) continue;
    const hit = doc.elementFromPoint?.(px, py);
    if (!doc.elementFromPoint || hit === video || (hit && frame?.contains(hit))) clear++;
  }
  return clear >= 6;
}

export class RepeatGate {
  constructor({ absenceMs = 700, absenceCount = 3, matchCount = 2 } = {}) {
    this.absenceMs = absenceMs;
    this.absenceCount = absenceCount;
    this.matchCount = matchCount;
    this.states = new Map();
  }
  reset({ requireRemoval = [] } = {}) {
    this.states.clear();
    for (const code of requireRemoval) this.states.set(code, { latched: true, absentSince: null, absentCount: 0, matches: 0 });
  }
  observe(codes, now = performance.now()) {
    // Two matching frames establish a code. It stays latched until several clear
    // frames over enough time prove that the user actually removed the package.
    const visible = new Set(codes);
    const accepted = [];
    for (const [code, state] of this.states) {
      if (visible.has(code)) {
        state.absentSince = null; state.absentCount = 0;
        if (!state.latched) {
          state.matches += 1;
          if (state.matches >= this.matchCount) { state.latched = true; state.matches = 0; accepted.push(code); }
        }
      } else {
        state.matches = 0;
        state.absentSince ??= now;
        state.absentCount += 1;
        if (state.latched && state.absentCount >= this.absenceCount && now - state.absentSince >= this.absenceMs) state.latched = false;
      }
    }
    for (const code of visible) {
      if (!this.states.has(code)) this.states.set(code, { latched: false, absentSince: null, absentCount: 0, matches: 1 });
      const state = this.states.get(code);
      if (!state.latched && state.matches >= this.matchCount) { state.latched = true; state.matches = 0; accepted.push(code); }
    }
    return accepted;
  }
}

export class CameraScanner {
  constructor(video, onCode, onState, gate = new RepeatGate()) {
    this.video = video; this.onCode = onCode; this.onState = onState;
    this.gate = gate; this.running = false; this.inFlight = false; this.timer = null; this.lastVisible = []; this.generation = 0;
    this.pauseReasons = new Set();
  }
  get paused() { return this.pauseReasons.size > 0; }
  setPaused(reason, paused) { if (paused) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason); }
  async start({ forceFallback = false } = {}) {
    // Every stop invalidates pending permission/decoder promises. A late camera
    // permission result releases its stream instead of reviving a closed view.
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs HTTPS (or localhost on this phone).");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    try {
    this.video.srcObject = this.stream; await this.video.play();
    if (generation !== this.generation) return;
    this.running = true;
    this.detector = null;
    if (!forceFallback && "BarcodeDetector" in window) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats();
        if (generation !== this.generation) return;
        if (REQUIRED_NATIVE_FORMATS.every(format => supported.includes(format))) this.detector = new BarcodeDetector({ formats: REQUIRED_NATIVE_FORMATS });
      } catch { this.detector = null; }
    }
    if (!this.detector) await this.prepareFallback();
    if (generation !== this.generation) return;
    this.onState?.(this.detector ? "native" : "fallback");
    this.loop();
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
  }
  captureImage() {
    const width = this.video.videoWidth, height = this.video.videoHeight;
    if (!width || !height) return null;
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.78);
    } catch { return null; }
  }
  async prepareFallback() {
    if (!globalThis.ZXingWASM) throw new Error("Offline scanner is unavailable");
    const wasmUrl = new URL("../vendor/zxing_reader-3.1.4.wasm", import.meta.url).href;
    await globalThis.ZXingWASM.prepareZXingModule({ overrides: { locateFile: path => path.endsWith(".wasm") ? wasmUrl : path } });
    this.canvas = document.createElement("canvas"); this.context = this.canvas.getContext("2d", { willReadFrequently: true });
  }
  async decode() {
    if (this.detector) {
      const results = await this.detector.detect(this.video);
      return results.map(result => ({ rawValue: result.rawValue, format: mapNativeFormat(result.format), points: result.cornerPoints ?? [] })).filter(result => result.format);
    }
    const width = this.video.videoWidth, height = this.video.videoHeight;
    if (!width || !height) return [];
    this.canvas.width = width; this.canvas.height = height; this.context.drawImage(this.video, 0, 0, width, height);
    const data = this.context.getImageData(0, 0, width, height);
    const results = await globalThis.ZXingWASM.readBarcodes(data, { formats: ["EAN13", "EAN8", "UPCA", "UPCE", "Code128"], tryHarder: true, maxNumberOfSymbols: 3 });
    return results.map(result => ({ rawValue: result.text, format: mapZxingFormat(result.format), points: result.position ? Object.values(result.position) : [] })).filter(result => result.format);
  }
  distanceFromAim(item) {
    const points = item.points?.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y)) ?? [];
    if (!points.length) return Number.MAX_SAFE_INTEGER;
    const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
    return Math.hypot(center.x - this.video.videoWidth / 2, center.y - this.video.videoHeight / 2);
  }
  loop() {
    if (!this.running) return;
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      if (generation !== this.generation || !this.running) return;
      if (this.inFlight || this.paused || !isScannerVisible(this.video)) return this.loop();
      this.inFlight = true;
      try {
        const detections = await this.decode();
        if (generation !== this.generation || !this.running || this.paused || !isScannerVisible(this.video)) return;
        const valid = [];
        for (const detection of detections) {
          try { valid.push({ ...detection, code: normalizeBarcode(detection.rawValue, detection.format) }); } catch { /* ignore non-retail results */ }
        }
        valid.sort((a, b) => this.distanceFromAim(a) - this.distanceFromAim(b));
        const selected = valid.slice(0, 1);
        this.lastVisible = selected.map(item => item.code);
        const accepted = this.gate.observe(this.lastVisible);
        if (accepted[0]) {
          // A lookup or save failure is not a decoder failure: preserve the decoder
          // and report the application error without silently switching engines.
          try { await this.onCode({ ...selected.find(item => item.code === accepted[0]), image: this.captureImage() }); }
          catch (error) { this.onState?.("accept-error", error); }
        }
      } catch (error) {
        if (generation !== this.generation || !this.running) return;
        if (this.detector) {
          try { this.detector = null; await this.prepareFallback(); if (generation === this.generation && this.running) this.onState?.("fallback"); }
          catch (fallbackError) { this.onState?.("decode-error", fallbackError); }
        } else this.onState?.("decode-error", error);
      }
      finally { if (generation === this.generation) { this.inFlight = false; this.loop(); } }
    }, 140);
  }
  modeChanged() { this.gate.reset({ requireRemoval: [...new Set([...this.lastVisible, ...[...this.gate.states].filter(([, state]) => state.latched).map(([code]) => code)])] }); }
  stop() { this.generation++; this.running = false; this.inFlight = false; clearTimeout(this.timer); this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; this.video.srcObject = null; }
}
