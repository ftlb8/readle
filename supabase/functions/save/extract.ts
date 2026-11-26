// Turns a URL (or a page's HTML) into the fields stored for a saved item.
// Pure logic: no Supabase or Deno-specific APIs, so it can be tested locally.
import { Readability } from "npm:@mozilla/readability@0.5.0";
import { parseHTML } from "npm:linkedom@0.18.5";

export type ItemFields = {
  kind: "article" | "video" | "link";
  status: "ready" | "failed";
  title: string;
  excerpt: string | null;
  site_name: string | null;
  author: string | null;
  image_url: string | null;
  content_html: string | null;
  text_content: string | null;
  word_count: number | null;
  video_embed_url: string | null;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = "Readle/1.0 (personal read-later app; single user)";
const MAX_HTML_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const MIN_ARTICLE_CHARS = 250;
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src|si)$/i;

/** Finds the first http(s) URL in shared text and strips tracking parameters. */
export function normalizeUrl(raw: string): string {
  const match = String(raw ?? "").match(/https?:\/\/[^\s<>"']+/i);
  if (!match) throw new Error("No URL found");
  // Drop punctuation that belongs to the surrounding sentence, but keep a
  // closing bracket that is part of the address, as in /wiki/Pocket_(service).
  let found = match[0].replace(/[,.;!?]+$/, "");
  while (found.endsWith(")") && found.split(")").length > found.split("(").length) {
    found = found.slice(0, -1).replace(/[,.;!?]+$/, "");
  }
  const u = new URL(found);
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hash = "";
  return u.toString();
}

/** Rejects URLs that point at local or private network addresses. */
export function assertPublicUrl(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https URLs can be saved");
  }
  const host = u.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[") ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (isPrivate) throw new Error("This address cannot be saved");
}

type Video = { embedUrl: string; oembedUrl: string; site: string };

export function detectVideo(u: URL): Video | null {
  const host = u.hostname.replace(/^(www|m|music)\./, "").toLowerCase();
  let id: string | null = null;

  if (host === "youtu.be") {
    id = u.pathname.split("/")[1] || null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]+)/);
      if (m) id = m[2];
    }
  }
  if (id && /^[\w-]{6,}$/.test(id)) {
    return {
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      oembedUrl: `https://www.youtube.com/oembed?format=json&url=${
        encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)
      }`,
      site: "YouTube",
    };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = u.pathname.match(/^\/(?:video\/)?(\d+)(?:\/(\w+))?/);
    if (m) {
      const hash = m[2] ?? u.searchParams.get("h");
      return {
        embedUrl: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ""}`,
        oembedUrl: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u.toString())}`,
        site: "Vimeo",
      };
    }
  }
  return null;
}

