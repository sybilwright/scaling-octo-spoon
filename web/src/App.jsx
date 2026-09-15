import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { hasAccess } from "./access";
import Auth from "./Auth";
import DayOffPayPlanner from "./DayOffPayPlanner";

// A closed tab/browser can come back via "continue where you left off" with
// sessionStorage intact, so a genuine tab-close can't be detected reliably.
// Idle timeout is the dependable substitute: sign out after this long with
// no mouse/keyboard/touch/scroll activity, checked against a timestamp in
// localStorage so it also catches "closed the browser, reopened it later".
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const LAST_ACTIVITY_KEY = "doplan_last_activity";

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = not checked yet, null = signed out
  const [profile, setProfile] = useState(undefined);
  const [checkoutStatus, setCheckoutStatus] = useState("");

  async function handleSubscribe() {
    setCheckoutStatus("Starting checkout…");
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout-session");
      if (error) throw error;
      if (!data?.url) throw new Error("No checkout URL returned");
      window.location.href = data.url;
    } catch (err) {
      setCheckoutStatus(`Couldn't start checkout: ${err.message || err}`);
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;

    const recordActivity = () => localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));

    const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
    if (lastActivity && Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      supabase.auth.signOut();
      return;
    }
    recordActivity();

    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((event) => window.addEventListener(event, recordActivity));

    const interval = setInterval(() => {
      const last = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || 0);
      if (Date.now() - last > IDLE_TIMEOUT_MS) supabase.auth.signOut();
    }, 60 * 1000);

    return () => {
      events.forEach((event) => window.removeEventListener(event, recordActivity));
      clearInterval(interval);
    };
  }, [session]);

  useEffect(() => {
    if (!session?.user?.id) { setProfile(session === null ? null : undefined); return; }
    let cancelled = false;
    supabase
      .from("profiles")
      .select("subscription_status, trial_ends_at")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        setProfile(error ? null : data);
      });
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  if (session === undefined) return null; // still checking for an existing session

  if (!session) return <Auth />;

  if (profile === undefined) return null; // still loading the profile row

  if (!hasAccess(profile)) {
    return (
      <div style={{ maxWidth: 420, margin: "80px auto", fontFamily: "sans-serif", textAlign: "center" }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>Trial ended</h1>
        <p style={{ fontSize: 14, color: "#555", marginBottom: 20 }}>
          Your free access has ended. Subscribe to keep using the SDO Schedule Planner.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button
            type="button"
            onClick={handleSubscribe}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              cursor: "pointer",
              background: "#111",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              fontWeight: 500,
            }}
          >
            Subscribe
          </button>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            style={{ padding: "8px 16px", fontSize: 13, cursor: "pointer" }}
          >
            Log out
          </button>
        </div>
        {checkoutStatus && <p style={{ marginTop: 14, fontSize: 12, color: "#555" }}>{checkoutStatus}</p>}
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: "#1a1a1a",
          color: "#fff",
          padding: "10px 20px",
          fontFamily: "sans-serif",
          fontSize: 13,
        }}
      >
        <span>Signed in as <strong>{session.user.email}</strong></span>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          style={{
            background: "#fff",
            border: "none",
            borderRadius: 4,
            padding: "6px 14px",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Log out
        </button>
      </div>
      <DayOffPayPlanner session={session} />
    </>
  );
}
