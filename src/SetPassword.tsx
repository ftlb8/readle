import { useState, type FormEvent } from "react";
import { supabase } from "./supabase";

const MIN_LENGTH = 10;

/** Lets the signed-in user choose a password, so later sign-ins need no email. */
export function SetPassword({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== repeat) return setError("The two passwords do not match.");
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setError(error.message);
    else setDone(true);
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="set-password-title">
      <div className="sheet">
        <h2 id="set-password-title">Set a password</h2>
        {done ? (
          <>
            <p>Password saved. You can now sign in on any device with your email and this password.</p>
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="muted">
              With a password you can sign in on your phone and other browsers without waiting for an email.
            </p>
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <label htmlFor="repeat-password">Repeat it</label>
            <input
              id="repeat-password"
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
            {error && <p className="error" role="alert">{error}</p>}
            <div className="sheet-actions">
              <button type="button" className="link" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Saving…" : "Save password"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
