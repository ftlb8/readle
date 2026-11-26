import { useState, type FormEvent } from "react";
import { supabase } from "./supabase";

type Mode = "password" | "link";

export function Login() {
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ error: { message: string } | null }>, after?: () => void) {
    setBusy(true);
    setError(null);
    const { error } = await action();
    setBusy(false);
    if (error) setError(error.message);
    else after?.();
  }

  function signIn(e: FormEvent) {
    e.preventDefault();
    run(() => supabase.auth.signInWithPassword({ email: email.trim(), password }));
  }

  function sendLink(e: FormEvent) {
    e.preventDefault();
    run(
      () =>
        supabase.auth.signInWithOtp({
          email: email.trim(),
          options: { emailRedirectTo: window.location.origin + window.location.pathname },
        }),
      () => setSent(true),
    );
  }

  function verify(e: FormEvent) {
    e.preventDefault();
    run(() => supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" }));
  }

  function switchTo(next: Mode) {
    setMode(next);
    setSent(false);
    setError(null);
  }

  const emailField = (
    <>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />
    </>
  );

  return (
    <main className="login">
      <h1 className="brand">Readler</h1>
      <p className="muted">Your reading list, saved for later.</p>

      {mode === "password" && (
        <form onSubmit={signIn}>
          {emailField}
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button type="button" className="link" onClick={() => switchTo("link")}>
            No password yet? Email me a sign-in link
          </button>
        </form>
      )}

      {mode === "link" && !sent && (
        <form onSubmit={sendLink}>
          {emailField}
          <button className="primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
          <button type="button" className="link" onClick={() => switchTo("password")}>
            Sign in with a password instead
          </button>
        </form>
      )}

      {mode === "link" && sent && (
        <form onSubmit={verify}>
          <p>
            We sent an email to <strong>{email}</strong>. Open the link in it on this device. If the email shows a
            code, you can enter it here instead.
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
          <button type="button" className="link" onClick={() => switchTo("password")}>
            Back
          </button>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
