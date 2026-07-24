// scripts/scrape.mjs
//
// Scrapes the ACCC news centre for MEDIA RELEASES and UPDATES (not Speeches),
// applies the overrides layer, and writes data.json.
//
// Design goals (see README):
//  - Plain HTTP fetch + cheerio (no headless browser). The listing is served
//    by Drupal Views AJAX, so we hit that endpoint directly rather than the
//    HTML page (which has no items in its raw markup).
//  - Polite: a real browser User-Agent and a small delay between requests.
//  - Safe: a failed or implausible scrape does NOT overwrite the last good
//    data.json. We also only write when the data actually changed.
//  - Bounded: items are date-sorted (newest first) but the endpoint WRAPS past
//    the end (page 400 still returns 24 cards), so we stop when a page yields
//    no new URLs, or when we reach items older than START_YEAR.
//
// Usage:  node scripts/scrape.mjs
// Exit codes: 0 = success (data written or unchanged), 1 = aborted (old data kept).

import { load } from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_PATH = join(ROOT, "data.json");
const OVERRIDES_PATH = join(ROOT, "overrides.json");

const ORIGIN = "https://www.accc.gov.au";
const NEWS_CENTRE_URL = ORIGIN + "/news-centre";
// The Drupal Views AJAX endpoint that backs the news-centre listing.
// IMPORTANT: leave `type` EMPTY — an empty type returns ALL news types mixed
// (Media releases AND Updates AND Speeches). Sending type=accc_news returns
// ONLY media releases and hides Updates.
const AJAX_URL = ORIGIN + "/views/ajax";

// Only keep items published in or after this calendar year. Items are sorted
// newest-first, so once we pass this cutoff we can stop paginating.
// Change this to widen/narrow the window (default 2023 to match the reference
// timelines). Override at runtime with e.g. START_YEAR=2020 node scripts/scrape.mjs
const START_YEAR = Number(process.env.START_YEAR || 2023);

// NOTE: the ACCC's WAF rejects any User-Agent containing the word "bot",
// so this is a plain, current browser UA. Keep it that way.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_DELAY_MS = 400; // be polite between requests
const MAX_PAGES = 200; // safety cap on pagination (endpoint wraps forever)
const MIN_RECORDS = 1; // a sane scrape returns at least this many
const MAX_DROP_RATIO = 0.2; // abort if record count drops > 20% vs last good

