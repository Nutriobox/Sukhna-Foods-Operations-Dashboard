import type { Bill, Validation, CheckResult } from "./types";
import { inr } from "./format";

// The buyer this dashboard reconciles every bill against.
export const BUYER_GST =
  process.env.NEXT_PUBLIC_BUYER_GST || "09AANCA9064A1ZL";
export const BUYER_NAME =
  process.env.NEXT_PUBLIC_BUYER_NAME || "Allsure Services Pvt Ltd";

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

/**
 * The three offline checks — pure arithmetic + string match.
 * No AI, no network. This is the same logic the whole workflow relies on.
 *
 *  1. Item math   — every line: Net = Qty x Price
 *  2. Buyer       — billed to the configured buyer AND matching GSTIN
 *  3. Totals      — sum(item Net) = Taxable, sum(item GST) = Total GST,
 *                   and Grand Total = Taxable + GST + printed round-off
 */
export function validate(b: Bill): Validation {
  const checks: CheckResult[] = [];

  // ---- Check 1: item math ----
  const priced = b.items.filter((i) => i.price !== null);
  if (priced.length === 0) {
    checks.push({
      key: "item",
      status: "na",
      label: "Item math — N/A",
      detail: "Lump-sum charge; the bill has no qty × price to verify.",
    });
  } else {
    const bad = priced.filter((i) => !near(i.qty * (i.price as number), i.net, 0.5));
    if (bad.length) {
      checks.push({
        key: "item",
        status: "fail",
        label: "Item math",
        detail: bad
          .map((i) => `${i.name}: ${i.qty} × ${i.price} ≠ ${inr(i.net)}`)
          .join("; "),
      });
    } else {
      checks.push({
        key: "item",
        status: "pass",
        label: "Item math",
        detail: "Every line: Qty × Price = Net Amount.",
      });
    }
  }

  // ---- Check 2: buyer ----
  const buyerOk =
    b.buyerGst.trim().toUpperCase() === BUYER_GST.toUpperCase() &&
    /allsure/i.test(b.buyer);
  checks.push(
    buyerOk
      ? {
          key: "buyer",
          status: "pass",
          label: "Buyer = " + BUYER_NAME.split(" ")[0],
          detail: `Billed to ${BUYER_NAME} · GSTIN ${BUYER_GST}`,
        }
      : {
          key: "buyer",
          status: "fail",
          label: "Buyer mismatch",
          detail: `Expected ${BUYER_NAME} · ${BUYER_GST}. Found: ${b.buyer} · ${b.buyerGst}`,
        }
  );

  // ---- Check 3: totals reconcile ----
  const sumNet = b.items.reduce((s, i) => s + i.net, 0);
  const sumGst = b.items.reduce((s, i) => s + i.gst, 0);
  const okNet = near(sumNet, b.taxable, 1);
  const okGst = near(sumGst, b.gstTotal, 1);
  const okGrand = near(b.taxable + b.gstTotal + b.roundOff, b.grandTotal, 1);
  if (okNet && okGst && okGrand) {
    checks.push({
      key: "totals",
      status: "pass",
      label: "Totals reconcile",
      detail: `Net ${inr(sumNet)} + GST ${inr(sumGst)}${
        b.roundOff ? " + round " + inr(b.roundOff) : ""
      } = ${inr(b.grandTotal)}`,
    });
  } else {
    let detail = `Line items ${inr(sumNet)} + GST ${inr(sumGst)} = ${inr(
      sumNet + sumGst
    )}, but Grand Total is ${inr(b.grandTotal)}.`;
    if (b.otherCharges?.length) {
      detail +=
        " Difference includes " +
        b.otherCharges.map((c) => `${c.label} ${inr(c.amount)}`).join(", ") +
        " + round-off — an out-of-line-item charge that needs approval.";
    }
    checks.push({ key: "totals", status: "fail", label: "Totals do NOT reconcile", detail });
  }

  const status = checks.some((c) => c.status === "fail") ? "ERROR" : "OK";
  return { checks, status };
}

export const allUploaded = (b: Bill) => b.items.every((i) => i.uploaded);
export const canUpload = (b: Bill) => validate(b).status === "OK" && !b.voided;
