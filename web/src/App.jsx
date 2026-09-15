import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { hasAccess } from "./access";
import Auth from "./Auth";
import DayOffPayPlanner from "./DayOffPayPlanner";

// Every login is now a fresh, deliberate action (supabaseClient.js uses
// persistSession: false, so nothing survives a page reload) -- this only
// needs to catch a tab left open and untouched for a while, not a restored
// browser session. Sign out after this long with no mouse/keyboard/touch/
// scroll activity SINCE THIS LOGIN, not since some earlier session -- a
// leftover timestamp from a previous login must never be checked against a
// fresh one, or every login would immediately look "already idle" and sign
// straight back out.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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

    // In-memory only, starts fresh every time this effect runs (i.e. every
    // new login) -- never persisted, so there's no stale value to compare
    // a brand-new session against.
    let lastActivity = Date.now();
    const recordActivity = () => { lastActivity = Date.now(); };

    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((event) => window.addEventListener(event, recordActivity));

    const interval = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) supabase.auth.signOut();
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
