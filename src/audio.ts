// Listening to an article. The speech arrives from the server in parts; they
// are joined into one audio file kept on this device, because a single real
// file is what the phone keeps playing with the screen off and lets the lock
// screen and headphone buttons control.
import { useSyncExternalStore } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type AudioState = {
  itemId: string | null;
  title: string;
  site: string;
  status: "idle" | "preparing" | "paused" | "playing";
  done: number; // parts fetched so far, while preparing
  total: number;
  time: number;
  duration: number;
  rate: number;
  error: string | null;
  changes: number; // goes up whenever audio is added to or removed from the device
  storedIds: string[]; // articles whose audio is on this device
};

const RATES = [1, 1.25, 1.5, 1.75, 2];
/** Audio is deleted from the device this many days after it was made. */
export const AUDIO_DAYS = 3;
const CREATED = "X-Created";
const CACHE = "readler-audio";
const PARALLEL = 3;
const key = (id: string) => `/audio/${id}`;
const positionKey = (id: string) => `readle.audio.pos.${id}`;

let state: AudioState = {
  itemId: null,
  title: "",
  site: "",
  status: "idle",
  done: 0,
  total: 0,
  time: 0,
  duration: 0,
  rate: Number(localStorage.getItem("readle.audio.rate")) || 1,
  error: null,
  changes: 0,
  storedIds: [],
};
const listeners = new Set<() => void>();
function set(patch: Partial<AudioState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useAudio(): AudioState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Called when an article has been listened to the end. Set by the player bar. */
export const audioEvents: { onFinished: ((itemId: string) => void) | null } = { onFinished: null };

const player = new Audio();
player.preload = "auto";
let objectUrl: string | null = null;
let run = 0; // increases whenever a different article is started, to drop stale work
let lastSaved = 0;

// ---------- joining the parts ----------

const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/**
 * Removes the labels an MP3 file starts and ends with. Each part describes
 * only itself ("I am 40 seconds long"); left in, a player can believe the
 * joined file ends where the first part does.
 */
export function stripMp3Labels(buffer: ArrayBuffer): Uint8Array {
  let bytes = new Uint8Array(buffer);
  // Trailing "TAG" block (ID3v1), always 128 bytes.
  if (bytes.length > 128 && bytes[bytes.length - 128] === 0x54 && bytes[bytes.length - 127] === 0x41 && bytes[bytes.length - 126] === 0x47) {
    bytes = bytes.subarray(0, bytes.length - 128);
  }
  let i = 0;
  // Leading "ID3" block, whose size is stored in four 7-bit bytes.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    i = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  }
  while (i + 4 < bytes.length && !(bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0)) i++;
  if (i + 4 >= bytes.length) return bytes;

  // The first audio frame may be an information frame ("Xing" or "Info") with no sound in it.
  const version = (bytes[i + 1] >> 3) & 3;
  const layer = (bytes[i + 1] >> 1) & 3;
  const bitrateIndex = (bytes[i + 2] >> 4) & 15;
  const rateIndex = (bytes[i + 2] >> 2) & 3;
  const padding = (bytes[i + 2] >> 1) & 1;
  if (layer !== 1 || version === 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return bytes.subarray(i);
  const kbps = (version === 3 ? KBPS_V1 : KBPS_V2)[bitrateIndex];
  const length = Math.floor(((version === 3 ? 144000 : 72000) * kbps) / SAMPLE_RATES[version][rateIndex]) + padding;
  const head = String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + Math.min(length, 200))));
  return /Xing|Info/.test(head) ? bytes.subarray(i + length) : bytes.subarray(i);
}

// ---------- fetching ----------

async function ask(body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke("speak", { body });
  if (!error) return data;
  let message = "Could not reach the speech service. Check your connection.";
  if (error instanceof FunctionsHttpError) {
    try {
      message = (await error.context.json()).error ?? message;
    } catch {
      // keep the generic message
    }
  }
  throw new Error(message);
}

async function generate(itemId: string, mine: number): Promise<Blob | null> {
  const plan = (await ask({ item_id: itemId })) as { parts: number };
  if (mine !== run) return null;
  set({ total: plan.parts, done: 0 });

  const pieces: Uint8Array[] = new Array(plan.parts);
  let next = 0;
  async function worker() {
    while (next < plan.parts && mine === run) {
      const part = next++;
      const audio = (await ask({ item_id: itemId, part })) as Blob;
      pieces[part] = stripMp3Labels(await audio.arrayBuffer());
      if (mine === run) set({ done: state.done + 1 });
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.parts) }, worker));
  if (mine !== run) return null;
  return new Blob(pieces as BlobPart[], { type: "audio/mpeg" });
}

async function stored(itemId: string): Promise<Blob | null> {
  if (!("caches" in window)) return null;
  const hit = await (await caches.open(CACHE)).match(key(itemId));
  return hit ? hit.blob() : null;
}

/**
 * Looks at what audio is on the device, deletes anything older than
 * AUDIO_DAYS, and records which articles still have some.
 */
export async function refreshStored(): Promise<void> {
  if (!("caches" in window)) return;
  const cache = await caches.open(CACHE);
  const limit = Date.now() - AUDIO_DAYS * 24 * 60 * 60 * 1000;
  const kept: string[] = [];
  for (const request of await cache.keys()) {
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    const response = await cache.match(request);
    if (!response || !id) continue;
    const created = Date.parse(response.headers.get(CREATED) ?? "");
    if (Number.isNaN(created)) {
      // Made before audio was dated: start its three days now.
      await cache.put(request, new Response(await response.blob(), { headers: stamp() }));
    } else if (created < limit && state.itemId !== id) {
      await cache.delete(request);
      localStorage.removeItem(positionKey(id));
      continue;
    }
    kept.push(id);
  }
  set({ storedIds: kept, changes: state.changes + 1 });
}

