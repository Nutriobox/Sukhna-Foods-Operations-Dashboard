"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Row = Record<string, any>;

export default function VehicleMovementPage() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  // Load the list of available run dates once.
  useEffect(() => {
    (async () => {
      if (!supabase) { setLoading(false); return; }
      const { data } = await supabase
        .from("vehicle_movement")
        .select("run_date")
        .order("run_date", { ascending: false });
      const uniq = Array.from(new Set((data || []).map((r: Row) => r.run_date as string)));
      setDates(uniq);
      if (uniq.length) setDate(uniq[0]); // default to the newest
      else setLoading(false);
    })();
  }, []);

  // Load rows whenever the selected date changes.
  useEffect(() => {
    if (!supabase || !date) return;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from("vehicle_movement")
        .select("*")
        .eq("run_date", date)
        .order("sr_no");
      setRows(data || []);
      setLoading(false);
    })();
  }, [date]);

  const fmt = (d: string) => {
    try {
      return new Date(d + "T00:00:00").toLocaleDateString("en-GB", {
        weekday: "short", day: "numeric", month: "short", year: "numeric",
      });
    } catch { return d; }
  };

  const H = ["#","Vehicle","Start","Finish","Dispatch","+30m","+1h","+1.5h","+2h","Outlet Reached","Travel","At Outlet","Remarks"];
  const cell: React.CSSProperties = { border: "1px solid #e2e8f0", padding: "6px 8px", fontSize: 13, textAlign: "left", whiteSpace: "nowrap" };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Vehicle Movement Monitoring</h1>
          <div style={{ color: "#64748b" }}>{date ? fmt(date) : ""}</div>
        </div>
        {dates.length > 0 && (
          <label style={{ fontSize: 14, color: "#334155", display: "flex", alignItems: "center", gap: 8 }}>
            Date:
            <select
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ font: "inherit", padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", cursor: "pointer" }}
            >
              {dates.map((d) => <option key={d} value={d}>{fmt(d)}</option>)}
            </select>
          </label>
        )}
      </div>
      {loading ? <p>Loading…</p>
        : !supabase ? <p>Supabase not configured.</p>
        : rows.length === 0 ? <p>No trips found for this date.</p>
        : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse" }}>
              <thead><tr>{H.map((h) => <th key={h} style={{ ...cell, background: "#f1f5f9", fontWeight: 600 }}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={cell}>{r.sr_no}</td>
                    <td style={cell}>{r.vehicle}</td>
                    <td style={cell}>{r.start_dest}</td>
                    <td style={cell}>{r.finish_dest}</td>
                    <td style={cell}>{r.dispatch_time}</td>
                    <td style={cell}>{r.loc_30}</td>
                    <td style={cell}>{r.loc_60}</td>
                    <td style={cell}>{r.loc_90}</td>
                    <td style={cell}>{r.loc_120}</td>
                    <td style={cell}>{r.outlet_reached}</td>
                    <td style={cell}>{r.total_travel}</td>
                    <td style={cell}>{r.time_at_outlet}</td>
                    <td style={cell}>{r.remarks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
