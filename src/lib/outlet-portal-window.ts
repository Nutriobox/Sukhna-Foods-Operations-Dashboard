// 2026-10-30 (Satvik's #4): shared helper that answers "is this outlet's
// 2-hour submission window currently open?" for the outlet-portal routes.
// The window is anchored on the LATEST ideal_inventory_snapshots row for
// this outlet; submission_window_opens_at / submission_window_closes_at
// are stamped server-side when the admin saves a snapshot (see
// src/app/api/ideal-inventory/route.ts POST handler).
//
// Returns one of three states, so callers can produce the right message:
//   • "open"       — portal accepts the submission; carries closes_at so
//                    the UI can render a countdown
//   • "closed"     — a snapshot exists but window has elapsed
//   • "none"       — no snapshot has ever been saved for this outlet, so
//                    there is nothing for the outlet to submit against
//
// Backwards compatibility: an older snapshot without the two timestamp
// columns is treated as "open" (null closes_at), so pre-2026-10-30
// snapshots don't accidentally lock outlets out before the admin has a
// chance to create a new one.

type Status = "open" | "closed" | "none";

export type WindowState = {
  status: Status;
  snapshot_id?: string;
  opens_at?: string | null;
  closes_at?: string | null;
  closes_in_ms?: number | null; // positive when open, negative when closed
  outlet: string;
};

export async function fetchWindowState(
  sbUrl: string,
  sbKey: string,
  outlet: string
): Promise<WindowState> {
  const q =
    `${sbUrl.replace(/\/$/, "")}/rest/v1/ideal_inventory_snapshots` +
    `?outlet=eq.${encodeURIComponent(outlet)}` +
    `&select=id,created_at,submission_window_opens_at,submission_window_closes_at` +
    `&order=created_at.desc&limit=1`;
  try {
    const r = await fetch(q, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return { status: "none", outlet };
    const rows = (await r.json()) as Array<{
      id: string;
      created_at: string | null;
      submission_window_opens_at: string | null;
      submission_window_closes_at: string | null;
    }>;
    const row = rows[0];
    if (!row) return { status: "none", outlet };
    // The window is exactly the 2 hours after the snapshot was saved. New
    // saves stamp submission_window_closes_at; for an older snapshot that
    // predates those columns, derive it from created_at + 2h so it still
    // closes on time instead of staying open forever.
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    let closes = row.submission_window_closes_at
      ? new Date(row.submission_window_closes_at).getTime()
      : null;
    let closesIso = row.submission_window_closes_at;
    let opensIso = row.submission_window_opens_at ?? row.created_at ?? null;
    if (closes == null && row.created_at) {
      const createdMs = new Date(row.created_at).getTime();
      if (!Number.isNaN(createdMs)) {
        closes = createdMs + TWO_HOURS_MS;
        closesIso = new Date(closes).toISOString();
      }
    }
    if (closes == null || Number.isNaN(closes)) {
      // No way to establish a window — closed (never open indefinitely).
      return { status: "closed", snapshot_id: row.id, opens_at: opensIso, closes_at: null, closes_in_ms: null, outlet };
    }
    const nowMs = Date.now();
    const closesInMs = closes - nowMs;
    return {
      status: closesInMs > 0 ? "open" : "closed",
      snapshot_id: row.id,
      opens_at: opensIso,
      closes_at: closesIso,
      closes_in_ms: closesInMs,
      outlet,
    };
  } catch {
    return { status: "none", outlet };
  }
}

/** Fatal-ish variant for the two portal submit routes: returns null when
 *  the submission should go through, or a NextResponse-ready payload +
 *  status when it should be refused. */
export function windowRefusal(state: WindowState): { status: number; body: { ok: false; error: string } } | null {
  if (state.status === "open") return null;
  if (state.status === "none") {
    return {
      status: 403,
      body: {
        ok: false,
        error:
          "No Ideal Inventory snapshot has been saved for this outlet yet. Ask your supervisor to save one before you submit.",
      },
    };
  }
  // closed
  return {
    status: 403,
    body: {
      ok: false,
      error:
        "The 2-hour submission window for this snapshot has closed. Ask your supervisor to save a new Ideal Inventory snapshot and try again.",
    },
  };
}
