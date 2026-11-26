import { useState, type FormEvent } from "react";
import { saveAndNotify, signOut, useStore } from "./store";
import { hostOf, readingTime } from "./types";

export function List() {
  const { ready, items, pending, online, syncing } = useStore();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const visible = items.filter((i) => !i.is_archived);

  async function save(e: FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    setSaving(value);
    setUrl("");
    const ok = await saveAndNotify(value);
    setSaving(null);
    if (!ok) setUrl(value);
  }

  function confirmSignOut() {
    const warning = pending.length
      ? "Sign out? Links still waiting to be saved will be lost."
      : "Sign out? Your reading list will be removed from this device until you sign in again.";
    if (window.confirm(warning)) signOut();
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1 className="brand">Readle</h1>
        <span className="status muted">{!online ? "Offline" : syncing ? "Syncing…" : ""}</span>
        <button className="link" onClick={confirmSignOut}>
          Sign out
        </button>
      </header>

      <form className="add" onSubmit={save}>
        <input
          type="text"
          inputMode="url"
          aria-label="Link to save"
          placeholder="Paste a link to save"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="primary" disabled={!!saving || !url.trim()}>
          Save
        </button>
      </form>

      <ul className="items">
        {saving && (
          <li className="item pending">
            <div className="item-text">
              <span className="item-meta">{hostOf(saving)}</span>
              <span className="item-title">Saving…</span>
            </div>
          </li>
        )}
        {pending.map((entry) => (
          <li key={`pending-${entry.key}`} className="item pending">
            <div className="item-text">
              <span className="item-meta">{hostOf(entry.url)} · Waiting for a connection</span>
              <span className="item-title">{entry.url}</span>
            </div>
          </li>
        ))}
        {visible.map((item) => (
          <li key={item.id}>
            <a className="item" href={`#/item/${item.id}`}>
              <div className="item-text">
                <span className="item-meta">
                  {[
                    item.site_name || hostOf(item.url),
                    item.kind === "video" ? "Video" : readingTime(item.word_count),
                    item.kind === "link" ? "Link only" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="item-title">{item.title || item.url}</span>
                {item.excerpt && <span className="item-excerpt">{item.excerpt}</span>}
              </div>
              {item.image_url && (
                <img
                  className="item-thumb"
                  src={item.image_url}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => (e.currentTarget.hidden = true)}
                />
              )}
            </a>
          </li>
        ))}
      </ul>

      {!ready && <p className="center muted">Loading…</p>}
      {ready && visible.length === 0 && pending.length === 0 && !saving && (
        <p className="empty muted">
          {syncing ? "Fetching your reading list…" : "Nothing saved yet. Paste a link above to add your first one."}
        </p>
      )}
    </main>
  );
}
