import { useEffect, useState } from "react";
import { loadPicks, markPicksSeen, publishWeek, saveSuggestion, useStore, votePick } from "./store";
import { sameArticle, type Suggestion } from "./types";

const GROUP_TITLES: Record<Suggestion["grp"], string> = {
  new: "New this week",
  curated: "Recommended by curators",
  archive: "From the archive",
};

function weekLabel(week: string): string {
  const date = new Date(`${week}T12:00:00`);
  return `Week of ${date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`;
}

function back() {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = "#/";
}

export function Suggestions() {
  const { picks, items, isAdmin, online } = useStore();
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    loadPicks().then(markPicksSeen);
  }, []);
  useEffect(markPicksSeen, [picks]);

  const weeks = [...new Set(picks.map((p) => p.week))];

  /** Saves the suggestion; with `open`, goes straight to the clean reading view. */
  async function save(pick: Suggestion, open: boolean) {
    setSaving(pick.id);
    const id = await saveSuggestion(pick);
    setSaving(null);
    if (open && id) window.location.hash = `#/item/${id}`;
  }

  return (
    <main className="page">
      <header className="topbar">
        <button className="link" onClick={back}>
          ← Back
        </button>
        {isAdmin && (
          <a className="link" href="#/suggestions/settings">
            Settings
          </a>
        )}
      </header>

      <h1 className="page-title">Suggestions</h1>
      <p className="muted lead">Long reads chosen each week from a set of magazines, blogs and curators.</p>

      {picks.length === 0 && (
        <p className="empty muted">{online ? "No suggestions yet. New ones arrive on Saturday mornings." : "Connect to the internet to load suggestions."}</p>
      )}

      {weeks.map((week) => {
        const inWeek = picks.filter((p) => p.week === week);
        const draft = inWeek.some((p) => !p.published);
        return (
          <section key={week} className="week">
            <div className="week-head">
              <h2>{weekLabel(week)}</h2>
              {draft && (
                <span className="week-draft">
                  <span className="badge">Draft · only you can see this</span>
                  <button className="link" onClick={() => window.confirm("Show this week's suggestions to everyone?") && publishWeek(week)}>
                    Publish
                  </button>
                </span>
              )}
            </div>

            {(["new", "curated", "archive"] as const).map((group) => {
              const inGroup = inWeek.filter((p) => p.grp === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group}>
                  <h3 className="group-title">{GROUP_TITLES[group]}</h3>
                  <ul className="items">
                    {inGroup.map((pick) => {
                      const mine = items.find((i) => sameArticle(i.url, pick.url));
                      const saved = !!mine;
                      const busy = saving === pick.id;
                      const meta = [
                        pick.publication,
                        pick.reading_minutes ? `${pick.reading_minutes} min read` : null,
                        pick.language === "pt" ? "Português" : null,
                      ].filter(Boolean);
                      return (
                        <li key={pick.id} className="row pick">
                          <span className="item-meta">{meta.join(" · ")}</span>
                          <a className="item-title" href={pick.url} target="_blank" rel="noopener noreferrer">
                            {pick.title}
                          </a>
                          <p className="pick-reason">{pick.reason}</p>
                          {pick.via.length > 0 && <p className="item-meta">Recommended by {pick.via.join(", ")}</p>}
                          {pick.tags.length > 0 && (
                            <div className="tags pick-tags">
                              {pick.tags.map((t) => (
                                <span key={t} className="tag">
                                  #{t}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="row-foot">
                            {mine ? (
                              <a className="icon text primary-text" href={`#/item/${mine.id}`}>
                                Read
                              </a>
                            ) : (
                              <button className="icon text primary-text" disabled={busy} onClick={() => save(pick, true)}>
                                {busy ? "Saving…" : "Read"}
                              </button>
                            )}
                            <button className="icon text" disabled={saved || busy} onClick={() => save(pick, false)}>
                              {saved ? "In your list ✓" : "Save for later"}
                            </button>
                            <a className="icon text" href={pick.url} target="_blank" rel="noopener noreferrer">
                              Open original ↗
                            </a>
                            {isAdmin && (
                              <span className="thumbs">
                                <button
                                  className={pick.vote === 1 ? "icon on" : "icon"}
                                  aria-label="More like this"
                                  aria-pressed={pick.vote === 1}
                                  onClick={() => votePick(pick.id, 1)}
                                >
                                  👍
                                </button>
                                <button
                                  className={pick.vote === -1 ? "icon on" : "icon"}
                                  aria-label="Not for me"
                                  aria-pressed={pick.vote === -1}
                                  onClick={() => votePick(pick.id, -1)}
                                >
                                  👎
                                </button>
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
    </main>
  );
}
