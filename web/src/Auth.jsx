import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function Auth() {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setStatus("Check your email to confirm your account, then log in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setStatus(err.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function handleForgotPassword() {
    if (!email) { setStatus("Enter your email above first, then click “Forgot password”."); return; }
    setBusy(true);
    setStatus("");
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email);
      if (error) throw error;
      setStatus("Password reset email sent.");
    } catch (err) {
      setStatus(err.message || "Couldn't send reset email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 24 }}>SDO Schedule Planner</h1>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 8, fontSize: 14 }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          style={{ padding: 8, fontSize: 14 }}
        />
        <button type="submit" disabled={busy} style={{ padding: 10, fontSize: 14, cursor: "pointer" }}>
          {mode === "signup" ? "Sign up" : "Log in"}
        </button>
      </form>
      <div style={{ marginTop: 14, fontSize: 13, display: "flex", justifyContent: "space-between" }}>
        <button
          type="button"
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setStatus(""); }}
          style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0 }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
        </button>
        {mode === "login" && (
          <button
            type="button"
            onClick={handleForgotPassword}
            style={{ background: "none", border: "none", color: "#2563eb", cursor: "pointer", padding: 0 }}
          >
            Forgot password?
          </button>
        )}
      </div>
      {status && <p style={{ marginTop: 14, fontSize: 13, color: "#555" }}>{status}</p>}
      <p style={{ marginTop: 14, fontSize: 12, color: "#777", lineHeight: 1.5 }}>
        After you sign up, you'll get a confirmation email from an address with "supabase" in
        it — that's expected. Email confirmations are still a little rough around the edges: when
        you click the link, it's normal for the confirmation page itself to fail. Just go back to
        sdoscheduletool.com and log in with the email and password you just created.
      </p>
      <p style={{ marginTop: 28, fontSize: 12, color: "#777", lineHeight: 1.5, borderTop: "1px solid #eee", paddingTop: 16 }}>
        Your schedule data is private to your account — it's never shared with or sold to anyone,
        and no other user can see it. This tool is independent and not affiliated with PSA
        Airlines, American Airlines, or FLICA; it simply works with the schedule information you
        paste in yourself.
      </p>
    </div>
  );
}
