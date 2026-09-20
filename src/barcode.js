const FORMATS = new Set(["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "manual"]);

export function validGtin(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, position = 1; i >= 0; i--, position++) {
    sum += digits[i] * (position % 2 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function expandUpce(value) {
  const raw = String(value).trim();
  if (!/^\d{8}$/.test(raw)) throw new Error("UPC-E must contain 8 digits");
  const ns = raw[0];
  if (ns !== "0" && ns !== "1") throw new Error("Unsupported UPC-E number system");
  const d = raw.slice(1, 7);
  let body;
  if (/[012]/.test(d[5])) body = `${ns}${d.slice(0, 2)}${d[5]}0000${d.slice(2, 5)}`;
  else if (d[5] === "3") body = `${ns}${d.slice(0, 3)}00000${d.slice(3, 5)}`;
  else if (d[5] === "4") body = `${ns}${d.slice(0, 4)}00000${d[4]}`;
  else body = `${ns}${d.slice(0, 5)}0000${d[5]}`;
  return body + raw[7];
}

export function normalizeBarcode(value, format) {
  const raw = String(value ?? "").trim();
  const canonicalFormat = String(format ?? "").toLowerCase();
  if (!FORMATS.has(canonicalFormat)) throw new Error("Unsupported barcode format");
  if (canonicalFormat === "manual") {
    if (!raw) throw new Error("Manual products need an ID");
    return raw.startsWith("manual:") ? raw : `manual:${raw}`;
  }
  if (canonicalFormat === "code_128") {
    if (!raw || raw.length > 180) throw new Error("Invalid Code 128 value");
    return `code128:${raw}`;
  }
  let gtin = raw;
  if (canonicalFormat === "upc_e") gtin = expandUpce(raw);
  if (canonicalFormat === "upc_a" || canonicalFormat === "upc_e") gtin = `0${gtin}`;
  const expected = canonicalFormat === "ean_8" ? 8 : 13;
  if (!/^\d+$/.test(gtin) || gtin.length !== expected || !validGtin(gtin)) {
    throw new Error(`Invalid ${canonicalFormat.replace("_", " ").toUpperCase()} code`);
  }
  return gtin;
}

export function mapNativeFormat(format) {
  return ({ ean_13: "ean_13", ean_8: "ean_8", upc_a: "upc_a", upc_e: "upc_e", code_128: "code_128" })[String(format).toLowerCase()] ?? null;
}

export function mapZxingFormat(format) {
  return ({ EAN13: "ean_13", "EAN-13": "ean_13", EAN8: "ean_8", "EAN-8": "ean_8", UPCA: "upc_a", "UPC-A": "upc_a", UPCE: "upc_e", "UPC-E": "upc_e", Code128: "code_128", "Code 128": "code_128" })[format] ?? null;
}

export function canLookup(barcode) {
  return /^\d{8}$|^\d{13}$/.test(barcode);
}
