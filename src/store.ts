// The app's data layer. Screens read from here; this module keeps the local
// copy (IndexedDB) and the server (Supabase) in step.
import { useSyncExternalStore } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { db } from "./db";
import { supabase } from "./supabase";
import { findUrl, SUGGESTED_TAG, type Body, type Item, type ItemPatch, type OutboxEntry, type Suggestion } from "./types";

type State = {
  ready: boolean;
  items: Item[];
  pending: OutboxEntry[];
  online: boolean;
  syncing: boolean;
  notice: string | null;
  error: string | null;
  updateReady: boolean;
  picks: Suggestion[];
  isAdmin: boolean;
  picksSeen: string;
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
  picks: [],
  isAdmin: localStorage.getItem("readle.isAdmin") === "1",
  picksSeen: localStorage.getItem("readle.picksSeen") ?? "",
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

async function sendSave(url: string, tags: string[] = []): Promise<Item & Body> {
  const { data, error } = await supabase.functions.invoke("save", { body: tags.length ? { url, tags } : { url } });
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

/**
 * Saves a link now, or queues it when there is no connection. Any `tags` are
 * added to the saved article. Returns the article's id once it is saved.
 */
export async function saveUrl(raw: string, tags: string[] = []): Promise<{ status: SaveResult; id?: string }> {
  const url = findUrl(raw) ?? raw.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("That does not look like a web link");

  const { data: auth } = navigator.onLine ? await supabase.auth.getSession() : { data: { session: null } };
  if (auth.session) {
    try {
      const item = await sendSave(url, tags);
      await db.putRows([item]);
      await reload();
      const merged = [...new Set([...item.tags, ...tags])];
      if (merged.length !== item.tags.length) await updateItem(item.id, { tags: merged });
      return { status: "saved", id: item.id };
    } catch (err) {
      if (err instanceof RejectedError) throw err;
      // Anything else is a connection problem: fall through and queue it.
    }
  }
  await db.addToOutbox({ type: "save", url, tags, at: new Date().toISOString() });
  await reload();
  return { status: "queued" };
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
          if (entry.type === "save") {
            const item = await sendSave(entry.url, entry.tags ?? []);
            const merged = [...new Set([...item.tags, ...(entry.tags ?? [])])];
            if (merged.length !== item.tags.length) {
              await sendUpdate(item.id, { tags: merged });
              item.tags = merged;
            }
            await db.putRows([item]);
            sent++;
          } else {
            await sendUpdate(entry.id, entry.patch);
          }
        } catch (err) {
          if (!(err instanceof RejectedError)) break; // still offline: try again later
          set({ error: err.message });
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

async function sendUpdate(id: string, patch: ItemPatch): Promise<void> {
  const { error } = await supabase.from("items").update(patch).eq("id", id);
  if (!error) return;
  // Database errors carry a code; a dropped connection does not.
  if (!error.code) throw new Error(error.message);
  throw new RejectedError(`Could not update the item: ${error.message}`);
}

/**
 * Changes an item (archive, favorite, tags). The change shows immediately,
 * is kept on this device, and is sent to the server as soon as possible.
 */
export async function updateItem(id: string, patch: ItemPatch): Promise<void> {
  await db.patchItem(id, patch);
  await db.addToOutbox({ type: "update", id, patch, at: new Date().toISOString() });
  await reload();
  flushOutbox();
}

/** Removes an item from every device. */
export async function deleteItem(id: string): Promise<void> {
  await db.remove([id]);
  await db.addToOutbox({ type: "update", id, patch: { deleted_at: new Date().toISOString() }, at: new Date().toISOString() });
  await reload();
  flushOutbox();
}

export function showNotice(text: string) {
  notify(text);
}

/**
 * Finds the items containing every word of the query, looking at the title,
 * description, site, author, tags and the full article text.
 */
export async function search(query: string): Promise<Set<string>> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = new Set<string>();
  if (terms.length === 0) return found;

  const details = new Map<string, string>();
  for (const i of state.items) {
    details.set(i.id, [i.title, i.excerpt, i.site_name, i.author, i.url, i.tags.join(" ")].join(" ").toLowerCase());
  }
  const check = (id: string, text: string) => {
    if (terms.every((t) => text.includes(t))) found.add(id);
  };
  details.forEach((text, id) => check(id, text));
  await db.eachBody((body) => {
    const about = details.get(body.id);
    if (about !== undefined && !found.has(body.id) && body.text_content) {
      check(body.id, about + " " + body.text_content.toLowerCase());
    }
  });
  return found;
}

/** Every tag in use, most used first. */
export function allTags(items: Item[]): string[] {
  const counts = new Map<string, number>();
  for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** Saves a link and reports the outcome in the notice bar. Used by the share sheet. */
export async function saveAndNotify(raw: string): Promise<boolean> {
  try {
    const { status } = await saveUrl(raw);
    notify(status === "saved" ? "Saved" : "Saved for later — it will download when you are back online");
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

// ---------- weekly suggestions ----------

const GROUP_ORDER = { new: 0, curated: 1, archive: 2 };

/** Loads the weekly suggestions: from this device first, then fresh from the server. */
export async function loadPicks(): Promise<void> {
  if (state.picks.length === 0) {
    const cached = await db.meta<Suggestion[]>("picks");
    // Copies stored by an older version of the app have no topic tags.
    if (cached?.length) set({ picks: cached.map((p) => ({ ...p, tags: p.tags ?? [] })) });
  }
  if (!navigator.onLine) return;
  const { data: auth } = await supabase.auth.getSession();
  if (!auth.session) return;

  const [rows, admin] = await Promise.all([
    supabase.from("picks").select("*").order("week", { ascending: false }).limit(300),
    supabase.rpc("is_admin"),
  ]);
  if (rows.error) return;
  const isAdmin = admin.data === true;
  const votes = new Map<string, number>();
  if (isAdmin) {
    const { data } = await supabase.from("pick_feedback").select("pick_id,vote");
    for (const row of data ?? []) votes.set(row.pick_id, row.vote);
  }
  const picks = (rows.data as Suggestion[])
    .map((p) => ({ ...p, tags: p.tags ?? [], vote: votes.get(p.id) ?? 0 }))
    .sort((a, b) => b.week.localeCompare(a.week) || GROUP_ORDER[a.grp] - GROUP_ORDER[b.grp] || a.position - b.position);
  await db.setMeta("picks", picks);
  localStorage.setItem("readle.isAdmin", isAdmin ? "1" : "0");
  set({ picks, isAdmin });
}

/**
 * Saves a suggestion to the reading list, tagged as suggested and with its
 * topic tags. Returns the saved article's id, or null if it could not be
 * saved right now.
 */
export async function saveSuggestion(pick: Suggestion): Promise<string | null> {
  try {
    const { status, id } = await saveUrl(pick.url, [SUGGESTED_TAG, ...pick.tags]);
    notify(status === "saved" ? "Saved to your list" : "Saved for later — it will download when you are back online");
    return id ?? null;
  } catch (err) {
    set({ error: (err as Error).message });
    return null;
  }
}

/** Remembers that the newest suggestions have been looked at, which clears the dot. */
export function markPicksSeen() {
  const newest = state.picks[0]?.week ?? "";
  if (!newest || newest === state.picksSeen) return;
  localStorage.setItem("readle.picksSeen", newest);
  set({ picksSeen: newest });
}

/** Admin only: thumbs up or down on a suggestion. Choosing the same thumb again clears it. */
export async function votePick(id: string, vote: 1 | -1): Promise<void> {
  const current = state.picks.find((p) => p.id === id)?.vote ?? 0;
  const next = current === vote ? 0 : vote;
  set({ picks: state.picks.map((p) => (p.id === id ? { ...p, vote: next } : p)) });
  const { error } =
    next === 0
      ? await supabase.from("pick_feedback").delete().eq("pick_id", id)
      : await supabase.from("pick_feedback").upsert({ pick_id: id, vote: next });
  if (error) {
    set({ picks: state.picks.map((p) => (p.id === id ? { ...p, vote: current } : p)), error: `Could not record that: ${error.message}` });
  } else {
    db.setMeta("picks", state.picks);
  }
}

/** Admin only: makes a draft week visible to everyone. */
export async function publishWeek(week: string): Promise<void> {
  const { error } = await supabase.rpc("curation_admin_publish", { p_week: week });
  if (error) return set({ error: `Could not publish: ${error.message}` });
  notify("Published to everyone");
  await loadPicks();
}

/** Sends queued actions, then downloads changes. */
export async function refresh() {
  await flushOutbox();
  await sync();
  await loadPicks();
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
  localStorage.removeItem("readle.isAdmin");
  set({ items: [], pending: [], error: null, picks: [], isAdmin: false });
}
