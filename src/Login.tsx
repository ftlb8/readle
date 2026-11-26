import { useState, type FormEvent } from "react";
import { supabase } from "./supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <main className="login">
      <h1 className="brand">Readle</h1>
      <p className="muted">Your reading list, saved for later.</p>

      {!sent ? (
        <form onSubmit={sendCode}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <button className="primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a sign-in code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p>
            We sent an email to <strong>{email}</strong>. Enter the code from it, or open the link in the email on
            this device.
          </p>
          <label htmlFor="code">Code</label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
          />
          <button className="primary" disabled={busy}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" className="link" onClick={() => setSent(false)}>
            Use a different email
          </button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
