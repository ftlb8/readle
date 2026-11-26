import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { dismissError, refresh, saveAndNotify, start, useStore } from "./store";
import { findUrl } from "./types";
import { Login } from "./Login";
import { List } from "./List";
import { Reader } from "./Reader";
import { Suggestions } from "./Suggestions";
import { CurationSettings } from "./CurationSettings";
import { PlayerBar } from "./PlayerBar";

// Remembered separately from the session itself: when the phone is offline the
// session cannot be renewed, but the downloaded reading list must still open.
const SIGNED_IN = "readle.signedIn";

/** Routes live in the URL hash (#/item/<id>) so the app works from any static host. */
function useRoute(): string {
  const read = () => (window.location.hash.startsWith("#/") ? window.location.hash.slice(1) : "/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/**
 * Android's share sheet opens the app with the shared link in the address
 * (?url=… or ?text=…). Save it, then tidy the address.
 */
let shareHandled = false;
function handleShare() {
  if (shareHandled) return;
  shareHandled = true;
  const params = new URLSearchParams(window.location.search);
  const shared = findUrl(params.get("url")) ?? findUrl(params.get("text")) ?? findUrl(params.get("title"));
  if (!params.has("url") && !params.has("text") && !params.has("title")) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  if (shared) saveAndNotify(shared);
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => localStorage.getItem(SIGNED_IN) === "1");
  const [checked, setChecked] = useState(signedIn);
  const { notice, error, updateReady } = useStore();
  const route = useRoute();

  useEffect(() => {
    handleShare();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        localStorage.setItem(SIGNED_IN, "1");
        setSignedIn(true);
        if (event === "SIGNED_IN") refresh();
      } else if (event === "SIGNED_OUT") {
        localStorage.removeItem(SIGNED_IN);
        setSignedIn(false);
      }
      setChecked(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (signedIn) start();
  }, [signedIn]);

  const itemId = route.match(/^\/item\/([\w-]+)$/)?.[1];

  return (
    <>
      {!checked ? (
        <div className="center muted">Loading…</div>
      ) : !signedIn ? (
        <Login />
      ) : (
        <>
          {/* The list stays mounted behind the reader so it keeps its scroll position. */}
          <div hidden={route !== "/"}>
            <List />
          </div>
          {itemId && <Reader key={itemId} id={itemId} />}
          {route === "/suggestions" && <Suggestions />}
          {route === "/suggestions/settings" && <CurationSettings />}
          <PlayerBar />
        </>
      )}

      <div className="toasts" aria-live="polite">
        {updateReady && (
          <div className="toast">
            <span>A new version of Readler is ready.</span>
            <button className="toast-action" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}
        {notice && <div className="toast">{notice}</div>}
        {error && (
          <div className="toast toast-error" role="alert">
            <span>{error}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={dismissError}>
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
