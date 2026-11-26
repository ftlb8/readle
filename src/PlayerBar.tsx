import { useEffect } from "react";
import { audioEvents, closePlayer, dismissAudioError, nextRate, seekBy, seekTo, toggle, useAudio } from "./audio";
import { showNotice, updateItem, useStore } from "./store";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** The listening controls, shown at the bottom of every screen while an article is loaded. */
export function PlayerBar() {
  const audio = useAudio();
  const { items } = useStore();
  const active = audio.itemId !== null;

  // Leaves room at the bottom of the page for the bar.
  useEffect(() => {
    document.body.classList.toggle("has-player", active);
    return () => document.body.classList.remove("has-player");
  }, [active]);

  // Finishing an article by ear counts as having read it.
  useEffect(() => {
    audioEvents.onFinished = (id) => {
      updateItem(id, { read_progress: 100 });
      showNotice("Finished. The audio has been removed from this device.");
    };
    return () => {
      audioEvents.onFinished = null;
    };
  }, []);

  // Listening moves the article's "% read" along, checked about twice a minute.
  const halfMinute = Math.floor(audio.time / 30);
  useEffect(() => {
    if (!audio.itemId || !audio.duration) return;
    const item = items.find((i) => i.id === audio.itemId);
    const heard = Math.min(99, Math.round((audio.time / audio.duration) * 100));
    if (item && heard >= (item.read_progress ?? 0) + 3) updateItem(item.id, { read_progress: heard });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [halfMinute, audio.itemId]);

  if (audio.error && !active) {
    return (
      <div className="player player-error" role="alert">
        <span>{audio.error}</span>
        <button className="player-close" aria-label="Dismiss" onClick={dismissAudioError}>
          ×
        </button>
      </div>
    );
  }
  if (!active) return null;

  const preparing = audio.status === "preparing";
  return (
    <div className="player" role="region" aria-label="Listening">
      <div className="player-top">
        <a className="player-title" href={`#/item/${audio.itemId}`}>
          {audio.title}
        </a>
        <button className="player-close" aria-label="Close the player" onClick={closePlayer}>
          ×
        </button>
      </div>

      {preparing ? (
        <div className="player-preparing">
          <span className="muted">
            {audio.total ? `Preparing audio… ${audio.done} of ${audio.total}` : "Preparing audio…"}
          </span>
          <span className="progress" aria-hidden="true">
            <span style={{ width: `${audio.total ? (audio.done / audio.total) * 100 : 4}%` }} />
          </span>
        </div>
      ) : (
        <>
          <input
            className="player-seek"
            type="range"
            aria-label="Position"
            min={0}
            max={audio.duration || 1}
            step={1}
            value={Math.min(audio.time, audio.duration || 1)}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          <div className="player-controls">
            <span className="player-time">
              {clock(audio.time)} / {audio.duration ? clock(audio.duration) : "–:––"}
            </span>
            <button className="player-button" aria-label="Back 15 seconds" onClick={() => seekBy(-15)}>
              −15
            </button>
            <button className="player-button player-main" aria-label={audio.status === "playing" ? "Pause" : "Play"} onClick={toggle}>
              {audio.status === "playing" ? "❚❚" : "▶"}
            </button>
            <button className="player-button" aria-label="Forward 30 seconds" onClick={() => seekBy(30)}>
              +30
            </button>
            <button className="player-button player-rate" aria-label="Playback speed" onClick={nextRate}>
              {audio.rate}×
            </button>
          </div>
        </>
      )}
    </div>
  );
}