async function fetchHtml(u: URL): Promise<string> {
  assertPublicUrl(u);
  const get = (userAgent: string) =>
    fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
      },
    });
  let res = await get(USER_AGENT);
  // Some sites (Wikipedia, for one) refuse generic browser strings but accept
  // a client that says plainly what it is.
  if (res.status === 403 || res.status === 429) {
    await res.body?.cancel();
    res = await get(HONEST_USER_AGENT);
  }
  if (!res.ok) throw new Error(`Site answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|xml/i.test(type)) throw new Error(`Not a web page (${type})`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_HTML_BYTES) throw new Error("Page is too large");

  // Pages do not always use UTF-8: honour the declared charset.
  let charset = type.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function clip(text: string | null | undefined, max: number): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function absolute(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/** Makes links and images absolute and removes anything executable. */
function cleanContent(html: string, base: string): { html: string; text: string } {
  const { document } = parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  const root = document.getElementById("root")!;

  root.querySelectorAll("script, style, link, meta, form, input, button").forEach((el: any) => el.remove());

  root.querySelectorAll("*").forEach((el: any) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });

  root.querySelectorAll("a[href]").forEach((a: any) => {
    const href = absolute(a.getAttribute("href"), base);
    if (href && /^https?:/i.test(href)) a.setAttribute("href", href);
    else a.removeAttribute("href");
  });

  root.querySelectorAll("img, source, video, audio, iframe").forEach((el: any) => {
    const lazy = el.getAttribute("data-src") || el.getAttribute("data-lazy-src");
    const current = el.getAttribute("src");
    const src = absolute(!current || current.startsWith("data:") ? lazy || current : current, base);
    if (src) el.setAttribute("src", src);

    const srcset = el.getAttribute("srcset") || el.getAttribute("data-srcset");
    if (srcset) {
      const fixed = srcset
        .split(/,\s+/)
        .map((part: string) => {
          const [url, size] = part.trim().split(/\s+/);
          const abs = absolute(url, base);
          return abs ? [abs, size].filter(Boolean).join(" ") : null;
        })
        .filter(Boolean)
        .join(", ");
      if (fixed) el.setAttribute("srcset", fixed);
      else el.removeAttribute("srcset");
    }
  });

  const cleaned = root.innerHTML.trim();

  // Plain text for search and word count. Pad block elements so that words in
  // neighbouring paragraphs do not run together.
  root.querySelectorAll("p, div, h1, h2, h3, h4, h5, h6, li, blockquote, br, td, th, figcaption, pre").forEach(
    (el: any) => el.after(document.createTextNode(" ")),
  );
  const text = (root.textContent ?? "").replace(/\s+/g, " ").trim();

  return { html: cleaned, text };
}

export function extractArticle(html: string, url: string): ItemFields {
  const { document } = parseHTML(html);
  const meta = (...names: string[]): string | null => {
    for (const name of names) {
      const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const value = el?.getAttribute("content")?.trim();
      if (value) return value;
    }
    return null;
  };

  const host = new URL(url).hostname.replace(/^www\./, "");
  const metaTitle = meta("og:title", "twitter:title") ?? document.querySelector("title")?.textContent?.trim() ?? null;
  // Ignore placeholder descriptions such as "..." so the article text is used instead.
  const rawExcerpt = meta("og:description", "description", "twitter:description");
  const metaExcerpt = rawExcerpt && rawExcerpt.replace(/[^\p{L}\p{N}]/gu, "").length >= 20 ? rawExcerpt : null;
  const siteName = meta("og:site_name", "application-name") ?? host;
  const image = absolute(meta("og:image", "twitter:image"), url);
  const metaAuthor = meta("author", "article:author");

  // Read metadata first: Readability rewrites the document while parsing.
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document as unknown as Document).parse();
  } catch {
    article = null;
  }

  const content = article?.content ? cleanContent(article.content, url) : null;
  const text = content?.text ?? "";
  const base: ItemFields = {
    kind: "link",
    status: "ready",
    title: clip(article?.title || metaTitle, 300) ?? host,
    excerpt: clip(
      metaExcerpt || (article?.excerpt && article.excerpt.replace(/[^\p{L}\p{N}]/gu, "").length >= 20 ? article.excerpt : null),
      320,
    ),
    site_name: clip(article?.siteName || siteName, 120),
    author: clip(article?.byline || (metaAuthor && !/^https?:/.test(metaAuthor) ? metaAuthor : null), 160),
    image_url: image,
    content_html: null,
    text_content: null,
    word_count: null,
    video_embed_url: null,
  };

  if (!content || text.length < MIN_ARTICLE_CHARS) return base;

  return {
    ...base,
    kind: "article",
    excerpt: base.excerpt ?? clip(text, 320),
    content_html: content.html,
    text_content: text,
    word_count: text.split(" ").length,
  };
}

/** Builds the stored fields for a URL. Pass `html` when the page was captured in the browser. */
export async function buildItem(url: string, html?: string): Promise<ItemFields> {
  const u = new URL(url);
  assertPublicUrl(u);
  const host = u.hostname.replace(/^www\./, "");

  const video = detectVideo(u);
  if (video) {
    const fields: ItemFields = {
      kind: "video",
      status: "ready",
      title: url,
      excerpt: null,
      site_name: video.site,
      author: null,
      image_url: null,
      content_html: null,
      text_content: null,
      word_count: null,
      video_embed_url: video.embedUrl,
    };
    try {
      const res = await fetch(video.oembedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const data = await res.json();
        fields.title = clip(data.title, 300) ?? url;
        fields.author = clip(data.author_name, 160);
        fields.image_url = data.thumbnail_url ?? null;
      }
    } catch {
      // Keep the URL as the title; the video still embeds.
    }
    return fields;
  }

  if (!html) {
    try {
      html = await fetchHtml(u);
    } catch (err) {
      return {
        kind: "link",
        status: "failed",
        title: host + (u.pathname.length > 1 ? u.pathname : ""),
        excerpt: clip(`Could not load this page: ${(err as Error).message}`, 320),
        site_name: host,
        author: null,
        image_url: null,
        content_html: null,
        text_content: null,
        word_count: null,
        video_embed_url: null,
      };
    }
  } else if (html.length > MAX_HTML_BYTES) {
    throw new Error("Page is too large");
  }

  return extractArticle(html, url);
}
