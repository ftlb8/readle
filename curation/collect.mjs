// Daily collector for Readler's weekly suggestions.
//
// Reads the feed of every source in sources.json and records articles it has
// not seen before. For a publication the candidates are its own articles; for
// a curator they are the outside articles it recommends.
//
// Only card-level details are sent to the database (title, short excerpt,
// link, dates). Article text is measured for length here and then discarded.
//
//   node collect.mjs             collect and store
//   node collect.mjs --dry-run   collect and print counts, store nothing
//   node collect.mjs --only=aeon limit to one source (implies nothing else)

import { readFile, appendFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";

const SUPABASE_URL = "https://kgnpncskdmzwqmjrrupx.supabase.co";
const SUPABASE_KEY = "sb_publishable_TR1a-HqOvBOusa_4F8Kuyg_dyE7FG5-"; // public by design
// Says plainly what this is. Several sites refuse clients that pretend to be a browser.
const USER_AGENT = "Readler/1.0 (+https://readler.app; personal feed reader)";

const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const VERBOSE = process.argv.includes("--verbose");

const FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ITEMS = 60;
const EXCERPT_CHARS = 400;

// Link parameters that only track where a reader came from.
const TRACKING = /^(utm_\w+|ref|src|r|fbclid|gclid|mc_cid|mc_eid|igshid|smid|smtyp|cmpid|ito|ncid|ref_src|unlocked_article_code|gift|giftCopy|share|at_medium|at_campaign|CMP)$/i;

// Places a curator may link to that are never long-form articles.
const NEVER_ARTICLES =
  /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|tiktok\.com|linkedin\.com|threads\.net|bsky\.app|spotify\.com|apple\.com|amazon\.[a-z.]+|a\.co|wikipedia\.org|archive\.(ph|is|org)|mailchi\.mp|list-manage\.com|memberful\.com|patreon\.com|google\.com|t\.co|github\.com|soundcloud\.com|bandcamp\.com|flickr\.com|imgur\.com|giphy\.com|reddit\.com)$/i;
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|mp3|mp4|mov|zip)$/i;

// ---------- small helpers ----------

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Text of a feed field, which may be a plain string or an element with attributes. */
function field(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return field(value[0]);
  if (typeof value === "object") {
    // Atom "xhtml" content arrives as nested elements, not a string: gather its text.
    return value["#text"] != null ? field(value["#text"]) : deepText(value).trim();
  }
  return decodeEntities(String(value)).trim();
}

function deepText(node) {
  if (node == null) return "";
  if (typeof node !== "object") return decodeEntities(String(node)) + " ";
  if (Array.isArray(node)) return node.map(deepText).join("");
  return Object.entries(node)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => deepText(child))
    .join("");
}

