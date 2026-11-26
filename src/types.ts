export type Item = {
  id: string;
  url: string;
  kind: "article" | "video" | "link";
  status: "pending" | "ready" | "failed";
  title: string | null;
  excerpt: string | null;
  site_name: string | null;
  author: string | null;
  image_url: string | null;
  word_count: number | null;
  video_embed_url: string | null;
  tags: string[];
  is_archived: boolean;
  is_favorite: boolean;
  /** Percentage read, 0 to 100. Missing on copies stored before this was tracked. */
  read_progress?: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** The article itself, stored apart from the list entry. */
export type Body = {
  id: string;
  content_html: string | null;
  text_content: string | null;
};

/** The fields that can be changed after saving. `deleted_at` marks an item as removed. */
export type ItemPatch = Partial<Pick<Item, "is_archived" | "is_favorite" | "tags" | "deleted_at" | "read_progress">>;

/** Something done on this device that still has to reach the server. */
export type NewOutboxEntry = { at: string } & (
  | { type: "save"; url: string; tags?: string[] }
  | { type: "update"; id: string; patch: ItemPatch }
);
export type OutboxEntry = NewOutboxEntry & { key: number };

export function readingTime(words: number | null): string | null {
  if (!words) return null;
  return `${Math.max(1, Math.round(words / 230))} min read`;
}

/** "Read ✓", "45% read", or nothing for an article that has barely been started. */
export function progressLabel(item: Item): string | null {
  const p = item.read_progress ?? 0;
  if (p >= 100) return "Read ✓";
  return p >= 5 ? `${p}% read` : null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Pulls the first web address out of shared text such as "Title https://…". */
export function findUrl(text: string | null | undefined): string | null {
  return text?.match(/https?:\/\/[^\s<>"']+/i)?.[0] ?? null;
}

/** One weekly suggestion. `vote` is the admin's own thumb: 1, -1 or 0. */
export type Suggestion = {
  id: string;
  week: string;
  grp: "new" | "curated" | "archive";
  position: number;
  url: string;
  title: string;
  publication: string;
  via: string[];
  tags: string[];
  reason: string;
  reading_minutes: number | null;
  language: string;
  published: boolean;
  vote: number;
};

/** Added to every article saved from the weekly suggestions. */
export const SUGGESTED_TAG = "suggested";

/** True when two addresses point at the same page, ignoring tracking details. */
export function sameArticle(a: string, b: string): boolean {
  const key = (raw: string) => {
    try {
      const u = new URL(raw);
      return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}

/** Tidies a typed tag: lower case, no leading #, single spaces. */
export function cleanTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase().slice(0, 40);
}
