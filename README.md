# ACCC Media Releases & Updates — mirror

A self-updating static website that mirrors the ACCC
[**news centre**](https://www.accc.gov.au/news-centre) — its **media releases**
and **updates** (speeches are excluded) — in one sortable, filterable table.

- **No server, no database, no cost.** A scheduled GitHub Action scrapes the
  news centre, and commits `data.json`. GitHub Pages serves the static site,
  which just reads that JSON.
- Updates itself **twice daily**, plus a manual **Run workflow** button.

## How it works

```
┌─ GitHub Action (cron 2×/day + manual) ────────────────────────┐
│  scripts/scrape.mjs                                            │
│    1. fetch listing pages from the Drupal Views AJAX endpoint  │
│       (cheerio, plain HTTP — no headless browser)              │
│    2. keep Media releases + Updates, drop Speeches             │
│    3. stop at the START_YEAR cutoff (endpoint wraps forever)   │
│    4. deep-merge overrides.json on top                         │
│    5. write data.json  (only if the data changed)             │
│    6. guard: abort if the scrape looks broken → keep old data │
└───────────────────────────────────────────────────────────────┘
         │ commits data.json
         ▼
┌─ GitHub Pages (static) ───────────────────────────────────────┐
│  index.html + assets/  →  fetch('data.json')  →  render        │
└───────────────────────────────────────────────────────────────┘
```

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The page shell. |
| `assets/styles.css`, `assets/app.js` | Styling and the render/sort/filter logic. |
| `data.json` | The data the site reads. **Written by the Action — don't hand-edit.** |
| `overrides.json` | Manual corrections you maintain (see below). |
| `scripts/scrape.mjs` | The scraper + overrides pipeline. |
| `.github/workflows/update.yml` | The scheduled + manual workflow. |

## The table

One table with four columns:

- **Date** — rendered as `10 January 2024` (an ISO date is stored in `data.json`
  for sorting).
- **Type Of Release** — `Media Release` or `Update`.
- **Category** — the ACCC topic for the item.
- **Title** — hyperlinked to the ACCC article (opens in a new tab).

Above it, clickable summary stat cards: a headline total, plus **Type**,
**Year** and **Category** breakdowns. Clicking a stat filters the table.
Multiple selections combine (same card = OR, across cards = AND) and stack with
the search box. **Clear filters** resets them.

## The data source

The news-centre listing is loaded by Drupal Views AJAX; the items are **not** in
the page's raw HTML. The scraper hits the AJAX endpoint directly:

```
GET https://www.accc.gov.au/views/ajax
  ?view_name=news_centre&view_display_id=listing_search&type=&view_args=&page=N
  header: X-Requested-With: XMLHttpRequest
```

Notes:

- **`type` is left empty on purpose.** An empty `type` returns *all* news types
  mixed (media releases *and* updates). Sending `type=accc_news` returns only
  media releases and hides updates.
- The response is a JSON array of Drupal Ajax command objects; the listing
  markup is in the `insert` commands' `data` fields, parsed with cheerio.
- The endpoint **wraps past the end** (page 400 still returns cards), so the
  scraper stops when a page yields no new URLs, or when it reaches items older
  than the cutoff year.
- The ACCC's WAF rejects any User-Agent containing the word "bot", so the
  scraper uses a plain browser User-Agent. Keep it that way.

### Changing the year window

By default the scraper keeps items published in **2023 or later** (to match the
reference timelines). Change the default in `scripts/scrape.mjs` (`START_YEAR`),
or override per-run:

```bash
START_YEAR=2020 npm run scrape
```

## Editing `overrides.json`

`overrides.json` pins hand-adjusted values so the mechanical scrape can never
silently overwrite a known, deliberate correction.

- It is an object **keyed by the full article URL** (the permalink) exactly as
  it appears on the site.
- Any key starting with `_` (like `_readme`, `_example`) is **ignored**.
- For a URL key you may set any of: `type`, `category`, `title`, `dateISO`
  (`"YYYY-MM-DD"` — the display date auto-updates to match unless you also set
  `dateText`), `dateText`, `notes` (shown as a small **manual** tag on that row).
- **Pipeline order:** scrape → merge overrides on top, so whatever you set here
  always wins.

After editing, commit and push. The change appears the next time the Action runs
(or immediately if you press **Run workflow**).

## The schedule

Defined in `.github/workflows/update.yml`:

- `workflow_dispatch` — the **Run workflow** button in the **Actions** tab.
- Two cron entries. GitHub cron is **UTC** and can't express a timezone, so the
  Sydney times drift by an hour across daylight saving:
  - `0 21 * * *` → ~07:00 Sydney (08:00 during AEDT)
  - `0 9 * * *`  → ~19:00 Sydney (20:00 during AEDT)

> GitHub may delay or skip scheduled runs on free accounts when the platform is
> busy, and pauses schedules on repos with no activity for 60 days. If a run is
> missed, the next one catches up, or press **Run workflow**.

## Robustness

- The Action **won't commit a broken scrape**: it aborts (keeping the last good
  `data.json`) if the scrape errors, returns zero items, or the item count drops
  more than 20% versus the previous `data.json`.
- It **commits only when the data actually changed**, so `generatedAt` reflects
  the last real change. If the news centre is quiet for over ~24 hours the site
  shows a subtle amber "data may be delayed" note.

## Running the scraper locally (optional)

```bash
npm install
npm run scrape      # writes/updates data.json
```

Then open `index.html` via a small static server (needed because the page
`fetch`es `data.json`):

```bash
npx serve .         # or: python3 -m http.server
```