function squash(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function parseFragment(html) {
  return parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`).document.getElementById("r");
}

function htmlToText(html) {
  if (!html) return "";
  if (!/[<&]/.test(html)) return squash(html);
  try {
    return squash(parseFragment(html).textContent);
  } catch {
    return squash(html.replace(/<[^>]+>/g, " "));
  }
}

function linksIn(html) {
  if (!html) return [];
  try {
    return [...parseFragment(html).querySelectorAll("a[href]")].map((a) => ({
      href: a.getAttribute("href"),
      text: squash(a.textContent),
    }));
  } catch {
    return [];
  }
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(decodeEntities(String(href).trim()), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
}

function toIso(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function rx(pattern) {
  return pattern ? new RegExp(pattern, "i") : null;
}

function clip(text, max) {
  const t = squash(text);
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// ---------- reading feeds ----------

async function fetchFeed(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Entities are decoded by hand above: large feeds trip the parser's safety limits.
  processEntities: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["item", "entry", "link", "category"].includes(name),
});

/** Turns RSS or Atom into one common shape. */
function parseFeed(xml) {
  const doc = parser.parse(xml.replace(/^﻿?\s+/, "")); // some feeds start with blank lines
  const rssItems = doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item;
  if (rssItems) {
    return rssItems.map((it) => ({
      title: field(it.title),
      link: field((it.link ?? []).find((l) => typeof l === "string" || l?.["#text"]) ?? it.guid),
      published: field(it.pubDate ?? it["dc:date"] ?? it.date),
      summary: field(it.description),
      content: field(it["content:encoded"]),
      categories: (it.category ?? []).map(field).filter(Boolean),
    }));
  }
  const entries = doc?.feed?.entry;
  if (entries) {
    return entries.map((en) => {
      const links = en.link ?? [];
      const main = links.find((l) => l?.["@_rel"] === "alternate") ?? links.find((l) => !l?.["@_rel"]) ?? links[0];
      return {
        title: field(en.title),
        link: decodeEntities(main?.["@_href"] ?? ""),
        published: field(en.published ?? en.updated),
        summary: field(en.summary),
        content: field(en.content),
        categories: (en.category ?? []).map((c) => decodeEntities(c?.["@_term"] ?? field(c))).filter(Boolean),
      };
    });
  }
  throw new Error("not an RSS or Atom feed");
}

function pageUrl(feedUrl, page) {
  if (page === 1) return feedUrl;
  const u = new URL(feedUrl);
  u.searchParams.set("paged", String(page));
  return u.toString();
}

async function readSource(source) {
  const config = source.config ?? {};
  const items = [];
  for (let page = 1; page <= (config.pages ?? 1); page++) {
    let xml;
    try {
      xml = await fetchFeed(pageUrl(source.feed_url, page));
    } catch (err) {
      if (page === 1) throw err;
      break; // ran out of older pages
    }
    const pageItems = parseFeed(xml);
    if (pageItems.length === 0) break;
    items.push(...pageItems);
  }
  return items.slice(0, config.maxItems ?? DEFAULT_MAX_ITEMS);
}

// ---------- turning feed items into candidates ----------

function fromPublication(source, items) {
  const c = source.config ?? {};
  const includeLink = rx(c.includeLink), excludeLink = rx(c.excludeLink);
  const includeCategory = rx(c.includeCategory), excludeCategory = rx(c.excludeCategory);
  const excludeTitle = rx(c.excludeTitle);
  const out = [];

  for (const item of items) {
    const url = normalizeUrl(item.link, source.feed_url);
    if (!url || !item.title) continue;
    if (includeLink && !includeLink.test(url)) continue;
    if (excludeLink && excludeLink.test(url)) continue;
    const categories = item.categories.join(" | ");
    if (includeCategory && !includeCategory.test(categories)) continue;
    if (excludeCategory && excludeCategory.test(categories)) continue;
    if (excludeTitle && excludeTitle.test(item.title)) continue;

    // When the feed carries the article itself, its length is a free long-form filter.
    const body = htmlToText(item.content || (c.minChars ? item.summary : ""));
    if (c.dropTruncated && /read more\s*$/i.test(body)) continue; // subscriber-only preview
    if (c.minChars && body.length < c.minChars) continue;

    out.push({
      url,
      title: clip(item.title, 300),
      excerpt: clip(htmlToText(item.summary) || body, EXCERPT_CHARS) || null,
      source_key: source.key,
      origin: "publication",
      via: [],
      published_at: toIso(item.published),
      feed_chars: item.content ? body.length : null,
      language: source.language ?? "en",
    });
  }
  return out;
}

function fromCurator(source, items) {
  const c = source.config ?? {};
  const ownHost = new URL(source.feed_url).hostname.replace(/^(www|feeds)\./, "");
  const linkMatch = rx(c.linkMatch), excludeHosts = rx(c.excludeHosts);
  const out = [];

  const consider = (href, title, item) => {
    if (linkMatch && !linkMatch.test(String(href))) return;
    const url = normalizeUrl(href, source.feed_url);
    if (!url) return;
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.endsWith(ownHost) || NEVER_ARTICLES.test(host) || NOT_A_PAGE.test(u.pathname)) return;
    if (excludeHosts && excludeHosts.test(host)) return;
    if (u.pathname.length < 2) return; // a site's front page is not an article
    out.push({
      url,
      title: clip(title, 300) || null,
      excerpt: null,
      source_key: source.key,
      origin: "curator",
      via: [source.key],
      published_at: null, // the curator's date is not the article's date
      feed_chars: null,
      language: source.language ?? "en",
    });
  };

  for (const item of items) {
    if (c.mode === "item-link") {
      consider(item.link, item.title, item);
      continue;
    }
    const links = linksIn(item.content || item.summary);
    const external = links.filter((l) => {
      const url = normalizeUrl(l.href, source.feed_url);
      return url && !new URL(url).hostname.endsWith(ownHost);
    });
    if (c.mode === "first-link") {
      if (external[0]) consider(external[0].href, item.title, item);
    } else if (c.mode === "last-link") {
      const last = external[external.length - 1];
      if (last) consider(last.href, item.title, item);
    } else {
      // body-links: every recommended link in the edition
      for (const link of external) {
        if (c.minAnchorChars && link.text.length < c.minAnchorChars) continue;
        const before = out.length;
        consider(link.href, c.titleFromItem ? item.title : link.text, item);
        if (c.onePerItem && out.length > before) break; // one recommendation per post
      }
    }
  }
  return out;
}

// ---------- storing ----------

async function ingest(sources, items) {
  const token = process.env.COLLECTOR_TOKEN;
  if (!token) throw new Error("COLLECTOR_TOKEN is not set");
  const totals = { new: 0, merged: 0 };
  const batches = [];
  for (let i = 0; i < items.length; i += 200) batches.push(items.slice(i, i + 200));
  if (batches.length === 0) batches.push([]);

  for (const [index, batch] of batches.entries()) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/curation_ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({ p_token: token, p_sources: index === 0 ? sources : null, p_items: batch }),
    });
    if (!response.ok) throw new Error(`Storing failed: HTTP ${response.status} ${await response.text()}`);
    const result = await response.json();
    totals.new += result.new;
    totals.merged += result.merged;
  }
  return totals;
}

// ---------- main ----------

async function loadEnvFile() {
  // For running on a developer machine; on GitHub the token comes from a secret.
  try {
    const text = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // no .env file
  }
}

await loadEnvFile();
const allSources = JSON.parse(await readFile(new URL("./sources.json", import.meta.url), "utf8"));
const sources = allSources.filter((s) => s.active !== false && (!ONLY || s.key === ONLY));

const report = [];
const collected = new Map(); // url -> candidate, merged across sources

await Promise.all(
  sources.map(async (source) => {
    const row = { key: source.key, kind: source.kind, read: 0, kept: 0, error: null };
    try {
      const items = await readSource(source);
      row.read = items.length;
      const found = source.kind === "curator" ? fromCurator(source, items) : fromPublication(source, items);
      const unique = new Map(found.map((f) => [f.url, f]));
      row.kept = unique.size;
      row.sample = [...unique.values()].slice(0, 3).map((f) => f.title);
      for (const candidate of unique.values()) {
        const seen = collected.get(candidate.url);
        if (!seen) collected.set(candidate.url, candidate);
        else if (candidate.origin === "publication" && seen.origin === "curator") {
          collected.set(candidate.url, { ...candidate, via: seen.via });
        } else {
          seen.via = [...new Set([...seen.via, ...candidate.via])];
        }
      }
    } catch (err) {
      row.error = err.message;
    }
    report.push(row);
  }),
);

report.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
const lines = ["| Source | Kind | In feed | Kept | Problem |", "|---|---|---|---|---|"];
for (const r of report) lines.push(`| ${r.key} | ${r.kind} | ${r.read} | ${r.kept} | ${r.error ?? ""} |`);
console.log(lines.join("\n"));
if (VERBOSE) for (const r of report) console.log(`\n${r.key}:\n  ${(r.sample ?? []).join("\n  ")}`);

const failed = report.filter((r) => r.error);
const candidates = [...collected.values()];
let summary = `\n${candidates.length} candidates from ${report.length - failed.length} of ${report.length} sources.`;

if (!DRY_RUN) {
  const stored = await ingest(ONLY ? null : allSources.map(({ config = {}, language = "en", active = true, ...rest }) => ({ ...rest, config, language, active })), candidates);
  summary += ` Stored ${stored.new} new; ${stored.merged} were already known.`;
} else {
  summary += " Dry run: nothing stored.";
}
console.log(summary);

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n${lines.join("\n")}\n`);
}

// A few sources failing is normal on any given day; most of them failing is not.
if (failed.length > report.length / 2) {
  console.error("More than half the sources failed.");
  process.exit(1);
}
