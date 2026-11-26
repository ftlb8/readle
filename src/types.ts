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
export type ItemPatch = Partial<Pick<Item, "is_archived" | "is_favorite" | "tags" | "deleted_at">>;

/** Something done on this device that still has to reach the server. */
export type NewOutboxEntry = { at: string } & (
  | { type: "save"; url: string }
  | { type: "update"; id: string; patch: ItemPatch }
);
export type OutboxEntry = NewOutboxEntry & { key: number };

export function readingTime(words: number | null): string | null {
  if (!words) return null;
  return `${Math.max(1, Math.round(words / 230))} min read`;
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

/** Tidies a typed tag: lower case, no leading #, single spaces. */
export function cleanTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase().slice(0, 40);
}
