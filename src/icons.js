const SVG = "http://www.w3.org/2000/svg";

// Single outline family: 24px grid, 2px round strokes. Paths only, so they inherit currentColor.
const PATHS = {
  food: ["M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"],
  scan: ["M4 8V6a2 2 0 0 1 2-2h2", "M16 4h2a2 2 0 0 1 2 2v2", "M20 16v2a2 2 0 0 1-2 2h-2", "M8 20H6a2 2 0 0 1-2-2v-2", "M8 8v8", "M11 8v8", "M14 8v8", "M17 8v8"],
  stock: ["M21 8 12 3 3 8v8l9 5 9-5Z", "M3 8l9 5 9-5", "M12 13v8"],
  list: ["M10 6h11", "M10 12h11", "M10 18h11", "m3 6 1.5 1.5L7 5", "m3 12 1.5 1.5L7 11", "m3 18 1.5 1.5L7 17"],
  catalogue: ["M4 4h6v6H4Z", "M14 4h6v6h-6Z", "M4 14h6v6H4Z", "M14 14h6v6h-6Z"],
  settings: ["M4 6h10", "M18 6h2", "M4 12h4", "M12 12h8", "M4 18h12", "M20 18h0", "M16 4v4", "M10 10v4", "M18 16v4"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z", "m20 20-3.5-3.5"],
  chevron: ["m9 6 6 6-6 6"],
  camera: ["M4 8h3l2-3h6l2 3h3v11H4Z", "M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"],
  keyboard: ["M3 6h18v12H3Z", "M7 10h.01", "M11 10h.01", "M15 10h.01", "M7 14h10"],
  sparkle: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "m6 6 2.5 2.5", "m15.5 15.5 2.5 2.5", "m18 6-2.5 2.5", "m8.5 15.5-2.5 2.5"],
  cart: ["M3 4h2l2.4 11h10.8L20 7H6.2", "M9 20h.01", "M17 20h.01"]
};

export function icon(name, { size = 24, label = null } = {}) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", size); svg.setAttribute("height", size);
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("class", "icon");
  if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); } else svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name] ?? []) { const path = document.createElementNS(SVG, "path"); path.setAttribute("d", d); svg.append(path); }
  return svg;
}
