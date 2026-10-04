import { mapNativeFormat, mapZxingFormat, normalizeBarcode } from "./barcode.js";

const REQUIRED_NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

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
  constructor(video, onCode, onState) {
    this.video = video; this.onCode = onCode; this.onState = onState;
    this.gate = new RepeatGate(); this.running = false; this.inFlight = false; this.timer = null; this.lastVisible = [];
    this.pauseReasons = new Set();
  }
  get paused() { return this.pauseReasons.size > 0; }
  setPaused(reason, paused) { if (paused) this.pauseReasons.add(reason); else this.pauseReasons.delete(reason); }
  async start({ forceFallback = false } = {}) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs HTTPS (or localhost on this phone).");
    this.stopped = false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    // stop() may have been called while the camera was opening; release it instead of starting a loop nobody owns.
    if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream; this.video.srcObject = stream; await this.video.play();
    if (this.stopped) return;
    this.running = true;
    this.detector = null;
    if (!forceFallback && "BarcodeDetector" in window) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats();
        if (REQUIRED_NATIVE_FORMATS.every(format => supported.includes(format))) this.detector = new BarcodeDetector({ formats: REQUIRED_NATIVE_FORMATS });
      } catch { this.detector = null; }
    }
    if (!this.detector) await this.prepareFallback();
    if (this.stopped) return;
    this.onState?.(this.detector ? "native" : "fallback");
    this.loop();
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
    this.timer = setTimeout(async () => {
      if (!this.running || this.inFlight || this.paused) return this.loop();
      this.inFlight = true;
      try {
        const detections = await this.decode();
        if (this.paused) return;
        const valid = [];
        for (const detection of detections) {
          try { valid.push({ ...detection, code: normalizeBarcode(detection.rawValue, detection.format) }); } catch { /* ignore non-retail results */ }
        }
        valid.sort((a, b) => this.distanceFromAim(a) - this.distanceFromAim(b));
        const selected = valid.slice(0, 1);
        this.lastVisible = selected.map(item => item.code);
        const accepted = this.gate.observe(this.lastVisible);
        if (accepted[0] && !this.paused) await this.onCode(selected.find(item => item.code === accepted[0]));
      } catch (error) {
        if (this.detector) {
          try { this.detector = null; await this.prepareFallback(); this.onState?.("fallback"); }
          catch (fallbackError) { this.onState?.("decode-error", fallbackError); }
        } else this.onState?.("decode-error", error);
      }
      finally { this.inFlight = false; this.loop(); }
    }, 140);
  }
  modeChanged() { this.gate.reset({ requireRemoval: this.lastVisible }); }
  stop() { this.stopped = true; this.running = false; clearTimeout(this.timer); this.stream?.getTracks().forEach(track => track.stop()); this.video.srcObject = null; }
}
