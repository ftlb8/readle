import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useStore } from "./store";
import { VoicePicker } from "./VoicePicker";

type Source = { key: string; name: string; kind: "publication" | "curator"; active: boolean; language: string };

function back() {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = "#/suggestions";
}

/** Admin only: the description that steers the weekly suggestions, and which sources are used. */
export function CurationSettings() {
  const { isAdmin } = useStore();
  const [profile, setProfile] = useState("");
  const [savedProfile, setSavedProfile] = useState("");
  const [sources, setSources] = useState<Source[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    supabase.rpc("curation_admin_get").then(({ data, error }) => {
      if (error) return setError(error.message);
      setProfile(data.profile ?? "");
      setSavedProfile(data.profile ?? "");
      setSources(data.sources ?? []);
    });
  }, []);

  async function saveProfile() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const { error } = await supabase.rpc("curation_admin_set_profile", { p_profile: profile });
    setBusy(false);
    if (error) return setError(error.message);
    setSavedProfile(profile);
    setMessage("Saved. It applies from the next weekly selection.");
  }

  async function toggle(source: Source) {
    const active = !source.active;
    setSources((list) => list!.map((s) => (s.key === source.key ? { ...s, active } : s)));
    const { error } = await supabase.rpc("curation_admin_set_source", { p_key: source.key, p_active: active });
    if (error) {
      setError(error.message);
      setSources((list) => list!.map((s) => (s.key === source.key ? { ...s, active: !active } : s)));
    }
  }

  if (!isAdmin) {
    return (
      <main className="page">
        <p className="empty muted">Only the person who runs the suggestions can change these settings.</p>
      </main>
    );
  }

  const group = (kind: Source["kind"]) => (sources ?? []).filter((s) => s.kind === kind);

  return (
    <main className="page">
      <header className="topbar">
        <button className="link" onClick={back}>
          ← Back
        </button>
      </header>
      <h1 className="page-title">Settings</h1>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="settings-block">
        <h2>What you want to read</h2>
        <p className="muted">
          Written in your own words. Say what you want more of, what bores you, and anything you have noticed in
          recent suggestions that you would like changed.
        </p>
        <textarea
          aria-label="Your interests"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          rows={16}
          disabled={sources === null}
        />
        <div className="sheet-actions">
          {message && <span className="muted">{message}</span>}
          <button className="primary" disabled={busy || profile === savedProfile || profile.trim().length < 20} onClick={saveProfile}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      <VoicePicker />

      {sources === null && !error && <p className="center muted">Loading…</p>}

      {(["publication", "curator"] as const).map(
        (kind) =>
          group(kind).length > 0 && (
            <section key={kind} className="settings-block">
              <h2>{kind === "publication" ? "Publications" : "Curators"}</h2>
              <p className="muted">
                {kind === "publication"
                  ? "Their own new articles are considered each week."
                  : "The articles they recommend are considered each week."}{" "}
                Untick one to leave it out from the next selection on.
              </p>
              <ul className="source-list">
                {group(kind).map((source) => (
                  <li key={source.key}>
                    <label>
                      <input type="checkbox" checked={source.active} onChange={() => toggle(source)} />
                      <span>{source.name}</span>
                      {source.language === "pt" && <span className="muted"> · Português</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </main>
  );
}
