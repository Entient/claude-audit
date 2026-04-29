#!/usr/bin/env node
// V2 slice 1 parity tests. Loader + Anthropic plugin shape + price-table
// equivalence + cost-calc equivalence vs. the legacy hardcoded table.
// No network: fetchUsage / fetchCostReport / countTokens are not invoked.
// Run: node test_providers_anthropic.js

"use strict";

const fs       = require("fs");
const path     = require("path");
const { loadProvider, listProviders } = require("./providers");
const audit    = require("./audit.js");
const ap       = loadProvider("anthropic");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. Loader registry ──────────────────────────────────────────────────────

t("listProviders returns ['anthropic']",
  Array.isArray(listProviders()) && listProviders().length === 1 && listProviders()[0] === "anthropic");

t("loadProvider('anthropic') returns the plugin",
  ap && ap.id === "anthropic");

let threw = false;
try { loadProvider("openai"); } catch (_) { threw = true; }
t("loadProvider throws on unknown id", threw);

// ── 2. Plugin shape ─────────────────────────────────────────────────────────

t("plugin exports fetchUsage",      typeof ap.fetchUsage      === "function");
t("plugin exports fetchCostReport", typeof ap.fetchCostReport === "function");
t("plugin exports countTokens",     typeof ap.countTokens     === "function");

// ── 3. audit.js wrappers still exist with the legacy names ─────────────────
// (Tested via module-load — wrappers are not exported, but importing audit.js
// must not throw, and reconcile/buildFixtureExport must still work.)
t("audit.js still exports reconcile",           typeof audit.reconcile          === "function");
t("audit.js still exports buildFixtureExport",  typeof audit.buildFixtureExport === "function");
t("audit.js still exports loadMeteringRows",    typeof audit.loadMeteringRows   === "function");

// ── 4. Price-table parity vs. legacy hardcoded values ──────────────────────
// The legacy table is preserved inside the plugin as LEGACY_PRICES; the
// loader-fed table comes from providers/prices.json. They must match
// row-for-row for the SKUs the legacy code knew about.
const { priceForModel, calcCost, LEGACY_PRICES, LEGACY_DEFAULT } = ap._internals;

const pricesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "providers", "prices.json"), "utf8"));
const jsonByModel = {};
for (const r of pricesJson.rows) {
  if (r.provider === "anthropic") jsonByModel[r.model] = { in: r.in, out: r.out };
}

for (const [model, legacy] of Object.entries(LEGACY_PRICES)) {
  const j = jsonByModel[model];
  t(`prices.json row for ${model} matches legacy in`,  j && j.in  === legacy.in);
  t(`prices.json row for ${model} matches legacy out`, j && j.out === legacy.out);
}
t("prices.json default matches legacy default in",  pricesJson.defaults.anthropic.in  === LEGACY_DEFAULT.in);
t("prices.json default matches legacy default out", pricesJson.defaults.anthropic.out === LEGACY_DEFAULT.out);

// ── 5. Cost-calc parity on a synthetic row ──────────────────────────────────
// Reproduce the legacy in-place calcCost from audit.js (line 152-159 pre-extraction)
// and compare against the plugin's calcCost.
function legacyCalcCost(model, inputTok, outputTok, cacheReadTok, cacheWriteTok) {
  // Legacy in-line resolver, copied verbatim from the pre-extraction audit.js.
  const PRICES = {
    "claude-opus-4":         { in: 15,    out: 75   },
    "claude-sonnet-4":       { in: 3,     out: 15   },
    "claude-sonnet-4-5":     { in: 3,     out: 15   },
    "claude-haiku-4":        { in: 0.80,  out: 4    },
    "claude-haiku-4-5":      { in: 0.80,  out: 4    },
    "claude-opus-3-5":       { in: 15,    out: 75   },
    "claude-sonnet-3-5":     { in: 3,     out: 15   },
    "claude-haiku-3":        { in: 0.25,  out: 1.25 },
    "default":               { in: 3,     out: 15   },
  };
  function priceFor(modelId) {
    for (const [k, v] of Object.entries(PRICES)) {
      if (k !== "default" && modelId && modelId.toLowerCase().includes(k.replace(/-/g, ""))) return v;
      if (k !== "default" && modelId && modelId.toLowerCase().startsWith(k)) return v;
    }
    return PRICES["default"];
  }
  const p = priceFor(model);
  const inp  = (inputTok      || 0) / 1_000_000 * p.in;
  const out  = (outputTok     || 0) / 1_000_000 * p.out;
  const cr   = (cacheReadTok  || 0) / 1_000_000 * (p.in * 0.1);
  const cw   = (cacheWriteTok || 0) / 1_000_000 * (p.in * 1.25);
  return inp + out + cr + cw;
}

// SHIP_CHECKLIST §7.4: parity loop covers KNOWN models only. Unknown models
// no longer compare to legacyCalcCost (which silently fell back to Sonnet);
// they get their own assertions further down.
const cases = [
  // [model, in, out, cache_read, cache_write]
  ["claude-opus-4",         1_000_000, 200_000,  50_000, 100_000],
  ["claude-sonnet-4-5",     2_500_000, 800_000, 100_000,  20_000],
  ["claude-haiku-4-5",      5_000_000, 100_000,       0,       0],
  ["claude-haiku-3",          800_000,  50_000,       0,       0],
  ["claude-opus-3-5",         600_000, 120_000,  20_000,       0],
  ["claudeopus4",             100_000,  10_000,       0,       0], // dashes-stripped match
];

