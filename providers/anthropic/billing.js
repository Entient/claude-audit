"use strict";

/**
 * providers/anthropic/billing.js — V2 slice 1.
 *
 * Lift of fetchAnthropicUsage / fetchAnthropicCostReport / countTokens from
 * audit.js. Behavior must remain byte-identical: same endpoints, same auth
 * headers, same pagination cap, same response normalisation, same error
 * messages, same cost-calc multipliers (cache_read = 0.10x input,
 * cache_write = 1.25x input), same model match-logic.
 *
 * Slice 1 contract is intentionally narrow — only the three Anthropic-specific
 * network functions move. The setup wizard, config storage, reconciliation
 * join, hooks, and metering schema are untouched.
 */

const fs   = require("fs");
const path = require("path");

// ── Price table (loaded once from providers/prices.json) ────────────────────
//
// Lazy + cached. If the JSON cannot be read/parsed we fall back to the legacy
// hardcoded values so a corrupted file never breaks billing fetch.
//
// SHIP_CHECKLIST §7.4 / audit gap #4 (2026-04-29): the prior policy was to
// fall back to a Sonnet-tier `_DEFAULT` for unmatched model IDs. That
// silently underbills any future Anthropic SKU priced above Sonnet (e.g. an
// Opus successor) by treating it as Sonnet on the reconcile path. Policy
// change: unknown model → `priceForModel` returns null, `calcCost` returns
// `{ cost: null, unpriced: true, warning: "unpriced_model:<id>" }`, and
// `fetchUsage` excludes unpriced rows from totals while surfacing the gap
// via `unpricedModels` + `warnings` on the return shape. `_DEFAULT` and
// `LEGACY_DEFAULT` remain loaded for prices.json schema/parity-test
// continuity but are no longer consulted by the reconcile path.
let _PRICES = null;
let _DEFAULT = null;

const LEGACY_PRICES = {
  "claude-opus-4":         { in: 15,    out: 75   },
  "claude-sonnet-4":       { in: 3,     out: 15   },
  "claude-sonnet-4-5":     { in: 3,     out: 15   },
  "claude-haiku-4":        { in: 0.80,  out: 4    },
  "claude-haiku-4-5":      { in: 0.80,  out: 4    },
  "claude-opus-3-5":       { in: 15,    out: 75   },
  "claude-sonnet-3-5":     { in: 3,     out: 15   },
  "claude-haiku-3":        { in: 0.25,  out: 1.25 },
};
const LEGACY_DEFAULT = { in: 3, out: 15 };  // Dormant — not consulted by priceForModel.

function _loadPriceTable() {
  if (_PRICES !== null) return;
  try {
    const file = path.join(__dirname, "..", "prices.json");
    const raw  = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    const tab = {};
    for (const r of (data.rows || [])) {
      if (r.provider !== "anthropic") continue;
      tab[r.model] = { in: r.in, out: r.out };
    }
    _PRICES  = tab;
    _DEFAULT = (data.defaults && data.defaults.anthropic) || LEGACY_DEFAULT;
  } catch (_) {
    _PRICES  = { ...LEGACY_PRICES };
    _DEFAULT = LEGACY_DEFAULT;
  }
}

function priceForModel(modelId) {
  _loadPriceTable();
  for (const [k, v] of Object.entries(_PRICES)) {
    if (modelId && modelId.toLowerCase().includes(k.replace(/-/g, ""))) return v;
    if (modelId && modelId.toLowerCase().startsWith(k)) return v;
  }
  return null;  // Unknown model — no silent fallback. See header comment.
}

// Returns { cost, unpriced, model, warning? }.
//   Known model:   { cost: number, unpriced: false, model }
//   Unknown model: { cost: null,   unpriced: true,  model, warning: "unpriced_model:<id>" }
// Callers must check `unpriced` and exclude from totals when true.
function calcCost(model, inputTok, outputTok, cacheReadTok, cacheWriteTok) {
  const p = priceForModel(model);
  const modelLabel = model || "<empty>";
  if (p === null) {
    return {
      cost: null,
      unpriced: true,
      model: modelLabel,
      warning: `unpriced_model:${modelLabel}`,
    };
  }
  const inp  = (inputTok      || 0) / 1_000_000 * p.in;
  const out  = (outputTok     || 0) / 1_000_000 * p.out;
  const cr   = (cacheReadTok  || 0) / 1_000_000 * (p.in * 0.1);
  const cw   = (cacheWriteTok || 0) / 1_000_000 * (p.in * 1.25);
  return { cost: inp + out + cr + cw, unpriced: false, model: modelLabel };
}

// ── /v1/usage ───────────────────────────────────────────────────────────────

