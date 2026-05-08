#!/usr/bin/env node
// Pure-function tests for reconcile attribution helpers. No I/O, no subprocess.
// Run: node test_reconcile_attribution.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  attributeInvoiceWindow,
  buildFixtureExport,
  computeResidualCoverage,
  loadMeteringRows,
  normalizeUsdToCents,
  centsToUsd,
} = require("./audit.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Aggregated metering rows in the shape loadMeteringRows() produces.
const sampleRows = [
  { d: '2026-04-20', h: '14', model: 'claude-sonnet-4-6', tool_id: 'entient_intercept',       tenant_id: 'default',       request_category: 'mcp_tool',  tok: 50000,  cost: 0.50, calls: 10,  first_t: '14:01', last_t: '14:55' },
  { d: '2026-04-22', h: '09', model: 'claude-sonnet-4-6', tool_id: 'entient_intercept',       tenant_id: 'default',       request_category: 'mcp_tool',  tok: 800000, cost: 8.00, calls: 120, first_t: '09:03', last_t: '09:59' },
  { d: '2026-04-22', h: '15', model: 'claude-haiku-4-5',  tool_id: 'entient_status',          tenant_id: 'beta-customer', request_category: 'mcp_tool',  tok: 50000,  cost: 0.10, calls: 30,  first_t: '15:11', last_t: '15:42' },
  { d: '2026-04-23', h: '10', model: 'claude-sonnet-4-6', tool_id: 'entient_certify_session', tenant_id: 'default',       request_category: 'mcp_tool',  tok: 200000, cost: 2.00, calls: 40,  first_t: '10:00', last_t: '10:30' },
  { d: '2026-04-25', h: '08', model: 'claude-sonnet-4-6', tool_id: 'entient_intercept',       tenant_id: 'default',       request_category: 'mcp_tool',  tok: 300000, cost: 3.00, calls: 60,  first_t: '08:05', last_t: '08:50' },
];

// SHIP_CHECKLIST 7.6: cent-normalized rows in the shape loadMeteringRows()
// now emits. Dollar fields remain for display compatibility only.
const centRows = [
  { d: '2026-04-22', h: '09', model: 'claude-sonnet-4-6', tool_id: 'a', tenant_id: 'default', request_category: 'mcp_tool', tok: 1, cost: 0.10, cost_cents: 10, calls: 1, first_t: '09:00', last_t: '09:01' },
  { d: '2026-04-22', h: '10', model: 'claude-sonnet-4-6', tool_id: 'a', tenant_id: 'default', request_category: 'mcp_tool', tok: 1, cost: 0.20, cost_cents: 20, calls: 1, first_t: '10:00', last_t: '10:01' },
  { d: '2026-04-22', h: '11', model: 'claude-sonnet-4-6', tool_id: 'b', tenant_id: 'default', request_category: 'mcp_tool', tok: 1, cost: 0.335, cost_cents: 34, calls: 1, first_t: '11:00', last_t: '11:01' },
];

// ── cent helpers: deterministic normalization/display ───────────────────────
{
  t("normalize 0.335 dollars -> 34 cents",    normalizeUsdToCents(0.335) === 34);
  t("normalize string dollars -> cents",      normalizeUsdToCents("12.345") === 1235);
  t("centsToUsd 1235 -> 12.35",               centsToUsd(1235) === 12.35);
}

// ── attributeInvoiceWindow: cent fields drive sums, avoiding drift ───────────
{
  const att = attributeInvoiceWindow('2026-04-22', centRows, 0);
  const toolA = att.topTools.find(x => x.name === 'a');
  t("cent rows totalCostCents = 64",           att.totalCostCents === 64);
  t("cent rows totalCost = 0.64",              att.totalCost === 0.64);
  t("0.10 + 0.20 cents sum has no float drift", toolA.cost === 0.30);
  t("topTools preserve integer cost_cents",    toolA.cost_cents === 30);
}

// ── attributeInvoiceWindow: 3-day window picks up two days ───────────────────
{
  const att = attributeInvoiceWindow('2026-04-22', sampleRows, 3);
  t("attribute returns object",                att !== null);
  t("coverage is tracked",                     att.coverage === 'tracked');
  t("totalCost = 0.50 + 8.00 + 0.10 = 8.60",   Math.abs(att.totalCost - 8.60) < 1e-6);
  t("totalCalls = 10 + 120 + 30 = 160",        att.totalCalls === 160);
  t("totalTokens = 50000 + 800000 + 50000",    att.totalTokens === 900000);
  t("topTools first is entient_intercept",     att.topTools[0].name === 'entient_intercept');
  t("topTools entient_intercept cost = 8.50",  Math.abs(att.topTools[0].cost - 8.50) < 1e-6);
  t("topTools entient_intercept tokens 850k",  att.topTools[0].tokens === 850000);
  t("topTools 2 distinct in window",           att.topTools.length === 2);
  t("topTenants includes beta-customer",       att.topTenants.some(x => x.name === 'beta-customer'));
  t("topModels has 2 distinct",                att.topModels.length === 2);
  t("timeWindow date is invoice day",          att.timeWindow && att.timeWindow.date === '2026-04-22');
  t("timeWindow first 09:03",                  att.timeWindow.first === '09:03');
  t("timeWindow last 15:42",                   att.timeWindow.last === '15:42');
  t("rangeEnd is invoice date",                att.rangeEnd === '2026-04-22');
  t("rangeStart is invoice - 3d",              att.rangeStart === '2026-04-19');
}

// ── attributeInvoiceWindow: window with no activity → coverage 'none' ────────
{
  const att = attributeInvoiceWindow('2026-01-01', sampleRows, 3);
  t("empty window coverage none",              att.coverage === 'none');
  t("empty window totalCost 0",                att.totalCost === 0);
  t("empty window topTools []",                att.topTools.length === 0);
  t("empty window topTenants []",              att.topTenants.length === 0);
  t("empty window timeWindow null",            att.timeWindow === null);
  t("empty window rangeStart present",         att.rangeStart === '2025-12-29');
  t("empty window rangeEnd present",           att.rangeEnd === '2026-01-01');
}

// ── attributeInvoiceWindow: 7-day window picks up further activity ───────────
{
  const att = attributeInvoiceWindow('2026-04-25', sampleRows, 7);
  t("7d window picks up all rows by calls",    att.totalCalls === 260);
  const totalToolsCost = att.topTools.reduce((s, x) => s + x.cost, 0);
  t("7d window topTools cost ≈ 13.60",         Math.abs(totalToolsCost - 13.60) < 1e-6);
  t("7d window distinct tools = 3",            att.topTools.length === 3);
}

// ── attributeInvoiceWindow: invalid date inputs ──────────────────────────────
{
  t("null date → null",                        attributeInvoiceWindow(null, sampleRows, 3) === null);
  t("garbage date → null",                     attributeInvoiceWindow('not-a-date', sampleRows, 3) === null);
  t("undefined date → null",                   attributeInvoiceWindow(undefined, sampleRows, 3) === null);
}

// ── attributeInvoiceWindow: timeWindow restricted to invoice day ─────────────
{
  // Invoice on 2026-04-23. 3d window pulls 2026-04-20 (10 calls 14:01-14:55)
  // and 2026-04-22 (09:03-15:42). timeWindow MUST only reflect 2026-04-23.
  const att = attributeInvoiceWindow('2026-04-23', sampleRows, 3);
  t("timeWindow date is invoice day only",     att.timeWindow.date === '2026-04-23');
  t("timeWindow first 10:00",                  att.timeWindow.first === '10:00');
  t("timeWindow last 10:30",                   att.timeWindow.last === '10:30');
}

// ── attributeInvoiceWindow: window covers prior days, invoice day empty ──────
{
  // 2026-04-21 has zero rows, but window pulls 2026-04-20.
  const att = attributeInvoiceWindow('2026-04-21', sampleRows, 3);
  t("partial window coverage tracked",         att.coverage === 'tracked');
  t("partial window timeWindow null",          att.timeWindow === null);
  t("partial window totalCalls = 10",          att.totalCalls === 10);
}

// ── attributeInvoiceWindow: default windowDays = 3 when omitted ──────────────
{
  const a3 = attributeInvoiceWindow('2026-04-22', sampleRows);
  const b3 = attributeInvoiceWindow('2026-04-22', sampleRows, 3);
  t("default windowDays equals explicit 3",    a3.totalCost === b3.totalCost && a3.totalCalls === b3.totalCalls);
}

// ── attributeInvoiceWindow: tools sorted by cost descending ──────────────────
{
  const att = attributeInvoiceWindow('2026-04-25', sampleRows, 7);
  for (let i = 1; i < att.topTools.length; i++) {
    t(`topTools[${i-1}].cost >= topTools[${i}].cost`,
      att.topTools[i-1].cost >= att.topTools[i].cost);
  }
}

// ── buildFixtureExport: empty rows yields empty export ───────────────────────
{
  const ex = buildFixtureExport([]);
  t("fixture empty has synthetic flag",        ex.synthetic === true);
  t("fixture empty invoices []",               ex.anthropic.invoices.length === 0);
  t("fixture empty dailyUsage []",             ex.anthropic.dailyUsage.length === 0);
  t("fixture empty exported_at string",        typeof ex.exported_at === 'string');
}

// ── buildFixtureExport: anchored on real activity dates ──────────────────────
{
  const ex = buildFixtureExport(sampleRows);
  t("fixture has synthetic flag",              ex.synthetic === true);
  t("fixture has at least one invoice",        ex.anthropic.invoices.length >= 1);
  t("fixture invoice has date",                !!ex.anthropic.invoices[0].date);
  t("fixture invoice anchor date in rows",     sampleRows.some(r => r.d === ex.anthropic.invoices[0].date));
  t("fixture invoice has numeric amount",      typeof ex.anthropic.invoices[0].amount === 'number');
  t("fixture invoice amount > 0",              ex.anthropic.invoices[0].amount > 0);
  t("fixture invoice status synthetic",        ex.anthropic.invoices[0].status === 'synthetic');
  t("fixture invoice id pattern",              /^synth-inv-\d{3}$/.test(ex.anthropic.invoices[0].id));
  t("fixture dailyUsage non-empty",            ex.anthropic.dailyUsage.length > 0);
}

// ── buildFixtureExport: invoice cap and uniqueness ───────────────────────────
{
  const ex = buildFixtureExport(sampleRows);
  t("fixture invoices ≤ 6",                    ex.anthropic.invoices.length <= 6);
  const dates = ex.anthropic.invoices.map(i => i.date);
  t("fixture invoice dates unique",            new Set(dates).size === dates.length);
}

// ── computeResidualCoverage: SHIP_CHECKLIST §7.7 — per-invoice residual ──────
// Pure helper. Threshold is strict >5% on raw pct; warning string carries
// the rounded (1-decimal) pct. Negative residual never warns. Synthetic
// fixture suppresses warning but the numeric output is unchanged.

// 5.0% residual: at the strict-> boundary, no warning.
{
  const r = computeResidualCoverage(100, 95);
  t("residual 5.0%: residual_amt = 5",        Math.abs(r.residual_amt - 5) < 1e-9);
  t("residual 5.0%: residual_pct = 5",        r.residual_pct === 5);
  t("residual 5.0%: warning is null (>5 strict)", r.warning === null);
}

// 5.1% residual: just over boundary, warning present with rounded pct.
{
  const r = computeResidualCoverage(100, 94.9);
  t("residual 5.1%: residual_pct = 5.1",      r.residual_pct === 5.1);
  t("residual 5.1%: warning = RESIDUAL_HIGH:5.1", r.warning === "RESIDUAL_HIGH:5.1");
}

// Reconcile comparison uses cents, so 0.1 + 0.2 cannot create a false residual.
{
  const att = attributeInvoiceWindow('2026-04-22', centRows.slice(0, 2), 0);
  const r = computeResidualCoverage(0.30, att.totalCost);
  t("cent residual compare: 0.30 - (0.10+0.20) = 0 cents", r.residual_cents === 0);
  t("cent residual compare: no warning",       r.warning === null);
  t("display still renders dollars with toFixed at boundary", `$${att.totalCost.toFixed(2)}` === "$0.30");
}

// 50% residual: warning fires with integer-display pct (no trailing .0).
{
  const r = computeResidualCoverage(100, 50);
  t("residual 50%: residual_amt = 50",        r.residual_amt === 50);
  t("residual 50%: residual_pct = 50",        r.residual_pct === 50);
  t("residual 50%: warning = RESIDUAL_HIGH:50", r.warning === "RESIDUAL_HIGH:50");
}

// Negative residual (over-attribution / discount): renders, never warns.
{
  const r = computeResidualCoverage(100, 150);
  t("negative residual: residual_amt = -50",  r.residual_amt === -50);
  t("negative residual: residual_pct = -50",  r.residual_pct === -50);
  t("negative residual: no warning",          r.warning === null);
}

// invoiceAmount null → cannot compute, returns null.
{
  t("invoiceAmount null → null",              computeResidualCoverage(null, 50) === null);
  t("invoiceAmount undefined → null",         computeResidualCoverage(undefined, 50) === null);
}

// invoiceAmount 0 → cannot compute (would div-by-zero), returns null.
{
  t("invoiceAmount 0 → null",                 computeResidualCoverage(0, 50) === null);
}

// attributedTotal null/undefined → treated as 0; full invoice is residual.
{
  const rNull = computeResidualCoverage(100, null);
  t("attributedTotal null → residual_amt = 100", rNull.residual_amt === 100);
  t("attributedTotal null → residual_pct = 100", rNull.residual_pct === 100);
  t("attributedTotal null → warning RESIDUAL_HIGH:100",
    rNull.warning === "RESIDUAL_HIGH:100");

  const rUndef = computeResidualCoverage(100, undefined);
  t("attributedTotal undefined → residual_amt = 100", rUndef.residual_amt === 100);
  t("attributedTotal undefined → warning RESIDUAL_HIGH:100",
    rUndef.warning === "RESIDUAL_HIGH:100");
}

// Synthetic fixture: numeric output unchanged, warning suppressed.
{
  const live  = computeResidualCoverage(100, 50, { synthetic: false });
  const synth = computeResidualCoverage(100, 50, { synthetic: true });
  t("synthetic=false: warning fires",         live.warning === "RESIDUAL_HIGH:50");
  t("synthetic=true: residual_amt unchanged", synth.residual_amt === 50);
  t("synthetic=true: residual_pct unchanged", synth.residual_pct === 50);
  t("synthetic=true: warning suppressed",     synth.warning === null);
}

// ── Summary ──────────────────────────────────────────────────────────────────
// loadMeteringRows normalizes cost_usd at the SQLite read boundary.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entient-spend-metering-"));
  const dbPath = path.join(dir, "metering.db");
  const py = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("""CREATE TABLE usage (
  timestamp_utc TEXT, model TEXT, tool_id TEXT, tenant_id TEXT,
  request_category TEXT, total_tokens INTEGER, cost_usd REAL, cached INTEGER
)""")
rows = [
  ("2026-04-22T09:00:00Z", "claude-haiku-3", "tool", "tenant", "mcp_tool", 1, 0.10, 0),
  ("2026-04-22T09:01:00Z", "claude-haiku-3", "tool", "tenant", "mcp_tool", 1, 0.20, 0),
  ("2026-04-22T09:02:00Z", "claude-haiku-3", "tool", "tenant", "mcp_tool", 1, 0.335, 0),
]
conn.executemany("INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)", rows)
conn.commit()
`;
  const created = spawnSync("python", ["-c", py, dbPath], { encoding: "utf8" });
  const rows = created.status === 0 ? loadMeteringRows(dbPath) : [];
  t("loadMeteringRows fixture created", created.status === 0, created.stderr);
  t("loadMeteringRows emits one aggregate row", rows.length === 1);
  t("loadMeteringRows sums rounded integer cents", rows[0] && rows[0].cost_cents === 64);
  t("loadMeteringRows dollar field derives from cents", rows[0] && rows[0].cost === 0.64);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Summary
console.log("");
if (fail > 0) {
  console.log(`FAILED  ${fail} of ${pass + fail}`);
  process.exit(1);
} else {
  console.log(`OK  ${pass} tests`);
}
