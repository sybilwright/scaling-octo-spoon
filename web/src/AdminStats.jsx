import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMoney(n) {
  return (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function AdminStats({ onClose }) {
  const [rows, setRows] = useState(undefined); // undefined = loading
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("monthly_stats")
      .select("email, bid_year, bid_month, hourly_rate, confirmed_bonus_hours, confirmed_bonus_dollars, total_confirmed_credit_hours, updated_at")
      .order("bid_year", { ascending: false })
      .order("bid_month", { ascending: false })
      .order("email", { ascending: true })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message);
        else setRows(data);
      });
    return () => { cancelled = true; };
  }, []);

  const totalBonusDollars = (rows || []).reduce((sum, r) => sum + (r.confirmed_bonus_dollars || 0), 0);
  const totalBonusHours = (rows || []).reduce((sum, r) => sum + (r.confirmed_bonus_hours || 0), 0);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 10000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        overflowY: "auto",
      }}
    >
      <div style={{ background: "#fff", borderRadius: 8, padding: 24, maxWidth: 900, width: "100%", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Monthly bonus stats (all users)</h2>
          <button type="button" onClick={onClose} style={{ padding: "6px 12px", cursor: "pointer" }}>
            Close
          </button>
        </div>

        {rows === undefined && !error && <p style={{ fontSize: 13, color: "#555" }}>Loading…</p>}
        {error && <p style={{ fontSize: 13, color: "#b00" }}>Couldn't load stats: {error}</p>}

        {rows && rows.length === 0 && (
          <p style={{ fontSize: 13, color: "#555" }}>No data yet — this fills in as users save their schedule.</p>
        )}

        {rows && rows.length > 0 && (
          <>
            <p style={{ fontSize: 13, color: "#555", marginBottom: 12 }}>
              Across all rows below: <strong>{formatMoney(totalBonusDollars)}</strong> confirmed SDO bonus,{" "}
              <strong>{totalBonusHours.toFixed(2)}h</strong> confirmed bonus hours. Each row is a snapshot as of that
              user's last save for that bid month, not a running total.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                    <th style={{ padding: "6px 8px" }}>User</th>
                    <th style={{ padding: "6px 8px" }}>Bid month</th>
                    <th style={{ padding: "6px 8px" }}>Rate</th>
                    <th style={{ padding: "6px 8px" }}>Bonus hours</th>
                    <th style={{ padding: "6px 8px" }}>Bonus $</th>
                    <th style={{ padding: "6px 8px" }}>Total credit hrs</th>
                    <th style={{ padding: "6px 8px" }}>Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.email}-${r.bid_year}-${r.bid_month}`} style={{ borderBottom: "1px solid #eee" }}>
                      <td style={{ padding: "6px 8px" }}>{r.email}</td>
                      <td style={{ padding: "6px 8px" }}>{MONTH_NAMES[r.bid_month - 1]} {r.bid_year}</td>
                      <td style={{ padding: "6px 8px" }}>${Number(r.hourly_rate || 0).toFixed(2)}</td>
                      <td style={{ padding: "6px 8px" }}>{Number(r.confirmed_bonus_hours || 0).toFixed(2)}</td>
                      <td style={{ padding: "6px 8px" }}>{formatMoney(r.confirmed_bonus_dollars)}</td>
                      <td style={{ padding: "6px 8px" }}>{Number(r.total_confirmed_credit_hours || 0).toFixed(2)}</td>
                      <td style={{ padding: "6px 8px", color: "#777" }}>{new Date(r.updated_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
