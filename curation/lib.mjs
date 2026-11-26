// Shared by the collector and the judge: reading feeds and tidying links.

import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";

export const SUPABASE_URL = "https://kgnpncskdmzwqmjrrupx.supabase.co";
export const SUPABASE_KEY = "sb_publishable_TR1a-HqOvBOusa_4F8Kuyg_dyE7FG5-"; // public by design
// Says plainly what this is. Several sites refuse clients that pretend to be a browser.
export const USER_AGENT = "Readler/1.0 (+https://readler.app; personal feed reader)";

const FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ITEMS = 60;

// Link parameters that only track where a reader came from.
const TRACKING = /^(utm_\w+|ref|src|r|fbclid|gclid|mc_cid|mc_eid|igshid|smid|smtyp|cmpid|ito|ncid|ref_src|unlocked_article_code|gift|giftCopy|share|at_medium|at_campaign|CMP)$/i;


export function decodeEntities(text) {
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
export function field(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return field(value[0]);
  if (typeof value === "object") {
    // Atom "xhtml" content arrives as nested elements, not a string: gather its text.
    return value["#text"] != null ? field(value["#text"]) : deepText(value).trim();
  }
  return decodeEntities(String(value)).trim();
}

export function deepText(node) {
  if (node == null) return "";
  if (typeof node !== "object") return decodeEntities(String(node)) + " ";
  if (Array.isArray(node)) return node.map(deepText).join("");
  return Object.entries(node)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => deepText(child))
    .join("");
}

export function squash(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function parseFragment(html) {
  return parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`).document.getElementById("r");
}

export function htmlToText(html) {
  if (!html) return "";
  if (!/[<&]/.test(html)) return squash(html);
  try {
    return squash(parseFragment(html).textContent);
  } catch {
    return squash(html.replace(/<[^>]+>/g, " "));
  }
}

export function linksIn(html) {
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

export function normalizeUrl(href, base) {
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

export function toIso(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function rx(pattern) {
  return pattern ? new RegExp(pattern, "i") : null;
}

export function clip(text, max) {
  const t = squash(text);
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// ---------- reading feeds ----------

export async function fetchFeed(url) {
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
export function parseFeed(xml) {
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

export function pageUrl(feedUrl, page) {
  if (page === 1) return feedUrl;
  const u = new URL(feedUrl);
  u.searchParams.set("paged", String(page));
  return u.toString();
}

export async function readSource(source) {
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

export async function loadEnvFile() {
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

/** Calls one of the curation database functions. */
export async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${name} failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
