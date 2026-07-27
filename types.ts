export type Item = {
  name: string;
  hsn: string;
  qty: number;
  uom: string;
  price: number | null; // null for lump-sum charges (no qty x price)
  net: number;
  taxRate: string;
  gst: number;
  gross: number;
  uploaded: boolean;
};

export type Charge = { label: string; amount: number };

export type Bill = {
  id: number;
  vendor: string;
  vendorGst: string;
  invoice: string;
  date: string; // short e.g. "16 Jun"
  dateFull: string; // e.g. "16-Jun-2026"
  buyer: string;
  buyerGst: string;
  taxable: number;
  gstTotal: number;
  roundOff: number;
  grandTotal: number;
  otherCharges: Charge[];
  note?: string;
  scanUrl?: string;
  items: Item[];
  voided: boolean;
};

export type CheckStatus = "pass" | "fail" | "na";
export type CheckResult = { key: string; status: CheckStatus; label: string; detail: string };
export type Validation = { checks: CheckResult[]; status: "OK" | "ERROR" };
