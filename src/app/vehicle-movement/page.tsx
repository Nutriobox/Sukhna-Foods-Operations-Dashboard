"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Row = Record<string, any>;

export default function VehicleMovementPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [date, setDate] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!supabase) { setLoading(false); return; }
      const { data: latest } = await supabase
        .from("vehicle_movement").select("run_date")
        .order("run_date", { ascending: false }).limit(1);
      const d = latest?.[0]?.run_date as string | undefined;
      if (d) {
        setDate(d);
        const { data } = await supabase
          .from("vehicle_movement").select("*")
          .eq("run_date", d).order("sr_no");
        setRows(data || []);
      }
      setLoading(false);
    })();
  }, []);

  const H = ["#","Vehicle","Start","Finish","Dispatch","+30m","+1h","+1.5h","+2h","Outlet Reached","Travel","At Outlet","Remarks"];
  const cell: React.CSSProperties = { border: "1px solid #e2e8f0", padding: "6px 8px", fontSize: 13, textAlign: "left", whiteSpace: "nowrap" };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Vehicle Movement Monitoring</h1>
      <div style={{ color: "#64748b", marginBottom: 16 }}>{date ? `Latest run: ${date}` : ""}</div>
      {loading ? <p>Loading…</p>
        : !supabase ? <p>Supabase not configured.</p>
        : rows.length === 0 ? <p>No trips found for the latest run.</p>
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
