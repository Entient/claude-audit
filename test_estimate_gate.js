#!/usr/bin/env node
// SHIP_CHECKLIST §7.8 — focused tests for the --estimate rendering fence.
// Covers parseArgs, fmtEstUsd helper, ADVISORY_ESTIMATE_BANNER constant, and
// billingReport header rename + default-vs-estimate visible-output deltas.
// No network, no metering.db dependency. Run: node test_estimate_gate.js

"use strict";

const audit = require("./audit.js");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. parseArgs threads --estimate through opts ─────────────────────────────
{
  const orig = process.argv.slice();
  process.argv = ["node", "audit.js", "reconcile", "--estimate"];
  const opts = audit.parseArgs();
  process.argv = orig;
  t("--estimate parses to opts.estimate=true", opts.estimate === true);
  t("command still parses to reconcile",       opts.command === "reconcile");
}
{
  const orig = process.argv.slice();
  process.argv = ["node", "audit.js", "reconcile"];
  const opts = audit.parseArgs();
  process.argv = orig;
  t("no --estimate flag: opts.estimate falsy", !opts.estimate);
}
{
  const orig = process.argv.slice();
  process.argv = ["node", "audit.js", "billing", "--last", "30d", "--estimate"];
  const opts = audit.parseArgs();
  process.argv = orig;
  t("--estimate parses with billing + --last", opts.estimate === true && opts.command === "billing" && opts.last === "30d");
}

// ── 2. fmtEstUsd: render contract ────────────────────────────────────────────
{
  t("isEstimate=true: $X.XX rendered (default 2 decimals)",
    audit.fmtEstUsd(12.345, true) === "$12.35");
  t("isEstimate=true: integer renders with .00",
    audit.fmtEstUsd(12, true) === "$12.00");
  t("isEstimate=true, custom decimals=4",
    audit.fmtEstUsd(0.123456, true, "—", 4) === "$0.1235");
  t("isEstimate=true: null amount → '$?.??'",
    audit.fmtEstUsd(null, true) === "$?.??");
  t("isEstimate=true: undefined amount → '$?.??'",
    audit.fmtEstUsd(undefined, true) === "$?.??");
  t("isEstimate=false: explicit fallback used",
    audit.fmtEstUsd(12.34, false, "1.2k tok") === "1.2k tok");
  t("isEstimate=false, no fallback: '—'",
    audit.fmtEstUsd(12.34, false) === "—");
  t("isEstimate=false, amount irrelevant: fallback wins",
    audit.fmtEstUsd(99999, false, "X") === "X");
}

// ── 3. ADVISORY_ESTIMATE_BANNER content ──────────────────────────────────────
t("banner is a non-empty string",            typeof audit.ADVISORY_ESTIMATE_BANNER === "string" && audit.ADVISORY_ESTIMATE_BANNER.length > 0);
t("banner mentions 'estimate only'",         /estimate only/i.test(audit.ADVISORY_ESTIMATE_BANNER));
t("banner mentions ±10–15% drift",           /±10[–-]15%/.test(audit.ADVISORY_ESTIMATE_BANNER));
t("banner mentions 'cost-report' for truth", /entient-spend cost-report/.test(audit.ADVISORY_ESTIMATE_BANNER));

// ── 4. billingReport header rename + visibility deltas ───────────────────────
function captureStdout(fn) {
  const origWrite = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = chunk => { buf += String(chunk); return true; };
  try { fn(); } finally { process.stdout.write = origWrite; }
  return buf;
}

{
  // Default mode (no --estimate). Whether session JSONLs exist or not, the
  // header always renders; we check rename + fence visibility there.
  const out = captureStdout(() => audit.billingReport("7d", { estimate: false }));
  t("billingReport default: 'BILLING RECONCILIATION' is gone",
    !/BILLING RECONCILIATION/.test(out));
  t("billingReport default: 'billing (advisory estimate)' header present",
    /billing \(advisory estimate\)/.test(out));
  t("billingReport default: hint to pass --estimate present",
    /pass --estimate/.test(out));
  t("billingReport default: ADVISORY_ESTIMATE_BANNER NOT present",
    !out.includes("Estimate only:"));
}
{
  // --estimate mode: banner appears; header rename still in effect.
  const out = captureStdout(() => audit.billingReport("7d", { estimate: true }));
  t("billingReport --estimate: ADVISORY_ESTIMATE_BANNER present",
    out.includes("Estimate only:"));
  t("billingReport --estimate: banner mentions cost-report",
    /entient-spend cost-report/.test(out));
  t("billingReport --estimate: still no 'BILLING RECONCILIATION'",
    !/BILLING RECONCILIATION/.test(out));
  t("billingReport --estimate: header still 'billing (advisory estimate)'",
    /billing \(advisory estimate\)/.test(out));
}

// ── 5. Repo-wide: 'BILLING RECONCILIATION' literal is gone ───────────────────
{
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("./audit.js"), "utf8");
  t("audit.js source no longer contains 'BILLING RECONCILIATION'",
    !src.includes("BILLING RECONCILIATION"));
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
