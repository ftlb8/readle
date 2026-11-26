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
import {
  clip, htmlToText, linksIn, loadEnvFile, normalizeUrl, readSource, rpc, rx, toIso,
} from "./lib.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const VERBOSE = process.argv.includes("--verbose");

const EXCERPT_CHARS = 400;

// Places a curator may link to that are never long-form articles.
const NEVER_ARTICLES =
  /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|tiktok\.com|linkedin\.com|threads\.net|bsky\.app|spotify\.com|apple\.com|amazon\.[a-z.]+|a\.co|wikipedia\.org|archive\.(ph|is|org)|mailchi\.mp|list-manage\.com|memberful\.com|patreon\.com|google\.com|t\.co|github\.com|soundcloud\.com|bandcamp\.com|flickr\.com|imgur\.com|giphy\.com|reddit\.com)$/i;
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|mp3|mp4|mov|zip)$/i;

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
    const result = await rpc("curation_ingest", {
      p_token: token, p_sources: index === 0 ? sources : null, p_items: batch,
    });
    totals.new += result.new;
    totals.merged += result.merged;
  }
  return totals;
}

// ---------- main ----------

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
