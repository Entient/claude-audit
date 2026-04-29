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

const cases = [
  // [model, in, out, cache_read, cache_write]
  ["claude-opus-4",         1_000_000, 200_000,  50_000, 100_000],
  ["claude-sonnet-4-5",     2_500_000, 800_000, 100_000,  20_000],
  ["claude-haiku-4-5",      5_000_000, 100_000,       0,       0],
  ["claude-haiku-3",          800_000,  50_000,       0,       0],
  ["claude-opus-3-5",         600_000, 120_000,  20_000,       0],
  ["claudeopus4",             100_000,  10_000,       0,       0], // dashes-stripped match
  ["unknown-model-xyz",       400_000,  80_000,       0,       0], // hits default
];

for (const [model, i, o, cr, cw] of cases) {
  const got = calcCost(model, i, o, cr, cw);
  const exp = legacyCalcCost(model, i, o, cr, cw);
  t(`calcCost parity: ${model}`, Math.abs(got - exp) < 1e-12, `got=${got} exp=${exp}`);
}

// ── 6. priceForModel match-logic preserved ──────────────────────────────────
t("priceForModel exact match: claude-haiku-3 → 0.25",      priceForModel("claude-haiku-3").in === 0.25);
t("priceForModel substring (no dashes): claudeopus4 → 15", priceForModel("claudeopus4").in === 15);
t("priceForModel default fallback for empty model",        priceForModel("").in === LEGACY_DEFAULT.in);
t("priceForModel default fallback for unknown",            priceForModel("zzz-unknown").in === LEGACY_DEFAULT.in);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
