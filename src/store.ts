// The app's data layer. Screens read from here; this module keeps the local
// copy (IndexedDB) and the server (Supabase) in step.
import { useSyncExternalStore } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { db } from "./db";
import { supabase } from "./supabase";
import { findUrl, type Body, type Item, type OutboxEntry } from "./types";

type State = {
  ready: boolean;
  items: Item[];
  pending: OutboxEntry[];
  online: boolean;
  syncing: boolean;
  notice: string | null;
  error: string | null;
  updateReady: boolean;
};

let state: State = {
  ready: false,
  items: [],
  pending: [],
  online: navigator.onLine,
  syncing: false,
  notice: null,
  error: null,
  updateReady: false,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const PAGE = 100;
const CURSOR = "cursor";

async function reload() {
  const [items, pending] = await Promise.all([db.allItems(), db.outbox()]);
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  set({ items, pending, ready: true });
}

let noticeTimer: number | undefined;
function notify(notice: string) {
  set({ notice });
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => set({ notice: null }), 3500);
}

/** Called when a newer version of the app has been downloaded in the background. */
export function markUpdateReady() {
  set({ updateReady: true });
}

export function dismissError() {
  set({ error: null });
}

/** Downloads everything that changed on the server since the last sync. */
let syncing: Promise<void> | null = null;
export function sync(): Promise<void> {
  syncing ??= (async () => {
    if (!navigator.onLine) return;
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return;
    set({ syncing: true });
    try {
      let cursor = (await db.meta<string>(CURSOR)) ?? "1970-01-01T00:00:00Z";
      for (;;) {
        const { data, error } = await supabase
          .from("items")
          .select("*")
          .gte("updated_at", cursor)
          .order("updated_at", { ascending: true })
          .limit(PAGE);
        if (error) throw error;
        const rows = data as (Item & Body)[];
        if (rows.length === 0) break;
        await db.remove(rows.filter((r) => r.deleted_at).map((r) => r.id));
        await db.putRows(rows.filter((r) => !r.deleted_at));
        cursor = rows[rows.length - 1].updated_at;
        await db.setMeta(CURSOR, cursor);
        if (rows.length < PAGE) break;
      }
      await reload();
    } catch (err) {
      // Stay quiet about connection drops: the local copy is still usable.
      if (navigator.onLine) set({ error: `Sync failed: ${(err as Error).message}` });
    } finally {
      set({ syncing: false });
      syncing = null;
    }
  })();
  return syncing;
}

type SaveResult = "saved" | "queued";

async function sendSave(url: string): Promise<Item & Body> {
  const { data, error } = await supabase.functions.invoke("save", { body: { url } });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      // The server looked at the link and refused it; retrying will not help.
      let message = "Could not save this link";
      try {
        message = (await error.context.json()).error ?? message;
      } catch {
        // keep the generic message
      }
      throw new RejectedError(message);
    }
    throw error;
  }
  if (!data?.item) throw new RejectedError("Could not save this link");
  return data.item;
}

class RejectedError extends Error {}

/** Saves a link now, or queues it when there is no connection. */
export async function saveUrl(raw: string): Promise<SaveResult> {
  const url = findUrl(raw) ?? raw.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("That does not look like a web link");

  const { data: auth } = navigator.onLine ? await supabase.auth.getSession() : { data: { session: null } };
  if (auth.session) {
    try {
      const item = await sendSave(url);
      await db.putRows([item]);
      await reload();
      return "saved";
    } catch (err) {
      if (err instanceof RejectedError) throw err;
      // Anything else is a connection problem: fall through and queue it.
    }
  }
  await db.addToOutbox({ type: "save", url, at: new Date().toISOString() });
  await reload();
  return "queued";
}

/** Sends everything that was queued while offline. */
let flushing: Promise<void> | null = null;
export function flushOutbox(): Promise<void> {
  flushing ??= (async () => {
    try {
      if (!navigator.onLine) return;
      const { data: auth } = await supabase.auth.getSession();
      if (!auth.session) return;
      let sent = 0;
      for (const entry of await db.outbox()) {
        try {
          await db.putRows([await sendSave(entry.url)]);
          sent++;
        } catch (err) {
          if (!(err instanceof RejectedError)) break; // still offline: try again later
          set({ error: `${entry.url}: ${err.message}` });
        }
        await db.removeFromOutbox(entry.key);
      }
      await reload();
      if (sent) notify(sent === 1 ? "Saved 1 queued link" : `Saved ${sent} queued links`);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Saves a link and reports the outcome in the notice bar. Used by the share sheet. */
export async function saveAndNotify(raw: string): Promise<boolean> {
  try {
    const result = await saveUrl(raw);
    notify(result === "saved" ? "Saved" : "Saved for later — it will download when you are back online");
    return true;
  } catch (err) {
    set({ error: (err as Error).message });
    return false;
  }
}

/** The list entry and article body for one item, from the local copy when possible. */
export async function getFull(id: string): Promise<{ item: Item; body: Body | null } | null> {
  const [item, body] = await Promise.all([db.item(id), db.body(id)]);
  if (item && (body || item.kind !== "article")) return { item, body: body ?? null };
  if (!navigator.onLine) return item ? { item, body: null } : null;

  const { data } = await supabase.from("items").select("*").eq("id", id).maybeSingle();
  if (!data) return item ? { item, body: null } : null;
  await db.putRows([data]);
  const { content_html, text_content, ...fresh } = data as Item & Body;
  return { item: fresh, body: { id, content_html, text_content } };
}

/** Sends queued actions, then downloads changes. */
export async function refresh() {
  await flushOutbox();
  await sync();
}

let started = false;
/** Loads the local copy, then starts syncing. Safe to call more than once. */
export async function start() {
  if (started) return;
  started = true;
  window.addEventListener("online", () => {
    set({ online: true });
    refresh();
  });
  window.addEventListener("offline", () => set({ online: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  await reload();
  refresh();
}

/** Signs out and removes the downloaded reading list from this device. */
export async function signOut() {
  await supabase.auth.signOut();
  await db.clear(true);
  set({ items: [], pending: [], error: null });
}
