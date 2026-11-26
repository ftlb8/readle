// Local copy of the reading list, kept in the browser's IndexedDB so the app
// works without a connection.
//   items  - one row per saved link, without the article body (fast to list)
//   bodies - the article HTML and plain text, loaded only when needed
//   outbox - actions taken offline, waiting to be sent
//   meta   - small values such as the sync position
import type { Body, Item, OutboxEntry } from "./types";

const DB_NAME = "readle";
const DB_VERSION = 1;
type StoreName = "items" | "bodies" | "outbox" | "meta";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("items", { keyPath: "id" });
      db.createObjectStore("bodies", { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: "key", autoIncrement: true });
      db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, run: (t: IDBTransaction) => T): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = run(t);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  async allItems(): Promise<Item[]> {
    const d = await open();
    return done(d.transaction("items").objectStore("items").getAll());
  },

  async item(id: string): Promise<Item | undefined> {
    const d = await open();
    return done(d.transaction("items").objectStore("items").get(id));
  },

  async body(id: string): Promise<Body | undefined> {
    const d = await open();
    return done(d.transaction("bodies").objectStore("bodies").get(id));
  },

  /** Stores rows as they come from the server, splitting off the article body. */
  putRows(rows: (Item & Partial<Body>)[]): Promise<void> {
    return tx(["items", "bodies"], "readwrite", (t) => {
      for (const row of rows) {
        const { content_html = null, text_content = null, ...item } = row;
        t.objectStore("items").put(item);
        if (content_html !== null || text_content !== null) {
          t.objectStore("bodies").put({ id: row.id, content_html, text_content });
        }
      }
    });
  },

  remove(ids: string[]): Promise<void> {
    return tx(["items", "bodies"], "readwrite", (t) => {
      for (const id of ids) {
        t.objectStore("items").delete(id);
        t.objectStore("bodies").delete(id);
      }
    });
  },

  async outbox(): Promise<OutboxEntry[]> {
    const d = await open();
    return done(d.transaction("outbox").objectStore("outbox").getAll());
  },

  addToOutbox(entry: Omit<OutboxEntry, "key">): Promise<void> {
    return tx(["outbox"], "readwrite", (t) => {
      t.objectStore("outbox").add(entry);
    });
  },

  removeFromOutbox(key: number): Promise<void> {
    return tx(["outbox"], "readwrite", (t) => {
      t.objectStore("outbox").delete(key);
    });
  },

  async meta<T>(key: string): Promise<T | undefined> {
    const d = await open();
    return done(d.transaction("meta").objectStore("meta").get(key));
  },

  setMeta(key: string, value: unknown): Promise<void> {
    return tx(["meta"], "readwrite", (t) => {
      t.objectStore("meta").put(value, key);
    });
  },

  /** Wipes the downloaded reading list. Queued saves are kept unless asked. */
  clear(includeOutbox: boolean): Promise<void> {
    const stores: StoreName[] = includeOutbox ? ["items", "bodies", "meta", "outbox"] : ["items", "bodies", "meta"];
    return tx(stores, "readwrite", (t) => {
      for (const s of stores) t.objectStore(s).clear();
    });
  },
};
