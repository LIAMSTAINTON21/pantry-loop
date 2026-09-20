function eventOrder(a, b) {
  return a.seq - b.seq || String(a.id).localeCompare(String(b.id));
}

export function activeEvents(purchases = [], depletions = []) {
  return [
    ...purchases.map(event => ({ ...event, kind: "purchase" })),
    ...depletions.map(event => ({ ...event, kind: "depletion" }))
  ].filter(event => !event.voidedAt).sort(eventOrder);
}

export function replayStock(barcode, purchases = [], depletions = []) {
  const events = activeEvents(purchases, depletions).filter(event => event.barcode === barcode);
  if (!events.length) return { onHandQty: null, status: "unknown", lastEvent: null };
  let quantity = 0;
  let lastEvent = null;
  for (const event of events) {
    quantity = event.kind === "purchase" ? quantity + event.qty : Math.max(0, quantity - event.qty);
    lastEvent = event;
  }
  return {
    onHandQty: quantity,
    status: quantity > 0 ? "in_stock" : (lastEvent?.kind === "depletion" ? "finished" : "unknown"),
    lastEvent
  };
}

export function recomputeProducts(products, purchases, depletions) {
  return products.map(product => ({ ...product, ...replayStock(product.barcode, purchases, depletions) }));
}
