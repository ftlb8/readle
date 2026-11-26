import { useEffect, useState, type FormEvent } from "react";
import { saveAndNotify, search, signOut, updateItem, useStore } from "./store";
import { hostOf, progressLabel, readingTime, type Item } from "./types";
import { SetPassword } from "./SetPassword";

type View = "list" | "favorites" | "archive";
const VIEWS: { id: View; label: string }[] = [
  { id: "list", label: "My list" },
  { id: "favorites", label: "Favorites" },
  { id: "archive", label: "Archive" },
];

export function List() {
  const { ready, items, pending, online, syncing, picks, picksSeen } = useStore();
  const hasNewPicks = picks.length > 0 && picks[0].week !== picksSeen;
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [settingPassword, setSettingPassword] = useState(false);
  const [view, setView] = useState<View>("list");
  const [tag, setTag] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Set<string> | null>(null);

  const searching = query.trim().length > 0;

  // Search runs on the device, a moment after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setMatches(null);
    let current = true;
    const timer = window.setTimeout(() => {
      search(q).then((ids) => current && setMatches(ids));
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, items]);

  // A search looks through everything; otherwise the chosen view applies.
  const visible = items.filter((item) => {
    if (tag && !item.tags.includes(tag)) return false;
    if (searching) return matches?.has(item.id) ?? false;
    if (view === "list") return !item.is_archived;
    if (view === "archive") return item.is_archived;
    return item.is_favorite;
  });

  const waiting = pending.filter((entry) => entry.type === "save");
  const showQueue = view === "list" && !searching && !tag;

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
      ? "Sign out? Changes still waiting to be sent will be lost."
      : "Sign out? Your reading list will be removed from this device until you sign in again.";
    if (window.confirm(warning)) signOut();
  }

  function toggleSearch() {
    setSearchOpen((open) => !open);
    setQuery("");
  }

  function emptyMessage(): string {
    if (searching) return matches === null ? "Searching…" : "Nothing matches that search.";
    if (tag) return `Nothing here is tagged #${tag}.`;
    if (view === "favorites") return "No favorites yet. Tap the star on anything worth keeping.";
    if (view === "archive") return "Nothing archived yet. Archive what you have finished to keep your list short.";
    return syncing ? "Fetching your reading list…" : "Nothing saved yet. Paste a link above to add your first one.";
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1 className="brand">Readler</h1>
        <span className="status muted">{!online ? "Offline" : syncing ? "Syncing…" : ""}</span>
        {picks.length > 0 && (
          <a className="link suggestions-link" href="#/suggestions">
            Suggestions
            {hasNewPicks && <span className="dot" aria-label="new suggestions" />}
          </a>
        )}
        <details className="menu">
          <summary className="link">Account</summary>
          <div className="menu-items">
            <button
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                setSettingPassword(true);
              }}
            >
              Set password
            </button>
            <button onClick={confirmSignOut}>Sign out</button>
          </div>
        </details>
      </header>
      {settingPassword && <SetPassword onClose={() => setSettingPassword(false)} />}

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

      <nav className="views" aria-label="Views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={view === v.id && !searching ? "view active" : "view"}
            aria-current={view === v.id && !searching ? "page" : undefined}
            onClick={() => {
              setView(v.id);
              setQuery("");
              setSearchOpen(false);
            }}
          >
            {v.label}
          </button>
        ))}
        <button className={searchOpen ? "view active push" : "view push"} aria-expanded={searchOpen} onClick={toggleSearch}>
          Search
        </button>
      </nav>

      {searchOpen && (
        <input
          className="search"
          type="search"
          autoFocus
          aria-label="Search your saved items"
          placeholder="Search titles and article text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {tag && (
        <p className="filter">
          Showing
          <button className="tag active" onClick={() => setTag(null)} aria-label={`Stop filtering by ${tag}`}>
            #{tag} ×
          </button>
        </p>
      )}

      <ul className="items">
        {showQueue && saving && (
          <li className="row pending">
            <div className="item">
              <div className="item-text">
                <span className="item-meta">{hostOf(saving)}</span>
                <span className="item-title">Saving…</span>
              </div>
            </div>
          </li>
        )}
        {showQueue &&
          waiting.map(
            (entry) =>
              entry.type === "save" && (
                <li key={`pending-${entry.key}`} className="row pending">
                  <div className="item">
                    <div className="item-text">
                      <span className="item-meta">{hostOf(entry.url)} · Waiting for a connection</span>
                      <span className="item-title">{entry.url}</span>
                    </div>
                  </div>
                </li>
              ),
          )}
        {visible.map((item) => (
          <Row key={item.id} item={item} showArchived={searching || !!tag} onTag={setTag} />
        ))}
      </ul>

      {!ready && <p className="center muted">Loading…</p>}
      {ready && visible.length === 0 && !(showQueue && (saving || waiting.length)) && (
        <p className="empty muted">{emptyMessage()}</p>
      )}
    </main>
  );
}

function Row({ item, showArchived, onTag }: { item: Item; showArchived: boolean; onTag: (tag: string) => void }) {
  const meta = [
    item.site_name || hostOf(item.url),
    item.kind === "video" ? "Video" : readingTime(item.word_count),
    item.kind === "link" ? "Link only" : null,
    progressLabel(item),
    showArchived && item.is_archived ? "Archived" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const progress = item.read_progress ?? 0;

  return (
    <li className={progress >= 100 ? "row is-read" : "row"}>
      <a className="item" href={`#/item/${item.id}`}>
        <div className="item-text">
          <span className="item-meta">{meta}</span>
          <span className="item-title">{item.title || item.url}</span>
          {item.excerpt && <span className="item-excerpt">{item.excerpt}</span>}
          {progress >= 5 && progress < 100 && (
            <span className="progress" role="img" aria-label={`${progress}% read`}>
              <span style={{ width: `${progress}%` }} />
            </span>
          )}
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
      <div className="row-foot">
        <div className="tags">
          {item.tags.map((t) => (
            <button key={t} className="tag" onClick={() => onTag(t)}>
              #{t}
            </button>
          ))}
        </div>
        <button
          className={item.is_favorite ? "icon on" : "icon"}
          aria-label={item.is_favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={item.is_favorite}
          onClick={() => updateItem(item.id, { is_favorite: !item.is_favorite })}
        >
          {item.is_favorite ? "★" : "☆"}
        </button>
        <button
          className="icon text"
          onClick={() => updateItem(item.id, { is_archived: !item.is_archived })}
        >
          {item.is_archived ? "Move to list" : "Archive"}
        </button>
      </div>
    </li>
  );
}