async function fetchUsage(apiKey, days = 30) {
  const https     = require("https");
  const since     = new Date(Date.now() - days * 86_400_000);
  const startDate = since.toISOString().slice(0, 10);

  const get = (url, headers) => new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });

  try {
    const headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    const allRows = [];
    let nextPage  = null;
    let page      = 0;

    do {
      const url = new URL("https://api.anthropic.com/v1/usage");
      url.searchParams.set("start_time", since.toISOString());
      if (nextPage) url.searchParams.set("after_id", nextPage);

      const res = await get(url.toString(), headers);

      if (res.status === 404 || res.status === 405) break;
      if (res.status === 401) {
        return { ok: false, error: "Invalid API key. Check ~/.entient-spend/config.json" };
      }
      if (res.status !== 200) {
        return { ok: false, error: `Anthropic API error ${res.status}: ${res.body.slice(0, 200)}` };
      }

      let data;
      try { data = JSON.parse(res.body); } catch (_) { break; }

      const rows = data.data || data.usage || data.results || [];
      allRows.push(...rows);
      nextPage = data.next_page || data.next_cursor || null;
      page++;
    } while (nextPage && page < 20);

    if (allRows.length === 0) {
      return { ok: false, error: "No usage data returned. Your API key may not have billing read access." };
    }

    const byDay = {};
    let totalCost = 0;
    const unpricedSet = new Set();

    for (const row of allRows) {
      const date = (row.date || row.timestamp || "").slice(0, 10);
      if (!date || date < startDate) continue;

      if (!byDay[date]) byDay[date] = { date, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {} };

      const inp = row.input_tokens || row.input || 0;
      const out = row.output_tokens || row.output || 0;
      const cr  = row.cache_read_input_tokens || 0;
      const cw  = row.cache_creation_input_tokens || 0;
      const model = row.model || "unknown";

      byDay[date].inputTokens += inp;
      byDay[date].outputTokens += out;
      byDay[date].cacheRead    += cr;
      byDay[date].cacheWrite   += cw;

      const result = calcCost(model, inp, out, cr, cw);
      if (result.unpriced) {
        // SHIP_CHECKLIST §7.4: do NOT silently price into totals. Track the
        // model so the reconcile surface can warn the operator that real
        // spend exists for it but pricing is unknown.
        unpricedSet.add(result.model);
        if (!byDay[date].models[model]) byDay[date].models[model] = { tokens: 0, cost: 0, unpriced: true };
        byDay[date].models[model].tokens += inp + out;
        byDay[date].models[model].unpriced = true;
        continue;
      }
      byDay[date].cost += result.cost;
      totalCost        += result.cost;

      if (!byDay[date].models[model]) byDay[date].models[model] = { tokens: 0, cost: 0 };
      byDay[date].models[model].tokens += inp + out;
      byDay[date].models[model].cost   += result.cost;
    }

    const days_arr = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
    const unpricedModels = Array.from(unpricedSet).sort();
    const warnings = unpricedModels.map(m => `unpriced_model:${m}`);
    return { ok: true, days: days_arr, totalCost, rowCount: allRows.length, unpricedModels, warnings };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── /v1/messages/count_tokens ───────────────────────────────────────────────

async function countTokens(apiKey, { model = "claude-sonnet-4-5", messages, system, tools }) {
  const https = require("https");
  if (!apiKey) return { ok: false, error: "No API key. Run: entient-spend setup" };
  if (!messages || !Array.isArray(messages)) {
    return { ok: false, error: "messages array is required" };
  }
  const body = JSON.stringify({
    model,
    messages,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
  });
  return new Promise(resolve => {
    const req = https.request("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, res => {
      let buf = "";
      res.on("data", d => buf += d);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, error: `HTTP ${res.statusCode}: ${buf.slice(0, 200)}` });
        }
        try {
          const parsed = JSON.parse(buf);
          resolve({ ok: true, input_tokens: parsed.input_tokens });
        } catch (e) { resolve({ ok: false, error: "Bad JSON: " + e.message }); }
      });
    });
    req.on("error", err => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

// ── /v1/organizations/cost_report ───────────────────────────────────────────

async function fetchCostReport(adminKey, days = 30) {
  const https = require("https");
  if (!adminKey) {
    return { ok: false, error: "No admin key. Run: entient-spend setup --admin" };
  }
  const since = new Date(Date.now() - days * 86_400_000);
  const startDate = since.toISOString().slice(0, 10);

  const get = (url, headers) => new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, res => {
      let body = ""; res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });

  try {
    const headers = {
      "x-api-key": adminKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", since.toISOString());

    const res = await get(url.toString(), headers);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Admin key rejected (need apikey_... or sk-ant-admin...)" };
    }
    if (res.status === 404) {
      return { ok: false, error: "cost_report endpoint unavailable for this org" };
    }
    if (res.status !== 200) {
      return { ok: false, error: `Admin API error ${res.status}: ${res.body.slice(0, 200)}` };
    }

    let data;
    try { data = JSON.parse(res.body); } catch (_) {
      return { ok: false, error: "Bad JSON from cost_report" };
    }

    const rows = data.data || [];
    const byDay = {};
    let totalCost = 0;
    for (const row of rows) {
      const date = (row.starting_at || row.date || "").slice(0, 10);
      if (!date || date < startDate) continue;
      const cost = parseFloat(row.amount?.value || row.cost || 0);
      byDay[date] = (byDay[date] || 0) + cost;
      totalCost += cost;
    }
    const byDayArr = Object.entries(byDay).map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { ok: true, totalCost, byDay: byDayArr, rowCount: rows.length, source: "admin_api" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  id: "anthropic",
  fetchUsage,
  fetchCostReport,
  countTokens,
  // Internals exposed for parity tests only — not part of the provider contract.
  _internals: { priceForModel, calcCost, LEGACY_PRICES, LEGACY_DEFAULT },
};