function stamp(): HeadersInit {
  return { "Content-Type": "audio/mpeg", [CREATED]: new Date().toISOString() };
}

/** True when this article's audio is already on the device. */
export async function hasAudio(itemId: string): Promise<boolean> {
  return (await stored(itemId)) !== null;
}

// ---------- controls ----------

function savePosition(force = false) {
  if (!state.itemId || !player.duration) return;
  if (!force && Math.abs(player.currentTime - lastSaved) < 5) return;
  lastSaved = player.currentTime;
  localStorage.setItem(positionKey(state.itemId), String(Math.floor(player.currentTime)));
}

function release() {
  player.pause();
  player.removeAttribute("src");
  player.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

/** Starts, pauses or resumes listening to an article. */
export async function listen(item: { id: string; title: string | null; site_name: string | null }): Promise<void> {
  if (state.itemId === item.id) {
    if (state.status === "playing") return player.pause();
    if (state.status === "paused") return void player.play().catch(() => {});
    if (state.status === "preparing") return;
  }

  const mine = ++run;
  savePosition(true);
  release();
  set({ itemId: item.id, title: item.title ?? "Article", site: item.site_name ?? "", status: "preparing", done: 0, total: 0, time: 0, duration: 0, error: null });

  try {
    let audio = await stored(item.id);
    if (!audio) {
      audio = await generate(item.id, mine);
      if (!audio) return; // another article was started meanwhile
      if ("caches" in window) {
        await (await caches.open(CACHE)).put(key(item.id), new Response(audio, { headers: stamp() }));
        await refreshStored();
      }
    }
    if (mine !== run) return;

    objectUrl = URL.createObjectURL(audio);
    player.src = objectUrl;
    player.playbackRate = state.rate;
    const resumeAt = Number(localStorage.getItem(positionKey(item.id))) || 0;
    if (resumeAt > 5) {
      player.addEventListener("loadedmetadata", () => { player.currentTime = Math.max(0, resumeAt - 3); }, { once: true });
    }
    set({ status: "paused" });
    describe();
    // If the phone refuses to start by itself after the wait, the play button is there.
    await player.play().catch(() => {});
  } catch (err) {
    if (mine === run) set({ status: "idle", itemId: null, error: (err as Error).message });
  }
}

export function toggle() {
  if (state.status === "playing") player.pause();
  else if (state.status === "paused") player.play().catch(() => {});
}

export function seekBy(seconds: number) {
  if (!player.duration) return;
  player.currentTime = Math.min(Math.max(0, player.currentTime + seconds), player.duration - 0.5);
}

export function seekTo(seconds: number) {
  if (player.duration) player.currentTime = Math.min(Math.max(0, seconds), player.duration - 0.5);
}

export function nextRate() {
  const rate = RATES[(RATES.indexOf(state.rate) + 1) % RATES.length] ?? 1;
  player.playbackRate = rate;
  localStorage.setItem("readle.audio.rate", String(rate));
  set({ rate });
}

/** Closes the player. The audio stays on the device so listening can resume later. */
export function closePlayer() {
  run++;
  savePosition(true);
  release();
  set({ itemId: null, status: "idle", time: 0, duration: 0, error: null });
}

export function dismissAudioError() {
  set({ error: null });
}

/** Deletes an article's audio from this device. */
export async function removeAudio(itemId: string): Promise<void> {
  if (state.itemId === itemId) closePlayer();
  localStorage.removeItem(positionKey(itemId));
  if ("caches" in window) await (await caches.open(CACHE)).delete(key(itemId));
  await refreshStored();
}

// ---------- lock screen and headphone buttons ----------

function describe() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.title,
    artist: state.site || "Readler",
    album: "Readler",
    artwork: [
      { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
}

if ("mediaSession" in navigator) {
  const on = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // this phone does not offer that button
    }
  };
  on("play", () => void player.play().catch(() => {}));
  on("pause", () => player.pause());
  on("seekbackward", (d) => seekBy(-(d.seekOffset ?? 15)));
  on("seekforward", (d) => seekBy(d.seekOffset ?? 30));
  on("previoustrack", () => seekBy(-15));
  on("nexttrack", () => seekBy(30));
  on("seekto", (d) => d.seekTime != null && seekTo(d.seekTime));
}

function reportPosition() {
  if (!("mediaSession" in navigator) || !Number.isFinite(player.duration) || !player.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: player.duration,
      playbackRate: player.playbackRate,
      position: Math.min(player.currentTime, player.duration),
    });
  } catch {
    // not supported everywhere
  }
}

player.addEventListener("play", () => set({ status: "playing" }));
player.addEventListener("pause", () => {
  if (state.status === "playing") set({ status: "paused" });
  savePosition(true);
});
player.addEventListener("durationchange", () => {
  set({ duration: Number.isFinite(player.duration) ? player.duration : 0 });
  reportPosition();
});
player.addEventListener("ratechange", reportPosition);
player.addEventListener("seeked", reportPosition);
player.addEventListener("timeupdate", () => {
  set({ time: player.currentTime });
  savePosition();
});
player.addEventListener("ended", () => {
  const finished = state.itemId;
  if (!finished) return;
  // Done listening: the audio is no longer needed on this device.
  removeAudio(finished).then(() => audioEvents.onFinished?.(finished));
});
player.addEventListener("error", () => {
  if (state.itemId && player.src) set({ status: "idle", itemId: null, error: "This audio could not be played." });
});

// Clear out old audio when the app opens, and again whenever it comes back to the front.
refreshStored();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStored();
});
