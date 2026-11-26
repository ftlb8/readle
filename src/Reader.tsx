import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { getFull } from "./store";
import { hostOf, readingTime, type Body, type Item } from "./types";

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
  const [item, setItem] = useState<Item | null>(null);
  const [content, setContent] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    let current = true;
    getFull(id)
      .then((found) => {
        if (!current) return;
        if (!found) setError("This item is not on this device yet. Connect to the internet and try again.");
        else {
          setItem(found.item);
          setContent(found.body);
        }
      })
      .catch((err) => current && setError((err as Error).message));
    return () => {
      current = false;
    };
  }, [id]);

  const body = useMemo(() => (content?.content_html ? sanitize(content.content_html) : null), [content]);
  const offline = !navigator.onLine;

  return (
    <main className="page reader">
      <header className="topbar">
        <button className="link" onClick={back}>
          ← Back
        </button>
        {item && (
          <a className="link" href={item.url} target="_blank" rel="noopener noreferrer">
            Open original ↗
          </a>
        )}
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {!item && !error && <p className="center muted">Loading…</p>}

      {item && (
        <article>
          <p className="item-meta">
            {[item.site_name || hostOf(item.url), item.author, readingTime(item.word_count)].filter(Boolean).join(" · ")}
          </p>
          <h1>{item.title || item.url}</h1>

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

          {item.kind === "article" && !body && (
            <div className="notice">
              <p>The text of this article has not been downloaded to this device yet.</p>
            </div>
          )}

          {item.kind === "link" && (
            <div className="notice">
              <p>{item.excerpt || "Readle could not extract a readable version of this page."}</p>
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
