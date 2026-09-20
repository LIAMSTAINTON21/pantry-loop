import { replayStock } from "./inventory.js";

export function daysBetween(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export function addDays(date, amount) {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d + amount));
  return value.toISOString().slice(0, 10);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function iqr(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted.slice(0, middle);
  const upper = sorted.slice(sorted.length % 2 ? middle + 1 : middle);
  return median(upper) - median(lower);
}

function confidenceFor(gaps, typical, variableQty) {
  if (variableQty) return "low";
  const spread = iqr(gaps);
  if (gaps.length >= 5 && spread <= .4 * typical) return "high";
  if (gaps.length >= 3 && spread <= typical) return "medium";
  return "low";
}

function purchaseOccasions(barcode, purchases, today) {
  const byDay = new Map();
  for (const event of purchases) {
    if (event.barcode !== barcode || event.voidedAt || event.source === "opening_stock" || event.purchasedOn > today) continue;
    byDay.set(event.purchasedOn, (byDay.get(event.purchasedOn) ?? 0) + event.qty);
  }
  return [...byDay].map(([date, qty]) => ({ date, qty })).sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
}

export function generateList(products, purchases, depletions, today, settings = {}) {
  const horizon = Number.isInteger(settings.planningHorizonDays) ? settings.planningHorizonDays : 7;
  const categoryOrder = settings.categoryOrder ?? [];
  const rank = new Map(categoryOrder.map((category, index) => [category, index]));
  const items = [];

  for (const product of products) {
    if (product.neverSuggest || (product.snoozeUntil && product.snoozeUntil > today)) continue;
    const stock = replayStock(product.barcode, purchases, depletions);
    const additions = purchases.filter(event => event.barcode === product.barcode && !event.voidedAt && event.purchasedOn <= today);
    const lastAddedDay = additions.map(event => event.purchasedOn).sort().at(-1) ?? null;
    const recentAddition = lastAddedDay && daysBetween(lastAddedDay, today) >= 0 && daysBetween(lastAddedDay, today) < 2;
    const reasons = [];

    if (stock.status === "finished") reasons.push({ rule: "A", label: "Ran out", confidence: "high" });

    if (!recentAddition && product.isStaple) {
      const period = Number.isInteger(product.staplePeriodDays) && product.staplePeriodDays > 0 ? product.staplePeriodDays : 7;
      if (!lastAddedDay || daysBetween(lastAddedDay, today) >= Math.max(0, period - 1)) {
        reasons.push({ rule: "B", label: `Scheduled staple · every ${period} days`, confidence: "high" });
      }
    }

    if (!recentAddition) {
      const occasions = purchaseOccasions(product.barcode, purchases, today);
      if (occasions.length >= 3) {
        const gaps = occasions.slice(1).map((occasion, index) => daysBetween(occasions[index].date, occasion.date)).filter(gap => gap > 0);
        if (gaps.length >= 2) {
          const typical = median(gaps);
          const due = addDays(occasions.at(-1).date, Math.ceil(typical));
          if (due <= addDays(today, horizon)) {
            const variableQty = new Set(occasions.map(item => item.qty)).size > 1;
            reasons.push({ rule: "C", label: `Usually bought every ~${typical} days`, confidence: confidenceFor(gaps, typical, variableQty), note: variableQty ? "Amounts bought vary · check stock" : null });
          }
        }
      }
    }

    if (!reasons.length) continue;
    const primary = reasons.slice().sort((a, b) => a.rule.localeCompare(b.rule))[0];
    items.push({
      barcode: product.barcode,
      name: product.name,
      size: product.size,
      category: product.category,
      qty: product.defaultQty || 1,
      onHandQty: stock.onHandQty,
      reasons,
      primaryReason: primary.label,
      confidence: primary.confidence,
      section: reasons.some(reason => reason.rule === "A") ? "ran_out" : "other"
    });
  }

  const confidenceRank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => {
    if (a.section !== b.section) return a.section === "ran_out" ? -1 : 1;
    const ar = a.category ? (rank.get(a.category) ?? categoryOrder.length) : 9999;
    const br = b.category ? (rank.get(b.category) ?? categoryOrder.length) : 9999;
    return ar - br || String(a.category ?? "").localeCompare(String(b.category ?? "")) || confidenceRank[a.confidence] - confidenceRank[b.confidence] || a.name.localeCompare(b.name) || a.barcode.localeCompare(b.barcode);
  });
}
