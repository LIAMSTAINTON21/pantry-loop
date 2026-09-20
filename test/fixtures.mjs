export const product = (barcode = "4006381333931", patch = {}) => ({
  barcode, barcodeFormat: "ean_13", name: `Product ${barcode}`, brand: null, size: null, category: null,
  userEditedFields: [], lookup: { state: "manual", source: null, checkedAt: null, nextRetryAt: null },
  onHandQty: null, status: "unknown", isStaple: false, staplePeriodDays: null, defaultQty: 1,
  snoozeUntil: null, neverSuggest: false, createdAt: "2026-01-01T00:00:00.000Z", ...patch
});

export const purchase = (id, seq, barcode, purchasedOn, qty = 1, patch = {}) => ({
  id, seq, barcode, qty, purchasedAt: `${purchasedOn}T12:00:00.000Z`, purchasedOn, source: "scan",
  sessionId: "session", listId: null, voidedAt: null, replacesId: null, ...patch
});

export const depletion = (id, seq, barcode, finishedAt, qty = 1, patch = {}) => ({
  id, seq, barcode, qty, finishedAt, sessionId: "session", voidedAt: null, replacesId: null, ...patch
});