for (const [model, i, o, cr, cw] of cases) {
  const got = calcCost(model, i, o, cr, cw);
  const exp = legacyCalcCost(model, i, o, cr, cw);
  t(`calcCost parity: ${model}`,
    got && got.unpriced === false && Math.abs(got.cost - exp) < 1e-12,
    `got=${JSON.stringify(got)} exp=${exp}`);
}

// ── 6. priceForModel match-logic preserved for known SKUs ───────────────────
t("priceForModel exact match: claude-haiku-3 → 0.25",      priceForModel("claude-haiku-3").in === 0.25);
t("priceForModel substring (no dashes): claudeopus4 → 15", priceForModel("claudeopus4").in === 15);

// ── 7. SHIP_CHECKLIST §7.4 — unpriced model handling (no silent fallback) ───
t("priceForModel returns null for empty model",     priceForModel("") === null);
t("priceForModel returns null for unknown model",   priceForModel("zzz-unknown") === null);
t("priceForModel returns null for null input",      priceForModel(null) === null);
t("priceForModel returns null for undefined input", priceForModel(undefined) === null);

const unkResult = calcCost("zzz-unknown", 400_000, 80_000, 0, 0);
t("calcCost unknown model: cost is null",           unkResult.cost === null);
t("calcCost unknown model: unpriced flag is true",  unkResult.unpriced === true);
t("calcCost unknown model: model echoed",           unkResult.model === "zzz-unknown");
t("calcCost unknown model: warning shape",          unkResult.warning === "unpriced_model:zzz-unknown");

const emptyResult = calcCost("", 100, 100, 0, 0);
t("calcCost empty model: cost is null",             emptyResult.cost === null);
t("calcCost empty model: unpriced flag is true",    emptyResult.unpriced === true);
t("calcCost empty model: warning labels <empty>",   emptyResult.warning === "unpriced_model:<empty>");

const knownResult = calcCost("claude-haiku-3", 800_000, 50_000, 0, 0);
t("calcCost known model: cost is finite number",
  knownResult.cost !== null && typeof knownResult.cost === "number" && Number.isFinite(knownResult.cost));
t("calcCost known model: unpriced flag is false",   knownResult.unpriced === false);
t("calcCost known model: no warning emitted",       knownResult.warning === undefined);

// ── 8. SHIP_CHECKLIST §7.5 — pagination safety cap surface ─────────────────
// Verifies the truncated / pages_fetched / hint return shape and the
// pagination_truncated warning. Mocks https.request so no real network.
const https = require("https");
const origRequest = https.request;
const { MAX_USAGE_PAGES } = ap._internals;

t("MAX_USAGE_PAGES exposed on _internals",
  typeof MAX_USAGE_PAGES === "number" && MAX_USAGE_PAGES === 100);

function mockHttps(pages) {
  let idx = 0;
  https.request = function (_url, _opts, cb) {
    const i = idx++;
    const page = pages[i] || { rows: [], next_page: null };
    const body = JSON.stringify({
      data: page.rows || [],
      next_page: page.next_page || null,
    });
    return {
      on: () => {},
      end: () => {
        setImmediate(() => {
          cb({
            statusCode: 200,
            on(event, h) {
              if (event === "data") setImmediate(() => h(body));
              else if (event === "end") setImmediate(h);
            },
          });
        });
      },
    };
  };
}
function restoreHttps() { https.request = origRequest; }

const today = new Date().toISOString().slice(0, 10);
function mkRow() {
  return { date: today, model: "claude-haiku-3", input_tokens: 1000, output_tokens: 500 };
}

(async () => {
  // ── Case A: no truncation ────────────────────────────────────────────────
  mockHttps([
    { rows: [mkRow()], next_page: "p2" },
    { rows: [mkRow()], next_page: "p3" },
    { rows: [mkRow()], next_page: null },
  ]);
  const aRes = await ap.fetchUsage("dummy-key", 7);
  restoreHttps();

  t("no-trunc: ok=true",          aRes.ok === true);
  t("no-trunc: truncated=false",  aRes.truncated === false);
  t("no-trunc: pages_fetched=3",  aRes.pages_fetched === 3);
  t("no-trunc: hint=null",        aRes.hint === null);
  t("no-trunc: no pagination_truncated warning",
    Array.isArray(aRes.warnings) && aRes.warnings.every(w => !w.startsWith("pagination_truncated")));

  // ── Case B: cap hit ──────────────────────────────────────────────────────
  // Feed 101 pages, every page sets next_page so the loop only exits via cap.
  const bigPages = [];
  for (let i = 0; i < 101; i++) {
    bigPages.push({ rows: [mkRow()], next_page: `p${i + 1}` });
  }
  mockHttps(bigPages);
  const bRes = await ap.fetchUsage("dummy-key", 7);
  restoreHttps();

  t("cap-hit: ok=true",                       bRes.ok === true);
  t("cap-hit: truncated=true",                bRes.truncated === true);
  t("cap-hit: pages_fetched=MAX_USAGE_PAGES", bRes.pages_fetched === MAX_USAGE_PAGES);
  t("cap-hit: hint is non-empty string",
    typeof bRes.hint === "string" && bRes.hint.length > 0);
  t("cap-hit: hint starts with expected prefix",
    typeof bRes.hint === "string" && bRes.hint.startsWith("Usage results hit the pagination safety cap"));
  t("cap-hit: warnings includes pagination_truncated entry",
    Array.isArray(bRes.warnings) && bRes.warnings.some(w => w.startsWith("pagination_truncated:max_pages=100")));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n  ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
