import { useEffect, useRef, useState } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";

const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

/** Admin only: hear each available voice and choose the one articles are read in. */
export function VoicePicker() {
  const [current, setCurrent] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const samples = useRef(new Map<string, string>()); // voice -> local audio address, so each is fetched once

  useEffect(() => {
    supabase.rpc("speech_voice").then(({ data }) => setCurrent(data ?? "alloy"));
    const cached = samples.current;
    return () => {
      audio.current?.pause();
      cached.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  async function play(voice: string) {
    setError(null);
    audio.current?.pause();
    if (playing === voice) return setPlaying(null);

    let url = samples.current.get(voice);
    if (!url) {
      setLoading(voice);
      const { data, error } = await supabase.functions.invoke("speak", { body: { sample: true, voice } });
      setLoading(null);
      if (error || !(data instanceof Blob)) {
        let message = error?.message ?? "Could not load the sample";
        if (error instanceof FunctionsHttpError) {
          try {
            message = (await error.context.json()).error ?? message;
          } catch {
            // keep the generic message
          }
        }
        return setError(message);
      }
      url = URL.createObjectURL(new Blob([data], { type: "audio/mpeg" }));
      samples.current.set(voice, url);
    }
    const player = new Audio(url);
    audio.current = player;
    player.onended = () => setPlaying(null);
    setPlaying(voice);
    player.play().catch(() => setPlaying(null));
  }

  async function choose(voice: string) {
    const previous = current;
    setCurrent(voice);
    const { error } = await supabase.rpc("speech_admin_set_voice", { p_voice: voice });
    if (error) {
      setCurrent(previous);
      setError(error.message);
    }
  }

  return (
    <section className="settings-block">
      <h2>Listening voice</h2>
      <p className="muted">
        The voice articles are read aloud in, for everyone. Play a sample of each, in English and Portuguese, then
        choose one.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="voice-list">
        {VOICES.map((voice) => (
          <li key={voice}>
            <button className="icon text" onClick={() => play(voice)} disabled={loading !== null && loading !== voice}>
              {loading === voice ? "Loading…" : playing === voice ? "■ Stop" : "▶ Play"}
            </button>
            <label>
              <input type="radio" name="voice" checked={current === voice} onChange={() => choose(voice)} />
              <span className="voice-name">{voice}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
