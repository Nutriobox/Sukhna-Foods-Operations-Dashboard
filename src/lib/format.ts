// Indian-format currency, e.g. 135181 -> "1,35,181.00"
export function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n ?? 0);
}

// Compact for KPI, e.g. 452195 -> "₹4.52L"
export function inrShort(n: number): string {
  if (n >= 1e7) return "₹" + (n / 1e7).toFixed(2) + "Cr";
  if (n >= 1e5) return "₹" + (n / 1e5).toFixed(2) + "L";
  if (n >= 1e3) return "₹" + (n / 1e3).toFixed(1) + "K";
  return "₹" + n.toFixed(0);
}

// display a number that may be an integer count, keeping decimals when present
export function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}