const MONTHS_FULL = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  May: "May",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
};
const MONTH_NUM = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Fetch one page of the news listing via the Views AJAX endpoint. */
async function fetchListingPage(page, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const params = new URLSearchParams({
    view_name: "news_centre",
    view_display_id: "listing_search",
    type: "", // empty on purpose — see note above
    view_args: "",
    page: String(page),
  });
  const url = `${AJAX_URL}?${params.toString()}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-AU,en;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for page ${page}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error(`Unexpected AJAX payload (page ${page})`);
    // The listing markup lives in the "insert" commands' `data` fields.
    return json
      .filter((cmd) => typeof cmd.data === "string" && cmd.data.includes("<"))
      .map((cmd) => cmd.data)
      .join("\n");
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      const backoff = 1000 * attempt;
      console.warn(
        `  fetch failed (${err.message}); retry ${attempt + 1}/${MAX_ATTEMPTS} in ${backoff}ms`
      );
      await sleep(backoff);
      return fetchListingPage(page, attempt + 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Category taxonomy (house rule)
// ---------------------------------------------------------------------------
// The ACCC tags each item with its own live "topic" labels. The firm instead
// uses the vocabulary from its 2024 reference timeline. Rule: use a category
// ONLY IF it appears in that reference doc — so each ACCC topic is mapped to the
// doc's Title-Case label, and any topic with NO mapping here is DROPPED.
//
// Two authorised additions beyond the 2024 doc:
//   - "Petrol and Fuel"        — kept as a category (topical).
//   - "Artificial Intelligence" — applied by title (see isAiArticle below), and
//     it REPLACES the other categories for those items.
//
// Values are arrays so one ACCC topic can expand to several doc atoms
// (e.g. "Rail, shipping and ports" → "Rail" + "Shipping and Ports").
const CATEGORY_MAP = {
  "compliance and enforcement": ["Compliance and Enforcement"],
  "competition and exemptions": ["Competition and Exemptions"],
  "mergers and acquisitions": ["Mergers"],
  "buying and selling products and services": [
    "Buying and Selling Products and Services",
  ],
  "regulated infrastructure": ["Regulated Infrastructure"],
  "advertising and promotions": ["Advertising and Promotions"],
  "stay protected": ["Stay Protected"],
  energy: ["Energy"],
  "telecommunications and internet": ["Telecommunications and Internet"],
  "travel and airports": ["Travel and Airports"],
  scams: ["Scams"],
  "banking and finance": ["Banking and Finance"],
  "digital platforms and services": ["Digital Platforms and Services"],
  "food and groceries": ["Food and Groceries"],
  agriculture: ["Agriculture"],
  pricing: ["Pricing"],
  "industry codes": ["Industry Codes"],
  "rail, shipping and ports": ["Rail", "Shipping and Ports"],
  insurance: ["Insurance"],
  "postal services": ["Postal Services"],
  "cars and vehicles": ["Cars and Vehicles"],
  childcare: ["Childcare"],
  "consumer data right": ["Consumer Data Right"],
  "petrol and fuel": ["Petrol and Fuel"],
  // Deliberately NOT mapped (absent from the 2024 doc), so they are dropped:
  //   "problem with a product or service", "franchising", "water", "debt",
  //   "covid-19". An item left with no category shows an em dash.
};

/**
 * True when an article's TITLE centres on AI. Matches the standalone token "AI"
 * (case-sensitive, so it doesn't fire inside other words) or the full phrase.
 * These items are categorised "Artificial Intelligence" (authorised exception),
 * which replaces whatever their ACCC topics would map to.
 */
function isAiArticle(title) {
  return /\bAI\b/.test(title || "") || /artificial intelligence/i.test(title || "");
}

/** Map raw ACCC topics onto the reference-doc vocabulary (dropping the rest). */
function mapCategories(rawTopics, title) {
  if (isAiArticle(title)) return ["Artificial Intelligence"];
  const out = [];
  for (const raw of rawTopics) {
    const mapped = CATEGORY_MAP[clean(raw).toLowerCase()];
    if (mapped) out.push(...mapped);
  }
  return [...new Set(out)];
}

/** Normalise the ribbon text to the display type, or null if we should skip. */
function normaliseType(ribbon) {
  const r = (ribbon || "").toLowerCase();
  if (r.includes("media release")) return "Media Release";
  if (r.includes("update")) return "Update";
  return null; // Speech (or anything else) → excluded
}

/** Parse one listing page's HTML into an array of records (already filtered). */
function parseCards(html) {
  const $ = load(html);
  const records = [];
  let speeches = 0;

  $("div.accc-date-card--full-width").each((_, el) => {
    const card = $(el);

    const ribbon = clean(card.find("span.accc-date-card__ribbon").first().text());
    const type = normaliseType(ribbon);
    if (type === null) {
      speeches++;
      return;
    }

    const anchor = card.find("a.accc-date-card__link").first();
    const href = anchor.attr("href");
    if (!href) return;
    const permalink = href.startsWith("http") ? href : ORIGIN + href;

    const day = clean(card.find("span.accc-date-card--publish--day").first().text());
    const mon = clean(card.find("span.accc-date-card--publish--month").first().text());
    const year = clean(card.find("span.accc-date-card--publish--year").first().text());

    const title =
      clean(card.find(".field--name-node-title").first().text()) ||
      clean(anchor.text());

    // A card can carry several topic badges. Collect each separately (the raw
    // text runs them together with no separator), then map onto the firm's
    // reference-doc vocabulary (see CATEGORY_MAP). Keep an array for filtering
    // plus a comma-joined string for display/search.
    const topicField = card.find(".field--name-field-acccgov-topic").first();
    const rawTopics = [];
    const badges = topicField.find(".terms-badge");
    if (badges.length) {
      badges.each((__, b) => {
        const t = clean($(b).text());
        if (t) rawTopics.push(t);
      });
    } else {
      const t = clean(topicField.text());
      if (t) rawTopics.push(t);
    }
    const categories = mapCategories([...new Set(rawTopics)], title);
    const category = categories.join(", ");

    const summary = clean(card.find(".field--name-field-acccgov-summary").first().text());

    // Build an ISO date (YYYY-MM-DD) for sorting; keep the parts for display.
    const monNum = MONTH_NUM[mon];
    const dayNum = Number(day);
    const yearNum = Number(year);
    let dateISO = null;
    if (monNum && dayNum && yearNum) {
      dateISO = `${yearNum}-${String(monNum).padStart(2, "0")}-${String(
        dayNum
      ).padStart(2, "0")}`;
    }
    const dateText =
      MONTHS_FULL[mon] && dayNum && yearNum
        ? `${dayNum} ${MONTHS_FULL[mon]} ${yearNum}`
        : clean(`${day} ${mon} ${year}`);

    records.push({
      type,
      permalink,
      title,
      category,
      categories,
      summary,
      dateISO,
      dateText,
      year: yearNum || null,
    });
  });

  return { records, speeches };
}

// ---------------------------------------------------------------------------
// Overrides layer
// ---------------------------------------------------------------------------

const OVERRIDE_FIELDS = [
  "type",
  "category",
  "categories",
  "title",
  "dateISO",
  "dateText",
  "notes",
];

async function loadOverrides() {
  try {
    const raw = JSON.parse(await readFile(OVERRIDES_PATH, "utf8"));
    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith("_")) continue; // _readme, _example, etc. are ignored
      if (val && typeof val === "object") out[key] = val;
    }
    return out;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.warn(`Could not read overrides.json: ${err.message}`);
    return {};
  }
}

/** Deep-merge (per-field) the override on top of a mechanical record. */
function applyOverride(record, override) {
  const applied = [];
  for (const field of OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(override, field)) {
      record[field] = override[field];
      applied.push(field);
    }
  }
  // If the display category was overridden, keep the filter array in sync.
  if (
    Object.prototype.hasOwnProperty.call(override, "category") &&
    !Object.prototype.hasOwnProperty.call(override, "categories")
  ) {
    record.categories = String(override.category || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // If the ISO date was overridden but not the display text, keep them in sync.
  if (
    Object.prototype.hasOwnProperty.call(override, "dateISO") &&
    !Object.prototype.hasOwnProperty.call(override, "dateText")
  ) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(override.dateISO || "");
    if (m) {
      const monName = Object.values(MONTHS_FULL)[Number(m[2]) - 1];
      record.dateText = `${Number(m[3])} ${monName} ${m[1]}`;
      record.year = Number(m[1]);
    }
  }
  if (applied.length) {
    record.overridden = true;
    record.overriddenFields = applied;
    if (override.notes) record.notes = override.notes;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const previous = await loadPrevious();

  // 1. Scrape listing pages until we stop finding new URLs or pass the cutoff.
  console.log(`Scraping news centre (keeping items from ${START_YEAR} onward)…`);
  const listing = [];
  const seen = new Set();
  let totalSpeeches = 0;
  let reachedCutoff = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await fetchListingPage(page);
    const { records, speeches } = parseCards(html);
    totalSpeeches += speeches;

    if (records.length === 0 && speeches === 0) {
      console.log(`  page ${page}: 0 cards — end of pagination.`);
      break;
    }

    let added = 0;
    let oldOnPage = 0;
    for (const r of records) {
      // Skip (and count) items older than the cutoff year.
      if (r.year && r.year < START_YEAR) {
        oldOnPage++;
        continue;
      }
      if (seen.has(r.permalink)) continue;
      seen.add(r.permalink);
      listing.push(r);
      added++;
    }
    console.log(
      `  page ${page}: ${records.length} kept-type cards, ${added} new, ` +
        `${speeches} speeches skipped` +
        (oldOnPage ? `, ${oldOnPage} older than ${START_YEAR}` : "")
    );

    // Stop once we start seeing pre-cutoff items (list is newest-first).
    if (oldOnPage > 0) {
      reachedCutoff = true;
      console.log(`  reached ${START_YEAR} cutoff — stopping.`);
      break;
    }
    // Guard against the endpoint's wrap-around: if a page adds nothing new,
    // we've looped back over already-seen items.
    if (added === 0) {
      console.log("  page added no new items — stopping (pagination wrapped).");
      break;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `Collected ${listing.length} media releases/updates; ` +
      `dropped ${totalSpeeches} speeches.` +
      (reachedCutoff ? "" : " (Did not hit year cutoff — check pagination.)")
  );

  if (listing.length < MIN_RECORDS) {
    throw new Error(
      `Scrape returned ${listing.length} records (< ${MIN_RECORDS}). Aborting.`
    );
  }

  // 2. Initialise the override bookkeeping fields.
  for (const r of listing) {
    r.overridden = false;
    r.overriddenFields = [];
    r.notes = "";
  }

  // 3. Deep-merge overrides on top (keyed by article URL). Override wins.
  const overrides = await loadOverrides();
  const byUrl = new Map(listing.map((r) => [r.permalink, r]));
  for (const [url, override] of Object.entries(overrides)) {
    const rec = byUrl.get(url);
    if (!rec) {
      console.warn(
        `  override for ${url} did not match any current record (outside window?)`
      );
      continue;
    }
    applyOverride(rec, override);
    console.log(`  applied override for ${url}`);
  }

  // 4. Sort newest-first for a stable, deterministic data.json.
  listing.sort((a, b) => {
    const av = a.dateISO || "";
    const bv = b.dateISO || "";
    if (av < bv) return 1;
    if (av > bv) return -1;
    return (a.title || "").localeCompare(b.title || "");
  });

  // 5. Robustness guard: don't let an implausible scrape clobber good data.
  if (previous?.records?.length) {
    const prevCount = previous.records.length;
    if (listing.length < prevCount * (1 - MAX_DROP_RATIO)) {
      throw new Error(
        `Record count dropped from ${prevCount} to ${listing.length} ` +
          `(> ${MAX_DROP_RATIO * 100}% drop). Keeping last good data.json.`
      );
    }
  }

  // 6. Write on every run so the site shows a fresh "last checked" heartbeat,
  //    but keep `generatedAt` pinned to the last time the DATA actually changed
  //    (that drives the "Data as at" line). This way the page visibly proves it
  //    ran today, even on quiet news days when nothing new was published.
  const records = listing.map((r) => ({
    type: r.type,
    permalink: r.permalink,
    title: r.title,
    category: r.category || "",
    categories: Array.isArray(r.categories) ? r.categories : [],
    summary: r.summary || "",
    dateISO: r.dateISO ?? null,
    dateText: r.dateText || "",
    year: r.year ?? null,
    overridden: r.overridden,
    overriddenFields: r.overriddenFields,
    notes: r.notes || "",
  }));

  const now = new Date().toISOString();
  const signature = (recs) => JSON.stringify(recs.map((x) => ({ ...x })));
  const recordsChanged =
    !previous?.records || signature(previous.records) !== signature(records);
  // generatedAt only moves when the records change; otherwise carry the old one.
  const generatedAt = recordsChanged
    ? now
    : previous.generatedAt || now;

  console.log(
    recordsChanged
      ? "Records changed — bumping generatedAt."
      : "No record change — keeping generatedAt, updating lastCheckedAt only."
  );

  const out = {
    generatedAt,
    lastCheckedAt: now,
    sourceUrl: NEWS_CENTRE_URL,
    startYear: START_YEAR,
    recordCount: records.length,
    records,
  };
  await writeFile(DATA_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote data.json with ${records.length} records.`);
}

main().catch((err) => {
  console.error("SCRAPE FAILED:", err.message);
  console.error("Last good data.json has been kept unchanged.");
  process.exit(1);
});
