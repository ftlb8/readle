import { useEffect, useMemo, useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import { allTags, deleteItem, getFull, showNotice, updateItem, useStore } from "./store";
import { AUDIO_DAYS, hasAudio, listen, removeAudio, useAudio } from "./audio";
import { cleanTag, hostOf, progressLabel, readingTime, type Body, type Item } from "./types";

// Saved pages come from the open web: strip anything that could run code,
// and make every link open in a new tab so the reader is never navigated away.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") {
    node.setAttribute("loading", "lazy");
    node.setAttribute("referrerpolicy", "no-referrer");
  }
});

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "class", "id", "width", "height"],
  });
}

function back() {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = "#/";
}

export function Reader({ id }: { id: string }) {
  const { items } = useStore();
  const [fetched, setFetched] = useState<Item | null>(null);
  const [content, setContent] = useState<Body | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list's copy reflects changes (favorite, tags) straight away.
  const item = items.find((i) => i.id === id) ?? fetched;

  useEffect(() => {
    window.scrollTo(0, 0);
    let current = true;
    getFull(id)
      .then((found) => {
        if (!current) return;
        if (!found) setError("This item is not on this device yet. Connect to the internet and try again.");
        else {
          setFetched(found.item);
          setContent(found.body);
        }
        setLoaded(true);
      })
      .catch((err) => current && setError((err as Error).message));
    return () => {
      current = false;
    };
  }, [id]);

  const body = useMemo(() => (content?.content_html ? sanitize(content.content_html) : null), [content]);
  const offline = !navigator.onLine;

  // Listening: whether this article's audio is on the device, and what the player is doing with it.
  const audio = useAudio();
  const [audioStored, setAudioStored] = useState(false);
  const mineInPlayer = audio.itemId === id;
  useEffect(() => {
    hasAudio(id).then(setAudioStored);
  }, [id, audio.changes]);

  // Remembers how far down the article the reader has got, and returns there
  // on the next visit. Progress only ever goes up; "Mark as unread" resets it.
  const startProgress = fetched?.read_progress ?? 0;
  useEffect(() => {
    if (!body) return;
    let best = startProgress;
    let stored = startProgress;
    let lastStore = 0;
    const page = document.documentElement;

    const persist = (force: boolean) => {
      if (best <= stored) return;
      if (!force && (best - stored < 3 || Date.now() - lastStore < 4000)) return;
      stored = best;
      lastStore = Date.now();
      updateItem(id, { read_progress: best });
    };
    const onScroll = () => {
      let seen = Math.round(((window.scrollY + window.innerHeight) / page.scrollHeight) * 100);
      if (seen >= 95) seen = 100;
      if (seen > best) {
        best = Math.min(100, seen);
        persist(best === 100);
      }
    };
    const onHide = () => persist(true);

    let shortTimer: number | undefined;
    // A short wait lets the article lay itself out before its height is measured.
    const settle = window.setTimeout(() => {
      if (best > 5 && best < 95) {
        window.scrollTo(0, Math.max(0, (best / 100) * page.scrollHeight - window.innerHeight));
      } else if (page.scrollHeight <= window.innerHeight + 40) {
        // The whole piece fits on screen: count it as read after a moment.
        shortTimer = window.setTimeout(() => {
          best = 100;
          persist(true);
        }, 8000);
      }
      window.addEventListener("scroll", onScroll, { passive: true });
    }, 60);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(shortTimer);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      persist(true);
    };
    // Deliberately not re-run when progress itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, body]);

  async function toggleArchive() {
    if (!item) return;
    await updateItem(item.id, { is_archived: !item.is_archived });
    showNotice(item.is_archived ? "Moved back to your list" : "Archived");
    back();
  }

  async function remove() {
    if (!item || !window.confirm("Delete this item? This cannot be undone.")) return;
    await deleteItem(item.id);
    showNotice("Deleted");
    back();
  }

  return (
    <main className="page reader">
      <header className="topbar">
        <button className="link" onClick={back}>
          ← Back
        </button>
        {item && (
          <div className="reader-actions">
            <button
              className={item.is_favorite ? "icon on" : "icon"}
              aria-label={item.is_favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={item.is_favorite}
              onClick={() => updateItem(item.id, { is_favorite: !item.is_favorite })}
            >
              {item.is_favorite ? "★" : "☆"}
            </button>
            <button className="icon text" onClick={toggleArchive}>
              {item.is_archived ? "Move to list" : "Archive"}
            </button>
            <a className="icon text" href={item.url} target="_blank" rel="noopener noreferrer">
              Original ↗
            </a>
            <details className="menu">
              <summary className="link">More</summary>
              <div className="menu-items">
                <button
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    updateItem(item.id, { read_progress: (item.read_progress ?? 0) >= 100 ? 0 : 100 });
                  }}
                >
                  {(item.read_progress ?? 0) >= 100 ? "Mark as unread" : "Mark as read"}
                </button>
                <button className="danger" onClick={remove}>
                  Delete
                </button>
              </div>
            </details>
          </div>
        )}
      </header>

      {error && !item && <p className="error" role="alert">{error}</p>}
      {!item && !error && <p className="center muted">Loading…</p>}

      {item && (
        <article>
          <p className="item-meta">
            {[item.site_name || hostOf(item.url), item.author, readingTime(item.word_count), progressLabel(item)]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <h1>{item.title || item.url}</h1>
          <TagEditor item={item} suggestions={allTags(items)} />

          {item.kind === "article" && body && (
            <div className="listen-row">
              <button
                className="listen"
                disabled={(offline && !audioStored && !mineInPlayer) || (mineInPlayer && audio.status === "preparing")}
                onClick={() => listen(item)}
              >
                {mineInPlayer && audio.status === "preparing"
                  ? "Preparing audio…"
                  : mineInPlayer && audio.status === "playing"
                    ? "❚❚ Pause"
                    : audioStored || mineInPlayer
                      ? "▶ Continue listening"
                      : "▶ Listen"}
              </button>
              {audioStored && !(mineInPlayer && audio.status === "preparing") && (
                <button className="link" onClick={() => removeAudio(id).then(() => setAudioStored(false))}>
                  Remove audio
                </button>
              )}
              {audioStored && (
                <span className="muted listen-note">Kept on this device for {AUDIO_DAYS} days</span>
              )}
              {offline && !audioStored && !mineInPlayer && <span className="muted">Needs a connection the first time</span>}
            </div>
          )}

          {item.kind === "video" && item.video_embed_url && (
            <div className="video">
              <iframe
                src={item.video_embed_url}
                title={item.title ?? "Video"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
          )}

          {item.kind === "video" && offline && <p className="muted">Videos need an internet connection to play.</p>}

          {item.kind === "article" && body && <div className="prose" dangerouslySetInnerHTML={{ __html: body }} />}

          {item.kind === "article" && !body && loaded && (
            <div className="notice">
              <p>The text of this article has not been downloaded to this device yet.</p>
            </div>
          )}

          {item.kind === "link" && (
            <div className="notice">
              <p>{item.excerpt || "Readler could not extract a readable version of this page."}</p>
              <a className="primary button" href={item.url} target="_blank" rel="noopener noreferrer">
                Open the original page
              </a>
            </div>
          )}
        </article>
      )}
    </main>
  );
}

function TagEditor({ item, suggestions }: { item: Item; suggestions: string[] }) {
  const [draft, setDraft] = useState("");

  function add(e: FormEvent) {
    e.preventDefault();
    const fresh = draft.split(",").map(cleanTag).filter((t) => t && !item.tags.includes(t));
    setDraft("");
    if (fresh.length) updateItem(item.id, { tags: [...item.tags, ...new Set(fresh)] });
  }

  return (
    <form className="tag-editor" onSubmit={add}>
      {item.tags.map((t) => (
        <button
          key={t}
          type="button"
          className="tag active"
          aria-label={`Remove tag ${t}`}
          onClick={() => updateItem(item.id, { tags: item.tags.filter((x) => x !== t) })}
        >
          #{t} ×
        </button>
      ))}
      <input
        className="tag-input"
        list="known-tags"
        aria-label="Add a tag"
        placeholder="Add a tag"
        enterKeyHint="done"
        autoCapitalize="none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <datalist id="known-tags">
        {suggestions
          .filter((t) => !item.tags.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </form>
  );
}
