/* ACCC Media Releases & Updates mirror — front-end
   Reads data.json (written by the scheduled scraper) and renders one section:
   a sortable, filterable table of media releases and updates. No framework,
   no build step.

   The summary stat rows double as filters: click a Type / Year / Category to
   filter the table below. Multiple selections combine (same category = OR,
   across categories = AND), and combine with the search box too. */

(function () {
  "use strict";

  const MONTHS_FULL = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // ---- formatting helpers ------------------------------------------------
  // Render an ISO date as "10 January 2024".
  function fmtDate(iso) {
    if (!iso || typeof iso !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    return `${Number(m[3])} ${MONTHS_FULL[Number(m[2]) - 1]} ${m[1]}`;
  }

  // e.g. "Thu, 23 July 2026, 10:54 am AEST"
  function fmtFullSydney(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "short",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
    } catch (e) {
      return d.toISOString();
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function typeClass(type) {
    return (type || "").toLowerCase().includes("update")
      ? "pill--update"
      : "pill--media";
  }

  // The individual topic badges for a record (falls back to splitting the
  // display string for older data.json without a categories array).
  function recordCategories(r) {
    if (Array.isArray(r.categories) && r.categories.length) return r.categories;
    if (r.category && r.category.trim())
      return r.category
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return [];
  }

  // ---- statistics --------------------------------------------------------
  function computeStats(records) {
    const stats = {
      total: records.length,
      type: { "Media Release": 0, Update: 0 },
      year: {},
      category: {},
    };
    for (const r of records) {
      if (r.type in stats.type) stats.type[r.type] += 1;
      else stats.type[r.type] = (stats.type[r.type] || 0) + 1;

      const y = r.year != null ? String(r.year) : "—";
      stats.year[y] = (stats.year[y] || 0) + 1;

      // Count each individual topic, so a multi-topic item feeds every one.
      for (const c of recordCategories(r)) {
        stats.category[c] = (stats.category[c] || 0) + 1;
      }
    }
    return stats;
  }

  // ---- stat cards (rows are clickable filters) ---------------------------
  function plainRow(k, v) {
    return `<div class="statrow"><span class="k">${esc(k)}</span><span class="v">${esc(
      v
    )}</span></div>`;
  }

  function facetRow(facet, value, label, count) {
    return `<div class="statrow selectable" role="button" tabindex="0" aria-pressed="false" data-facet="${esc(
      facet
    )}" data-value="${esc(value)}"><span class="k">${esc(
      label
    )}</span><span class="v">${esc(count)}</span></div>`;
  }

  function renderStats(stats, headlineLabel, stamp) {
    const groups = [];

    groups.push(`
      <div class="statgroup statgroup--headline">
        <h3>${esc(headlineLabel)}</h3>
        <div class="big">${stats.total}</div>
        <div class="sub">as at ${esc(stamp)}</div>
      </div>`);

    groups.push(`
      <div class="statgroup">
        <h3>By Type Of Release</h3>
        ${facetRow("type", "Media Release", "Media Release", stats.type["Media Release"] || 0)}
        ${facetRow("type", "Update", "Update", stats.type["Update"] || 0)}
      </div>`);

    // Years, newest first.
    const years = Object.keys(stats.year)
      .filter((y) => y !== "—")
      .sort((a, b) => Number(b) - Number(a));
    const yearRows = years.length
      ? years.map((y) => facetRow("year", y, y, stats.year[y])).join("")
      : plainRow("No dated items", "—");
    groups.push(`
      <div class="statgroup">
        <h3>By Year</h3>
        ${yearRows}
      </div>`);

    // Categories, by count desc then name. Only if there are any.
    const cats = Object.keys(stats.category).sort((a, b) => {
      const d = stats.category[b] - stats.category[a];
      return d !== 0 ? d : a.localeCompare(b);
    });
    if (cats.length) {
      const catRows = cats
        .map((c) => facetRow("category", c, c, stats.category[c]))
        .join("");
      groups.push(`
        <div class="statgroup statgroup--scroll">
          <h3>By Category</h3>
          <div class="statgroup__scrollbody">${catRows}</div>
        </div>`);
    }

    return `<div class="stats">${groups.join("")}</div>`;
  }

  // ---- table columns -----------------------------------------------------
  // Title sits in the far-left column; Date | Type | Category follow.
  function columns() {
    return [
      {
        key: "title",
        label: "Title",
        cls: "title-cell",
        sortVal: (r) => (r.title || "").toLowerCase(),
        cell: (r) => {
          const tag = r.overridden
            ? ` <span class="tag tag--manual" title="${esc(
                r.notes || "Manually adjusted"
              )}">manual</span>`
            : "";
          const link = r.permalink
            ? `<a href="${esc(r.permalink)}" rel="noopener" target="_blank">${esc(
                r.title || "(untitled)"
              )}</a>`
            : esc(r.title || "(untitled)");
          return link + tag;
        },
      },
      {
        key: "dateISO",
        label: "Date",
        cls: "nowrap",
        sortVal: (r) => r.dateISO || "",
        cell: (r) =>
          r.dateText
            ? esc(r.dateText)
            : fmtDate(r.dateISO) || '<span class="dash">—</span>',
      },
      {
        key: "type",
        label: "Type Of Release",
        cls: "nowrap",
        sortVal: (r) => (r.type || "").toLowerCase(),
        cell: (r) =>
          `<span class="pill ${typeClass(r.type)}">${esc(r.type || "—")}</span>`,
      },
      {
        key: "category",
        label: "Category",
        sortVal: (r) => (r.category || "").toLowerCase(),
        cell: (r) =>
          r.category ? esc(r.category) : '<span class="dash">—</span>',
      },
    ];
  }

  // ---- filtering ---------------------------------------------------------
  function recordMatches(r, filters) {
    if (filters.query) {
      const hay = [r.title, r.category, r.type, r.dateText]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(filters.query)) return false;
    }
    if (filters.type.size && !filters.type.has(r.type)) return false;
    if (filters.year.size && !filters.year.has(String(r.year))) return false;
    if (
      filters.category.size &&
      !recordCategories(r).some((c) => filters.category.has(c))
    )
      return false;
    return true;
  }

  function anyActive(filters) {
    return (
      filters.query ||
      filters.type.size ||
      filters.year.size ||
      filters.category.size
    );
  }

  // ---- table -------------------------------------------------------------
  function renderTable(sectionEl, host, records, filters) {
    const cols = columns();
    const state = { sortKey: "dateISO", dir: -1 };

    const thead = cols
      .map(
        (c, i) =>
          `<th data-i="${i}" aria-sort="none">${esc(
            c.label
          )}<span class="arrow">▲▼</span></th>`
      )
      .join("");

    host.innerHTML = `
      <div class="toolbar">
        <div class="search">
          <input type="search" placeholder="Filter media releases &amp; updates…" aria-label="Filter table" />
        </div>
        <button type="button" class="clear-filters" hidden>Clear filters ✕</button>
        <div class="count"></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${thead}</tr></thead>
          <tbody></tbody>
        </table>
      </div>`;

    const tbody = host.querySelector("tbody");
    const ths = host.querySelectorAll("thead th");
    const countEl = host.querySelector(".count");
    const searchEl = host.querySelector('input[type="search"]');
    const clearEl = host.querySelector(".clear-filters");

    function filtered() {
      let rows = records.filter((r) => recordMatches(r, filters));
      const col = cols.find((c) => c.key === state.sortKey) || cols[0];
      rows = rows.slice().sort((a, b) => {
        const va = col.sortVal(a);
        const vb = col.sortVal(b);
        if (va < vb) return -1 * state.dir;
        if (va > vb) return 1 * state.dir;
        // Tie-break: newest date, then title.
        const da = a.dateISO || "";
        const db = b.dateISO || "";
        if (da !== db) return da < db ? 1 : -1;
        return (a.title || "").localeCompare(b.title || "");
      });
      return rows;
    }

    function redraw() {
      const rows = filtered();
      countEl.textContent = `${rows.length} of ${records.length}`;
      clearEl.hidden = !anyActive(filters);
      if (!rows.length) {
        tbody.innerHTML = `<tr><td class="empty" colspan="${cols.length}">No matching items.</td></tr>`;
      } else {
        tbody.innerHTML = rows
          .map(
            (r) =>
              "<tr>" +
              cols
                .map(
                  (c) =>
                    `<td${c.cls ? ` class="${c.cls}"` : ""}>${c.cell(r)}</td>`
                )
                .join("") +
              "</tr>"
          )
          .join("");
      }
      ths.forEach((th) => {
        const c = cols[Number(th.dataset.i)];
        th.setAttribute(
          "aria-sort",
          c.key === state.sortKey
            ? state.dir === 1
              ? "ascending"
              : "descending"
            : "none"
        );
      });
    }

    ths.forEach((th) => {
      th.addEventListener("click", () => {
        const c = cols[Number(th.dataset.i)];
        if (state.sortKey === c.key) {
          state.dir *= -1;
        } else {
          state.sortKey = c.key;
          // Dates default newest-first; text columns A→Z.
          state.dir = c.key === "dateISO" ? -1 : 1;
        }
        redraw();
      });
    });

    let t;
    searchEl.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        filters.query = searchEl.value.trim().toLowerCase();
        redraw();
      }, 120);
    });

    clearEl.addEventListener("click", () => {
      filters.type.clear();
      filters.year.clear();
      filters.category.clear();
      filters.query = "";
      searchEl.value = "";
      sectionEl.querySelectorAll(".statrow.selectable.active").forEach((el) => {
        el.classList.remove("active");
        el.setAttribute("aria-pressed", "false");
      });
      redraw();
    });

    redraw();
    return { redraw };
  }

  // ---- section assembly --------------------------------------------------
  function renderSection(el, opts) {
    const { title, headlineLabel, records, generatedAt, lastCheckedAt } = opts;
    const stamp = fmtFullSydney(generatedAt);
    const checkedStamp = fmtFullSydney(lastCheckedAt || generatedAt);
    const stats = computeStats(records);
    const filters = {
      type: new Set(),
      year: new Set(),
      category: new Set(),
      query: "",
    };

    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `
      <h2>${esc(title)}</h2>
      <div class="headline">Total <strong>${esc(
        headlineLabel
      )}</strong> as at ${esc(stamp)}: <strong>${records.length}</strong></div>`;
    el.appendChild(head);

    const statsWrap = document.createElement("div");
    statsWrap.innerHTML = renderStats(stats, "Total " + headlineLabel, stamp);
    el.appendChild(statsWrap.firstElementChild);

    const tableHost = document.createElement("div");
    el.appendChild(tableHost);
    const table = renderTable(el, tableHost, records, filters);

    // Wire the clickable stat rows to the table's filter.
    el.querySelectorAll(".statrow.selectable").forEach((rowEl) => {
      const toggle = () => {
        const set = filters[rowEl.dataset.facet];
        const value = rowEl.dataset.value;
        if (set.has(value)) set.delete(value);
        else set.add(value);
        const on = set.has(value);
        rowEl.classList.toggle("active", on);
        rowEl.setAttribute("aria-pressed", on ? "true" : "false");
        table.redraw();
      };
      rowEl.addEventListener("click", toggle);
      rowEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });

    const asat = document.createElement("p");
    asat.className = "asat";
    asat.innerHTML =
      `Data as at <strong>${esc(stamp)}</strong> (Australia/Sydney). ` +
      `&nbsp;Last checked for new ACCC items: <strong>${esc(
        checkedStamp
      )}</strong>. Checked automatically each morning &amp; afternoon.`;
    el.appendChild(asat);
  }

  // ---- staleness ---------------------------------------------------------
  // Keyed off lastCheckedAt: this warns only if the updater itself seems to
  // have stopped (no successful check in over ~26h), NOT merely because the
  // ACCC hasn't published anything new. A quiet news day is not "stale".
  function checkStaleness(lastCheckedAt) {
    const banner = document.getElementById("staleness");
    const d = new Date(lastCheckedAt);
    if (isNaN(d)) return;
    const ageHours = (Date.now() - d.getTime()) / 3600000;
    if (ageHours > 26) {
      banner.textContent =
        "The automatic updater hasn't checked in over a day — the twice-daily refresh may have been delayed or paused. The data below is still the last good copy.";
      banner.hidden = false;
    }
  }

  // ---- boot --------------------------------------------------------------
  function fail(msg) {
    const err = document.getElementById("error");
    err.textContent = msg;
    err.hidden = false;
    const loading = document.getElementById("loading");
    if (loading) loading.hidden = true;
  }

  async function boot() {
    let data;
    try {
      const res = await fetch("data.json?_=" + Date.now(), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      fail(
        "Could not load news data (data.json). If this site was just set up, the update workflow may not have run yet."
      );
      return;
    }

    const loading = document.getElementById("loading");
    if (loading) loading.hidden = true;

    const records = Array.isArray(data.records) ? data.records : [];
    const generatedAt = data.generatedAt || new Date().toISOString();
    const lastCheckedAt = data.lastCheckedAt || generatedAt;

    renderSection(document.getElementById("section-news"), {
      title: "Media Releases & Updates",
      headlineLabel: "Media Releases & Updates",
      records,
      generatedAt,
      lastCheckedAt,
    });

    checkStaleness(lastCheckedAt);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();

/* Table zoom control — shrinks the table so more columns/rows fit.
   100% = current size (max); zooms out to 50%. */
(function () {
  "use strict";
  var MIN = 0.5,
    MAX = 1,
    STEP = 0.1,
    z = MAX;

  function apply() {
    document.documentElement.style.setProperty("--table-zoom", String(z));
    var lvl = document.getElementById("zoom-level");
    if (lvl) lvl.textContent = Math.round(z * 100) + "%";
    var zin = document.getElementById("zoom-in");
    var zout = document.getElementById("zoom-out");
    if (zin) zin.disabled = z >= MAX - 0.001;
    if (zout) zout.disabled = z <= MIN + 0.001;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var zin = document.getElementById("zoom-in");
    var zout = document.getElementById("zoom-out");
    if (zout)
      zout.addEventListener("click", function () {
        z = Math.max(MIN, Math.round((z - STEP) * 100) / 100);
        apply();
      });
    if (zin)
      zin.addEventListener("click", function () {
        z = Math.min(MAX, Math.round((z + STEP) * 100) / 100);
        apply();
      });
    apply();
  });
})();
