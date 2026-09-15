import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { hasAccess } from "./access";
import Auth from "./Auth";
import DayOffPayPlanner from "./DayOffPayPlanner";

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = not checked yet, null = signed out
  const [profile, setProfile] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

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
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          style={{ padding: "8px 16px", fontSize: 13, cursor: "pointer" }}
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 8,
          right: 8,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(0,0,0,0.75)",
          color: "#fff",
          padding: "4px 8px",
          borderRadius: 6,
          fontSize: 11,
          fontFamily: "sans-serif",
        }}
      >
        <span>{session.user.email}</span>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          style={{
            background: "#fff",
            border: "none",
            borderRadius: 4,
            padding: "3px 8px",
            fontSize: 11,
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
